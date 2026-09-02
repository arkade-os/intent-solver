/**
 * The self-payment refresh's edges and its failure spine, against the real stack.
 *
 * `selfPayment.e2e.test.ts` walks the happy path. This file covers what the
 * happy path cannot: the quote that must be REFUSED, the swap nobody funds, the
 * htlc that arrives anyway, and — the one that actually moves money — the
 * client who takes our payout's counterpart and then never claims, leaving the
 * solver to reclaim its own capital.
 *
 * Run: `pnpm test:e2e selfPaymentEdges`
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { ReceiveSwapStore, type ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { findClaimPreimage, findLockupOutpoints } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { HOUR } from '@arkade-os/solver-core/core/timelocks.js'
import { nowSeconds, poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { payFromCounterparty, solverInvoice, type CounterpartyPayment } from './support/counterparty.js'
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

/** The RFQ family requires a client refund pubkey on every quote. */
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(11)))

const AMOUNT_SATS = Number(process.env.E2E_AMOUNT_SATS ?? 5000)

const RECEIVE_TERMINAL = new Set(['refused', 'stuck'])

let arkade: E2eArkade
let receiveStore: ReceiveSwapStore
let sendStore: SwapStore
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let receiveOps: Awaited<ReturnType<typeof receiveArkadeOpsFromContext>>
let sendOps: Awaited<ReturnType<typeof arkadeOpsFromContext>>
let dir: string
const payers: CounterpartyPayment[] = []

/** A throwaway ECIES recipient: the packet travels but nobody opens it here. */
const nobodyKey = (): string => hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))

const receiveWith = (now?: () => number): ReceiveSwapService =>
  new ReceiveSwapService({
    acceptUnilateralGap: false,
    store: receiveStore,
    ln,
    arkade: receiveOps,
    limits: arkade.limits,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => receiveStore.committedSats(),
    admission: new AdmissionControl(),
    coupledSendStore: sendStore,
    ...(now ? { now } : {}),
  })

const sendWith = (): SendSwapService =>
  new SendSwapService({
    store: sendStore,
    ln,
    arkade: sendOps,
    limits: arkade.limits,
    invoicePrefix: arkade.profile.invoicePrefix,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => sendStore.committedSats(),
    admission: new AdmissionControl(),
    coupling: {
      receiveStore,
      findLockupOutpoints: (pkScript) => findLockupOutpoints(arkade.ctx, pkScript),
      findClaimPreimage: (outpoints, hash) => findClaimPreimage(arkade.ctx, outpoints, hash),
    },
  })

const quoteReceive = async (service: ReceiveSwapService) => {
  const sealed = newSealedPreimage(nobodyKey())
  const outcome = await service.quote({
    paymentHash: sealed.paymentHash,
    amountSats: AMOUNT_SATS,
    payoutAddress: await arkade.ctx.wallet.getAddress(),
    payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
    claimPacket: sealed.packet,
  })
  if (!outcome.accepted) throw new Error(`receive quote refused: ${outcome.reason}`)
  return { sealed, swap: outcome.swap }
}

const driveReceive = (service: ReceiveSwapService, id: string, until: ReadonlySet<string>): Promise<ReceiveSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return until.has(row.state) ? row : null
    },
    { attempts: 90, intervalMs: 2000, whenExhausted: `receive swap ${id} never reached [${[...until].join(', ')}]` },
  )

