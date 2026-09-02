/**
 * A self-payment refresh, both legs, against the real stack.
 *
 * The client quotes lightning:BTC->arkade:BTC, then arkade:BTC->lightning:BTC
 * against the bolt11 it was just handed. That second quote used to be refused
 * `quote_conflict` — correctly, because paying it would mean our own node
 * paying its own invoice. Here it is recognised as a coupling instead, and the
 * whole thing is settled on Arkade with no Lightning payment at all.
 *
 * `test/coupling/selfPayment.test.ts` proves the same shape against fakes and
 * runs in `pnpm test`. This one proves it against a live arkd, a live emulator,
 * and a real held-invoice-capable LND, which is where the assumptions that
 * matter actually live: that the two legs' independently-derived deadlines
 * satisfy `Ds >= Dr + MIN_CLAIM_WINDOW` on real numbers, and that the send leg
 * can read `P` back off a real Arkade claim witness.
 *
 * Run: `pnpm test:e2e selfPayment`
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { findClaimPreimage, findLockupOutpoints } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { newSealedPreimage } from './support/claimPacket.js'
import { clientClaimLockup } from './support/clientClaim.js'
import { solverInvoice } from './support/counterparty.js'
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

const SEND_TERMINAL = new Set(['claimed', 'refused', 'stuck'])

let arkade: E2eArkade
let receiveStore: ReceiveSwapStore
let sendStore: SwapStore
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let receiveOps: Awaited<ReturnType<typeof receiveArkadeOpsFromContext>>
let sendOps: Awaited<ReturnType<typeof arkadeOpsFromContext>>
let dir: string
/** Every payInvoice this test's send leg attempted. Must stay empty. */
let payAttempts: number

