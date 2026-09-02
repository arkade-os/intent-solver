/**
 * E2E — `lightning:BTC->arkade:BTC` (receive), everything the happy path and
 * the plain refund are not.
 *
 * `receiveLightning.e2e.test.ts` covers the two ends of this corridor: the
 * client claims and the solver settles, or nobody claims and the solver takes
 * its own capital back. This file covers the middle — the gates that stop a
 * swap being funded at all, the race between a late claim and a refund already
 * under way, what covclaimd actually does when handed a reveal, and whether a
 * funded swap survives the process that funded it.
 *
 * THE ONE THING TO KNOW ABOUT THIS CORRIDOR. The solver funds the lockup out
 * of its OWN balance before it has been paid anything, so every refusal here
 * is a refusal to put the solver's money at risk, and every one of them fires
 * BEFORE `armed -> funded`. That is why most of the tests below cost nothing:
 * the state they assert is reached without a single sat moving. The two that
 * do move money (the late-claim race and the covclaimd reveal) both end with
 * the lockup claimed rather than refunded — by the client in the first, by
 * covclaimd in the second — and the solver paid on the Lightning side either
 * way. Who claims is the difference between them, not whether the solver is
 * made whole.
 *
 * WHY `refund_deadline_too_late` IS TESTED HERE BY NAME. `refund_locktime` is
 * fixed at quote time and the covenant — and therefore `pkScript` — is built
 * from it. `evaluateReceiveFunding` CHECKS that committed value against the
 * arriving HTLC's `E` rather than recomputing it, and the difference is not
 * academic: recomputing it is what made the funded script un-rederivable, so
 * neither the client's claim nor the solver's own refund could spend the
 * lockup. This test pins the check-don't-recompute behaviour against a live
 * stack, where a regression shows up as a refusal rather than as stranded
 * capital.
 *
 * PREREQUISITES — as `receiveLightning.e2e.test.ts`: arkd, emulator, and an
 * Arkade wallet funded AND SETTLED (the SOLVER funds the lockup here). ONE
 * test additionally needs covclaimd, and says so in its own `requireStack`.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { HOUR, MINUTE } from '@arkade-os/solver-core/core/timelocks.js'
import { ReceiveSwapStore, type ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import type { CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { clientClaimLockup } from './support/clientClaim.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openCovclaimd,
  openFakeLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)

/** A comfortable `E`, as the happy path uses: past MIN_SETTLE_WINDOW and clear of every margin. */
const HTLC_EXPIRY_AHEAD = 6 * HOUR

let arkade: E2eArkade
let store: ReceiveSwapStore
let ln: ReturnType<typeof openFakeLightning>
let arkadeOps: Awaited<ReturnType<typeof receiveArkadeOpsFromContext>>
let dir: string

const serviceWith = (covclaimd: CovclaimdClient | null, now?: () => number): ReceiveSwapService =>
  new ReceiveSwapService({
    acceptUnilateralGap: false,
    store,
    ln,
    arkade: arkadeOps,
    covclaimd,
    limits: arkade.limits,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    ...(now ? { now } : {}),
  })

/** A sealed packet nobody can open — the right shape for every path where no covclaimd ever decrypts it. */
const sealedToNobody = () =>
  newSealedPreimage(hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)))

/** The client's side of a quote request, filled in from this wallet playing both roles. */
const clientRequest = async (paymentHash: string, amountSats = AMOUNT_SATS, claimPacket = '') => ({
  paymentHash,
  amountSats,
  payoutAddress: await arkade.ctx.wallet.getAddress(),
  payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
  claimPacket,
})

