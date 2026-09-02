/**
 * covclaimd claims the receive-leg lockup on its own, with the client offline.
 *
 * The sibling `receiveLightning.e2e.test.ts` deliberately runs WITHOUT
 * covclaimd, because when it was written covclaimd could not claim this
 * covenant at all: it accepted a reveal and silently never pushed anything.
 * Two things fixed that — the VHTLC taptree is now set on the funding output
 * (`matchOutput` gates on `po.TaprootTapTree` and returned false with no log at
 * any level without it), and the claim packet now commits covclaimd's own
 * pubkey so the daemon can select these transactions.
 *
 * So this file asserts the thing that file cannot: nobody in this test ever
 * claims. The client's preimage never leaves the test's memory, `clientClaim`
 * is never called, and the lockup is still spent — which only covclaimd can
 * have done. The solver then reads `P` back off that claim and settles a real
 * held HTLC with it.
 *
 * Attributing the claim to covclaimd rather than to luck took a control, because
 * the daemon logs NOTHING for request handling — even a 400 leaves no line — so
 * a silent log is not evidence either way. The control: seal the packet to a key
 * covclaimd does not hold, change nothing else. It then fails the reveal outright
 *
 *   covclaimd reveal failed: 400 ... decrypt preimage: aead open:
 *   cipher: message authentication failed
 *
 * and the swap never even reaches `funded`. So the daemon really is opening the
 * packet, and since nothing in this file ever claims, the spend that this test
 * reads `P` off is covclaimd's. Re-run that control if this test ever starts
 * passing for suspicious reasons.
 *
 * Requires the `covclaimd` profile to be up and reachable at COVCLAIMD_URL.
 * Run: `pnpm test:e2e covclaimdClaim`
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { hex } from '@scure/base'
import { ReceiveSwapStore, type ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { createCovclaimdClient, type CovclaimdClient } from '@arkade-os/solver-corridors/receive/covclaimd.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import {
  counterpartyPayment,
  payFromCounterparty,
  solverInvoice,
  type CounterpartyPayment,
} from './support/counterparty.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openSolverLightning,
  SETUP_TIMEOUT_MS,
  SWAP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)
const COVCLAIMD_URL = process.env.COVCLAIMD_URL ?? 'http://localhost:7271'

const TERMINAL = new Set(['refused', 'stuck'])

let arkade: E2eArkade
let store: ReceiveSwapStore
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let arkadeOps: Awaited<ReturnType<typeof receiveArkadeOpsFromContext>>
let covclaimd: CovclaimdClient
let dir: string
const payers: CounterpartyPayment[] = []

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

const awaitHeld = (paymentHash: string) =>
  poll(
    async () => {
      const invoice = await solverInvoice(paymentHash)
      return invoice.state === 'ACCEPTED' ? invoice : null
    },
    { attempts: 60, intervalMs: 1000, whenExhausted: `htlc for ${paymentHash} never reached ACCEPTED` },
  )

describe('e2e covclaimd claims the receive lockup non-interactively', () => {
  beforeAll(async () => {
    await requireStack('covclaimd claim', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    dir = tempStoreDir()
    store = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
    ln = await openSolverLightning()
    arkadeOps = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
    covclaimd = createCovclaimdClient(COVCLAIMD_URL)
    // Fail here, loudly, rather than deep in a swap: without covclaimd this
    // test proves nothing, and its whole point is that nobody else claims.
    const keys = await covclaimd.getPubKeys()
    if (!keys.covclaimdPubKey) throw new Error(`covclaimd at ${COVCLAIMD_URL} returned no pubkey`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    for (const payer of payers) payer.stop()
    await store?.close()
  })

  it(
    'claims with the client offline, and the solver settles on the P it read back',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS)

      const service = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store,
        ln,
        arkade: arkadeOps,
        covclaimd,
        limits: arkade.limits,
        maxExposedSats: arkade.maxExposedSats,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
      })

      // Sealed to covclaimd's REAL key, which is what makes the daemon able to
      // open it. Every other test in this suite seals to a throwaway key.
      const { covclaimdPubKey } = await covclaimd.getPubKeys()
      const sealed = newSealedPreimage(covclaimdPubKey)

      const outcome = await service.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress: await arkade.ctx.wallet.getAddress(),
        payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
        claimPacket: sealed.packet,
      })
      if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
      const swap = outcome.swap

      // A real second node pays, and its HTLC is genuinely held.
      const payer = payFromCounterparty(swap.invoice)
      payers.push(payer)
      const held = await awaitHeld(sealed.paymentHash)
      expect(held.settled).toBe(false)
      expect(held.r_preimage).toBe('')

      // The solver funds its lockup and hands covclaimd the sealed packet.
      const funded = await driveUntil(service, swap.id, new Set(['funded', ...TERMINAL]))
      expect(funded.state).toBe('funded')
      expect(funded.arkadeLockupTxid).toBeTruthy()
      // The reveal is the handoff. Without it covclaimd has nothing to open.
      expect(funded.revealedAt).not.toBeNull()

      // NOTHING HERE CLAIMS. `sealed.preimage` stays in this process, and
      // `clientClaimLockup` — which the sibling suite calls at exactly this
      // point — is not even imported. The only actor left is covclaimd.
      const settled = await driveUntil(service, swap.id, new Set(['settled', ...TERMINAL]))
      expect(settled.state).toBe('settled')

      // The P the solver recovered off covclaimd's claim witness is the P the
      // client generated and never disclosed.
      expect(settled.preimage).toBe(hex.encode(sealed.preimage))

      // And the money actually moved: the solver's node settled the held HTLC
      // with that P, and the paying node agrees the sats left it.
      const collected = await solverInvoice(sealed.paymentHash)
      expect(collected.state).toBe('SETTLED')
      expect(collected.r_preimage).toBe(hex.encode(sealed.preimage))

      const payment = await poll(
        async () => {
          const view = await counterpartyPayment(sealed.paymentHash)
          return view?.status === 'SUCCEEDED' ? view : null
        },
        { attempts: 60, intervalMs: 1000, whenExhausted: 'counterparty payment never SUCCEEDED' },
      )
      expect(payment.payment_preimage).toBe(hex.encode(sealed.preimage))
      expect(Number(payment.value_sat)).toBe(AMOUNT_SATS)
    },
    SWAP_TIMEOUT_MS,
  )
})