describe('e2e self-payment refresh — edges and failure spine', () => {
  beforeAll(async () => {
    await requireStack('self-payment edges', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    dir = tempStoreDir()
    receiveStore = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
    sendStore = await SwapStore.open(`${dir}/send-swaps.sqlite`)
    ln = await openSolverLightning()
    receiveOps = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
    sendOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    for (const payer of payers) payer.stop()
    await receiveStore?.close()
    sendStore?.close()
  })

  it(
    'REFUSES the coupling when the two refund deadlines are too close together',
    async () => {
      // `Dr` is fixed at the receive leg's quote clock + MAX_REFUND_HORIZON, and
      // `Ds` at the send leg's clock plus a constant derived from the invoice.
      // Quoting the receive leg far in the FUTURE pushes `Dr` past `Ds`, which
      // is the shape the invariant exists to catch: a client able to refund
      // their lockup before our recourse on the payout has opened.
      const far = () => nowSeconds() + 4 * 24 * HOUR
      const { swap } = await quoteReceive(receiveWith(far))

      const outcome = await sendWith().quote(swap.invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })

      expect(outcome.accepted).toBe(false)
      if (!outcome.accepted) expect(outcome.reason).toBe('coupled_deadline_unsafe')
      // Nothing persisted behind the refusal.
      expect(await sendStore.findByPaymentHash(swap.paymentHash)).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'pays out nothing when the client quotes both legs and funds neither',
    async () => {
      const receive = receiveWith()
      const { swap } = await quoteReceive(receive)
      const sendQuote = await sendWith().quote(swap.invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)

      // Several ticks with no lockup anywhere. The solver must stay put: it has
      // committed nothing and must not go first.
      for (let i = 0; i < 4; i += 1) {
        const row = await receive.tick(swap.id)
        expect(row.state).toBe('quoted')
        expect(row.arkadeLockupTxid).toBeNull()
      }

      // And the invoice is still live — retirement happens at coupling-and-
      // funded, not at coupling alone, precisely so a client who has committed
      // nothing can still pay it the ordinary way.
      expect((await solverInvoice(swap.paymentHash)).state).toBe('OPEN')
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'lets a REAL htlc win over the coupling when one arrives first',
    async () => {
      // The bolt11 is ours and anyone can pay it. If someone does before the
      // coupling is recognised, the ordinary armed path must take over — a row
      // funded against a send lockup while an htlc it owes a settle on is also
      // live would be paying twice on one preimage.
      const receive = receiveWith()
      const { sealed, swap } = await quoteReceive(receive)
      const sendQuote = await sendWith().quote(swap.invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)

      const payer = payFromCounterparty(swap.invoice)
      payers.push(payer)
      await poll(
        async () => {
          const invoice = await solverInvoice(sealed.paymentHash)
          return invoice.state === 'ACCEPTED' ? invoice : null
        },
        { attempts: 60, intervalMs: 1000, whenExhausted: 'htlc never armed' },
      )

      await assertArkadeSpendable(arkade, AMOUNT_SATS)
      const armed = await driveReceive(receive, swap.id, new Set(['funded', ...RECEIVE_TERMINAL]))

      expect(armed.state).toBe('funded')
      // The htlc's own deadline was recorded, which ONLY the ordinary path does.
      // A coupled arm leaves this null.
      expect(armed.htlcExpiresAt).not.toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'reclaims the solver payout when the client locks up and then never claims',
    async () => {
      await assertArkadeSpendable(arkade, AMOUNT_SATS * 3)

      // Two clocks over ONE store, the idiom the receive corridor's own refund
      // test uses. The BACKDATED service quotes and funds — from where it
      // stands the deadline is comfortably ahead — while the present-clock
      // service sees a deadline five hours gone.
      const backdated = receiveWith(() => nowSeconds() - 5 * HOUR)
      const present = receiveWith()
      const { swap } = await quoteReceive(backdated)
      expect(swap.refundLocktime).toBeLessThan(nowSeconds())

      const send = sendWith()
      const sendQuote = await send.quote(swap.invoice, await arkade.ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)
      const sendRow = sendQuote.swap

      // The client commits: their lockup lands, and the send leg confirms it.
      await arkade.ctx.wallet.send({ address: sendRow.lockupAddress, amount: sendRow.amountSats })
      await poll(
        async () => {
          const row = await send.tick(sendRow.id)
          return row.state === 'funded' ? row : null
        },
        { attempts: 60, intervalMs: 2000, whenExhausted: 'send swap never reached funded' },
      )

      // The solver pays out against that lockup...
      const funded = await driveReceive(backdated, swap.id, new Set(['funded', ...RECEIVE_TERMINAL]))
      expect(funded.state).toBe('funded')
      expect(funded.arkadeLockupTxid).toBeTruthy()

      // ...and then nobody ever claims it. On the real clock the deadline is
      // long past, so the solver takes its own capital back through the
      // emulator-co-signed covenant refund.
      const refunded = await driveReceive(present, swap.id, new Set(['refunded', ...RECEIVE_TERMINAL]))
      expect(refunded.state).toBe('refunded')
      expect(refunded.refundArkTxid).toBeTruthy()
      // It never learned P, so it never could have collected the other leg.
      expect(refunded.preimage).toBeNull()

      // The send leg is the client's to unwind: their lockup refunds to them at
      // `Ds`, which the deadline invariant guarantees is still shut here. The
      // solver has not claimed it and cannot, having never seen P.
      const stillWaiting = await send.tick(sendRow.id)
      expect(stillWaiting.state).toBe('funded')
      expect(stillWaiting.preimage).toBeNull()
      expect(sendRow.refundLocktime).toBeGreaterThan(nowSeconds())
    },
    SWAP_TIMEOUT_MS,
  )
})