describe('e2e lightning:BTC->arkade:BTC (receive) — funding gates, races and recovery', () => {
  beforeAll(async () => {
    await requireStack('lightning:BTC->arkade:BTC edges', ['arkd', 'emulator'])
    arkade = await openArkade()
    dir = tempStoreDir()
    store = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
    ln = openFakeLightning(dir, arkade.network)
    arkadeOps = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    arkade?.close()
  })

  it('refuses a second live quote for the same payment hash', async () => {
    const sealed = sealedToNobody()
    const service = serviceWith(null)

    const first = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
    expect(first.accepted).toBe(true)

    const second = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
    expect(second).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses an amount below the network minimum', async () => {
    const sealed = sealedToNobody()
    const outcome = await serviceWith(null).quote(
      await clientRequest(sealed.paymentHash, arkade.limits.minSats - 1, sealed.packet),
    )
    expect(outcome).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses a payout address that is not an Arkade address on this network', async () => {
    const sealed = sealedToNobody()
    const outcome = await serviceWith(null).quote({
      ...(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet)),
      payoutAddress: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    })
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_payout_address' })
  })

  it('fails a quote whose hold invoice lapses before any HTLC arrives, with nothing at risk', async () => {
    const sealed = sealedToNobody()
    const outcome = await serviceWith(null).quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)

    // Nobody pays. Past the hold invoice's own validity the quote is closed out
    // rather than left open forever — and because nothing ever armed, the
    // solver has funded nothing and this is a refusal, not an incident.
    const row = await serviceWith(null, () => outcome.swap.invoiceExpiresAt + MINUTE).tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('invoice expired before it was ever armed')
    expect(row.arkadeLockupTxid).toBeNull()
  })

  it('refuses to fund when the arriving HTLC leaves too little time to settle', async () => {
    const sealed = sealedToNobody()
    const service = serviceWith(null)
    const outcome = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)

    // An HTLC that expires in half an hour: under MIN_SETTLE_WINDOW (90m), so
    // funding it would put the solver's capital behind a deadline it cannot
    // reliably beat.
    ln.armHold(sealed.paymentHash, nowSeconds() + 30 * MINUTE)

    const row = await service.tick(outcome.swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('refused to fund: settle_window_too_short')
    expect(row.arkadeLockupTxid).toBeNull()
  })

  it('refuses to fund when the committed refund deadline lands too close to the HTLC expiry', async () => {
    const sealed = sealedToNobody()
    const service = serviceWith(null)
    const outcome = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
    if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
    const swap = outcome.swap

    // `E` is placed RELATIVE TO THE ROW's own committed deadline, so the two
    // gates in `evaluateReceiveFunding` are hit one at a time: the settle
    // window stays comfortably over 90m (E is ~2h05m out), while
    // `refund_locktime` lands inside SETTLE_SAFETY_MARGIN of E and only the
    // second gate fires. That is what makes the failure reason below specific
    // rather than incidental — and it pins the gate to the value the covenant
    // was actually built from, which is the field the `pkScript` derives from
    // and therefore the one that must never move after the quote.
    ln.armHold(sealed.paymentHash, swap.refundLocktime + 5 * MINUTE)

    const row = await service.tick(swap.id)
    expect(row.state).toBe('refused')
    expect(row.failureReason).toBe('refused to fund: refund_deadline_too_late')
    expect(row.arkadeLockupTxid).toBeNull()
  })

  it(
    'adopts a claim that lands while the refund is already under way, instead of refunding over it',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const sealed = sealedToNobody()
      const service = serviceWith(null)

      const outcome = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      ln.armHold(sealed.paymentHash, nowSeconds() + HTLC_EXPIRY_AHEAD)

      const funded = await driveUntil(service, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')

      // Park the row in `refunding` through the orchestrator's OWN legal edge,
      // which is what a tick past `refund_locktime` would have done a moment
      // ago. Driving there by clock instead would not reproduce the race: the
      // funded->refunding transition and the refund push happen inside ONE
      // `tick`, so there is no instant in a real tick at which a test could
      // interleave a claim. This is the state the race starts from.
      expect(await store.transition(swap.id, 'funded', 'refunding', {})).toBe(true)

      // THE RACE. The client claims after the solver has committed to refunding
      // but before it has pushed anything. Without the recheck in
      // `whenRefunding` this becomes a refund broadcast that can only lose,
      // leaving the swap unable to settle a hold it has already been paid for.
      const claimTxid = await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: funded.payoutPubkey,
          payoutAddress: funded.payoutAddress,
          payoutPkScript: funded.payoutPkScript,
          solverPubkey: funded.solverPubkey,
          solverRefundPkScript: funded.solverRefundPkScript,
          serverPubkey: funded.serverPubkey,
          emulatorPubkey: funded.emulatorPubkey,
          paymentHash: funded.paymentHash,
          refundLocktime: funded.refundLocktime,
          claimDelay: funded.claimDelay,
          refundDelay: funded.refundDelay,
          refundWithoutReceiverDelay: funded.refundWithoutReceiverDelay,
          pkScript: funded.pkScript,
          nonInteractiveParameters: funded.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      )
      expect(claimTxid).toBeTruthy()

      const settled = await driveUntil(service, swap.id, new Set(['settled', 'refunded', ...TERMINAL]))
      // Surfaced BEFORE the state assertion so a failure prints WHY rather than
      // just `expected 'stuck' to be 'settled'`. The reason this swap can reach
      // is `whenRefunding`'s "lockup empty during refunding with no matching
      // claim found", which is the indexer-lag race: `findLockups` sees the
      // output gone the moment the claim lands, while `findClaimPreimage` needs
      // the SPENDING transaction to become readable and gets there a beat
      // later. `whenFunded` tolerates exactly that lag by design and keeps
      // waiting; `whenRefunding` does not, and fails from an EXPOSED state,
      // which means `stuck` — terminal, with no edge back and no automatic
      // retry, on a swap that in fact completed correctly.
      expect(
        settled.failureReason,
        'the late claim was not adopted — see the note above this assertion on the findLockups/findClaimPreimage race',
      ).toBeNull()
      expect(settled.state).toBe('settled')
      expect(settled.refundArkTxid).toBeNull()
      expect(settled.preimage).toBe(hex.encode(sealed.preimage))
      expect((await ln.getHoldState(sealed.paymentHash)).status).toBe('settled')
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'hands covclaimd a sealed reveal and lets it claim the lockup, with no client action at all',
    async () => {
      await requireStack('lightning:BTC->arkade:BTC covclaimd reveal', ['arkd', 'emulator', 'covclaimd'])
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      // Sealed to the REAL covclaimd's own key, read live — the daemon
      // generates its own, and a packet sealed to anything else is rejected at
      // the AEAD tag with HTTP 400. Getting a 200 below is therefore itself an
      // assertion that `support/claimPacket.ts`'s ECIES construction is right.
      const covclaimd = openCovclaimd()
      const { covclaimdPubKey } = await covclaimd.getPubKeys()
      expect(covclaimdPubKey).toBeTruthy()
      const sealed = newSealedPreimage(covclaimdPubKey)
      const service = serviceWith(covclaimd)

      const outcome = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      ln.armHold(sealed.paymentHash, nowSeconds() + HTLC_EXPIRY_AHEAD)

      const funded = await driveUntil(service, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')
      // covclaimd took the packet: HTTP 200, and the row records the reveal.
      expect(funded.revealedAt).not.toBeNull()

      // THE ACTUAL BEHAVIOUR, ASSERTED AS SUCH — and it changed. This test
      // used to assert the opposite: `covclaimd:v0.0.1-rc.1` accepted the
      // reveal and then silently never pushed a claim, because its pinned
      // `ark-lib` predated the ScriptV2 covenant redesign and could not spend
      // this script. It was written as a tripwire, with the instruction that
      // if it ever failed covclaimd had started working and the test should
      // become a claim path rather than be relaxed. `v0.0.1-rc.4` claims this
      // covenant, so this is that rewrite.
      //
      // NO CLIENT ACTION FROM HERE. That is the whole proposition of handing
      // over a sealed packet: the client may go offline the moment it is
      // delivered, and the swap still completes. The solver's watch path
      // recovers `P` from whatever spent the lockup — it does not care that it
      // was covclaimd rather than the client (`whenFunded` verifies the
      // preimage against the payment hash before trusting it).
      const settled = await driveUntil(service, swap.id, new Set(['settled', ...TERMINAL]))
      expect(settled.state).toBe('settled')
      expect(settled.preimage).toBe(hex.encode(sealed.preimage))
      // Settled with the preimage covclaimd revealed, so the solver has been
      // paid on the Lightning side for the payout it funded on the Arkade one.
      expect((await ln.getHoldState(sealed.paymentHash)).status).toBe('settled')
      // And nothing of the solver's is left sitting in the lockup.
      expect(await arkadeOps.findLockups(settled.pkScript)).toHaveLength(0)
      expect(settled.refundArkTxid).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'resumes a funded lockup from durable state alone after the store is closed and reopened',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const sealed = sealedToNobody()
      const service = serviceWith(null)

      const outcome = await service.quote(await clientRequest(sealed.paymentHash, AMOUNT_SATS, sealed.packet))
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap
      ln.armHold(sealed.paymentHash, nowSeconds() + HTLC_EXPIRY_AHEAD)

      const funded = await driveUntil(service, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')

      // THE RESTART — the solver's capital is already in the lockup and only
      // the sqlite row says so. Everything the recovered process needs to
      // rebuild the covenant (and therefore to claim OR refund) has to be on
      // that row, which is precisely the invariant a mutable `refund_locktime`
      // used to break: a row that no longer re-derives its own funded script
      // strands exactly this state.
      await store.close()
      store = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
      const rebooted = serviceWith(null)

      await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: funded.payoutPubkey,
          payoutAddress: funded.payoutAddress,
          payoutPkScript: funded.payoutPkScript,
          solverPubkey: funded.solverPubkey,
          solverRefundPkScript: funded.solverRefundPkScript,
          serverPubkey: funded.serverPubkey,
          emulatorPubkey: funded.emulatorPubkey,
          paymentHash: funded.paymentHash,
          refundLocktime: funded.refundLocktime,
          claimDelay: funded.claimDelay,
          refundDelay: funded.refundDelay,
          refundWithoutReceiverDelay: funded.refundWithoutReceiverDelay,
          pkScript: funded.pkScript,
          nonInteractiveParameters: funded.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      )

      // `tickAll` — the recovery sweep. The rebooted service is told nothing
      // about which swap to resume and has to find it from the store.
      const resumed = await poll(
        async () => {
          const rows = await rebooted.tickAll()
          const row = rows.find((r) => r.id === swap.id)
          return row && ['settled', 'refunded', ...TERMINAL].includes(row.state) ? row : null
        },
        { attempts: 150, intervalMs: 2000, whenExhausted: `receive swap ${swap.id} never recovered after the restart` },
      )
      expect(resumed.state).toBe('settled')
      expect(resumed.preimage).toBe(hex.encode(sealed.preimage))
    },
    SWAP_TIMEOUT_MS,
  )
})

const TERMINAL = ['refused', 'stuck']

const driveUntil = (service: ReceiveSwapService, id: string, until: ReadonlySet<string>): Promise<ReceiveSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    {
      attempts: 150,
      intervalMs: 2000,
      whenExhausted: `receive swap ${id} never reached one of [${[...until].join(', ')}]`,
    },
  )