describe('e2e self-payment refresh (lightning:BTC->arkade:BTC coupled to arkade:BTC->lightning:BTC)', () => {
  beforeAll(async () => {
    await requireStack('self-payment refresh', ['arkd', 'emulator', 'lnd'])
    arkade = await openArkade()
    dir = tempStoreDir()
    receiveStore = await ReceiveSwapStore.open(`${dir}/receive-swaps.sqlite`)
    sendStore = await SwapStore.open(`${dir}/send-swaps.sqlite`)
    ln = await openSolverLightning()
    receiveOps = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
    sendOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await receiveStore?.close()
    sendStore?.close()
  })

  it(
    'couples the two quotes, pays out only after the client locks up, and collects on their claim',
    async () => {
      // Both legs move real sats out of the same wallet: the client's lockup and
      // the solver's payout.
      await assertArkadeSpendable(arkade, AMOUNT_SATS * 3)

      payAttempts = 0
      // Wrapped so "no Lightning payment ever happens" is an assertion that can
      // fail, not a claim about the design.
      // Spelled out rather than spread: the adapter's methods live on its
      // prototype, so a spread would drop them.
      const countingLn = {
        routeCltvBudgetBlocks: ln.routeCltvBudgetBlocks,
        enforcesRouteCltv: ln.enforcesRouteCltv,
        payInvoice: async (...args: Parameters<typeof ln.payInvoice>) => {
          payAttempts += 1
          return ln.payInvoice(...args)
        },
        getPayment: (id: string) => ln.getPayment(id),
        getOwnInvoiceState: ln.getOwnInvoiceState ? (h: string) => ln.getOwnInvoiceState!(h) : undefined,
      }

      const receive = new ReceiveSwapService({
        acceptUnilateralGap: false,
        store: receiveStore,
        ln,
        arkade: receiveOps,
        limits: arkade.limits,
        maxExposedSats: arkade.maxExposedSats,
        totalCommitted: () => receiveStore.committedSats(),
        admission: new AdmissionControl(),
        // Wired exactly as `createServices` wires it when both Lightning
        // corridors are enabled.
        coupledSendStore: sendStore,
      })

      const send = new SendSwapService({
        store: sendStore,
        ln: countingLn,
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

      // 1. The client quotes the receive corridor and gets OUR bolt11.
      // No covclaimd on this run: the CLIENT claims, which keeps step 7
      // deterministic instead of racing a daemon. The packet still travels, so
      // it is sealed to a throwaway key nobody here holds.
      const nobody = hex.encode(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true))
      const sealed = newSealedPreimage(nobody)
      const payoutAddress = await arkade.ctx.wallet.getAddress()
      const receiveQuote = await receive.quote({
        paymentHash: sealed.paymentHash,
        amountSats: AMOUNT_SATS,
        payoutAddress,
        payoutPubkey: hex.encode(await arkade.ctx.identity.xOnlyPublicKey()),
        claimPacket: sealed.packet,
      })
      if (!receiveQuote.accepted) throw new Error(`receive quote refused: ${receiveQuote.reason}`)
      const receiveRow = receiveQuote.swap

      // 2. THE HEADLINE: quoting the send corridor against that very invoice is
      //    accepted. Before the coupling existed this returned quote_conflict.
      const sendQuote = await send.quote(receiveRow.invoice, payoutAddress, {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!sendQuote.accepted) throw new Error(`send quote refused: ${sendQuote.reason}`)
      const sendRow = sendQuote.swap

      // The deadline invariant, on numbers both legs derived independently from
      // a real invoice and the live server's exit delays.
      expect(sendRow.refundLocktime - receiveRow.refundLocktime).toBeGreaterThanOrEqual(MIN_CLAIM_WINDOW)

      // 3. ORDERING, asserted rather than assumed: their lockup does not exist
      //    yet, so we must not pay out. Drive the receive leg and watch it hold.
      const beforeFunding = await receive.tick(receiveRow.id)
      expect(beforeFunding.state).toBe('quoted')
      expect(beforeFunding.arkadeLockupTxid).toBeNull()

      // 4. The client funds their send lockup for real.
      const fundTxid = await arkade.ctx.wallet.send({ address: sendRow.lockupAddress, amount: sendRow.amountSats })
      expect(fundTxid).toBeTruthy()
      const funded = await poll(
        async () => {
          const row = await send.tick(sendRow.id)
          return row.state === 'funded' ? row : null
        },
        { attempts: 60, intervalMs: 2000, whenExhausted: 'send swap never reached funded' },
      )
      expect(funded.state).toBe('funded')

      // 5. NOW the receive leg pays out — against their lockup, with no htlc.
      const paidOut = await poll(
        async () => {
          const row = await receive.tick(receiveRow.id)
          return row.state === 'funded' ? row : null
        },
        { attempts: 60, intervalMs: 2000, whenExhausted: 'receive swap never funded against the coupled lockup' },
      )
      expect(paidOut.arkadeLockupTxid).toBeTruthy()
      // Nothing armed this invoice, and nothing could: there is no `E`.
      expect(paidOut.htlcExpiresAt).toBeNull()

      // 6. And the invoice was retired, so nobody — including a third party the
      //    client might hand the bolt11 to — can pay it now.
      const retired = await solverInvoice(sealed.paymentHash)
      expect(retired.state).toBe('CANCELED')

      // 7. The client claims our payout, revealing P on-chain.
      const claimTxid = await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: paidOut.payoutPubkey,
          payoutAddress: paidOut.payoutAddress,
          payoutPkScript: paidOut.payoutPkScript,
          solverPubkey: paidOut.solverPubkey,
          solverRefundPkScript: paidOut.solverRefundPkScript,
          serverPubkey: paidOut.serverPubkey,
          emulatorPubkey: paidOut.emulatorPubkey,
          paymentHash: paidOut.paymentHash,
          refundLocktime: paidOut.refundLocktime,
          claimDelay: paidOut.claimDelay,
          refundDelay: paidOut.refundDelay,
          refundWithoutReceiverDelay: paidOut.refundWithoutReceiverDelay,
          pkScript: paidOut.pkScript,
          nonInteractiveParameters: paidOut.nonInteractiveParameters ?? false,
        },
        sealed.preimage,
      )
      expect(claimTxid).toBeTruthy()

      // 8. The send leg reads P back off that Arkade claim and collects. This is
      //    the seam that had never existed before: the send corridor learning a
      //    preimage from a witness rather than from a payment result.
      const collected = await poll<SendSwapRow>(
        async () => {
          const row = await send.tick(sendRow.id)
          return SEND_TERMINAL.has(row.state) ? row : null
        },
        { attempts: 90, intervalMs: 2000, whenExhausted: 'send swap never reached a terminal state' },
      )
      expect(collected.state).toBe('claimed')
      expect(collected.preimage).toBe(hex.encode(sealed.preimage))
      expect(collected.claimArkTxid).toBeTruthy()

      // 9. The receive row must finish too. Its invoice was cancelled back at
      //    coupling, so there is nothing to settle — and settling anyway threw,
      //    leaving every completed coupled swap parked in `stuck`.
      const receiveFinal = await poll(
        async () => {
          const row = await receive.tick(receiveRow.id)
          return row.state === 'settled' || row.state === 'stuck' || row.state === 'refused' ? row : null
        },
        { attempts: 60, intervalMs: 2000, whenExhausted: 'receive swap never reached a terminal state' },
      )
      expect(receiveFinal.state).toBe('settled')

      // 10. The whole reason the flow exists: one node cannot pay its own
      //     invoice, and nothing on this path ever tried to.
      expect(payAttempts).toBe(0)
    },
    SWAP_TIMEOUT_MS,
  )
})
