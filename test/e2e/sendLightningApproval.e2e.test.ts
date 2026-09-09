/**
 * E2E — the large-swap approval gate on `arkade:BTC->lightning:BTC`, against a
 * live regtest stack and REAL LIGHTNING. The only leg on which the gate runs:
 * every other group leaves `APPROVAL_THRESHOLD_SATS` unset. The threshold is set
 * HERE, per service, never in the `.env.ci-e2e` shared by all seven groups.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { AdminStore, type SwapApprovalRequest } from '@arkade-os/solver-app/admin/db.js'
import { approvalGateFor } from '@arkade-os/solver-app/ops/approvals.js'
import { LN_SEND } from '@arkade-os/solver-corridors/corridors/lnSend.js'
import { SwapStore, type SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { GiveUp, poll } from '@arkade-os/solver-core/util/poll.js'
import { counterpartyInvoice, counterpartyInvoiceState } from './support/counterparty.js'
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

/**
 * Straddling the swap by ONE SAT is what pins `evaluateApproval`'s `>=`: at
 * `AMOUNT_SATS` the swap is gated, at `AMOUNT_SATS + 1` it is not.
 */
const GATING_THRESHOLD = AMOUNT_SATS
const PERMISSIVE_THRESHOLD = AMOUNT_SATS + 1

const HOLD_CONFIRM_TICKS = 5

const TERMINAL = new Set(['claimed', 'refused', 'stuck'])

let arkade: E2eArkade
let store: SwapStore
let ln: Awaited<ReturnType<typeof openSolverLightning>>
let arkadeOps: ArkadeOps
let storeDir: string
let adminSeq = 0

interface GatedStack {
  service: SendSwapService
  admin: AdminStore
  held: SwapApprovalRequest[]
}

/** A send service carrying a REAL gate, wired the way `services.ts:741` wires the shipped one. */
const gatedStack = async (thresholdSats: number): Promise<GatedStack> => {
  const admin = await AdminStore.open(`${storeDir}/admin-${(adminSeq += 1)}.sqlite`)
  const held: SwapApprovalRequest[] = []
  const service = new SendSwapService({
    store,
    ln,
    arkade: arkadeOps,
    limits: arkade.limits,
    invoicePrefix: arkade.profile.invoicePrefix,
    maxExposedSats: arkade.maxExposedSats,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    approvalGate: approvalGateFor({
      thresholdSats,
      corridor: LN_SEND.pair,
      store: admin,
      onHeld: (request) => held.push(request),
    }),
  })
  return { service, admin, held }
}

const awaitFunding = (pkScript: string, expected: number): Promise<unknown> =>
  poll(
    async () => {
      const outputs = await arkadeOps.findLockups(pkScript)
      return outputs.reduce((sum, o) => sum + o.value, 0) === expected ? outputs : null
    },
    {
      attempts: 60,
      intervalMs: 2000,
      whenExhausted: `${expected} sats never appeared at ${pkScript} — the funding did not reach the indexer`,
    },
  )

const driveToTerminal = (service: SendSwapService, id: string): Promise<SendSwapRow> =>
  poll(
    async () => {
      const row = await service.tick(id)
      return TERMINAL.has(row.state) ? row : null
    },
    { attempts: 150, intervalMs: 2000, whenExhausted: `swap ${id} never reached a terminal state` },
  )

/**
 * Polls the approval row, NOT the swap state: the row sits in `funded` both
 * before and after the gate holds, so a wait on `funded` starts already true.
 */
const driveUntilHeld = ({ service, admin }: GatedStack, id: string): Promise<SwapApprovalRequest[]> =>
  poll(
    async () => {
      const row = await service.tick(id)
      // GiveUp, not Error: `poll` retries a plain throw and would hide this.
      if (TERMINAL.has(row.state)) throw new GiveUp(`swap ${id} reached ${row.state} instead of being held`)
      const pending = await admin.listPendingApprovals()
      return pending.length > 0 ? pending : null
    },
    { attempts: 60, intervalMs: 2000, whenExhausted: `swap ${id} was never recorded as awaiting approval` },
  )

const quoteAndFund = async (service: SendSwapService, amountSats: number) => {
  await assertArkadeSpendable(arkade, amountSats)
  const { invoice, paymentHash } = await counterpartyInvoice(amountSats)
  const refundAddress = await arkade.ctx.wallet.getAddress()
  const outcome = await service.quote(invoice, refundAddress, { clientRefundPubkey: CLIENT_REFUND_PUBKEY })
  if (!outcome.accepted) throw new Error(`solver refused the quote: ${outcome.reason}`)
  const swap = outcome.swap
  await arkade.ctx.wallet.send({ address: swap.lockupAddress, amount: decodeInvoice(invoice).amountSats })
  await awaitFunding(swap.pkScript, amountSats)
  return { swap, paymentHash }
}

describe('e2e arkade:BTC->lightning:BTC approval gate', () => {
  beforeAll(async () => {
    await requireStack('arkade:BTC->lightning:BTC', ['arkd', 'emulator', 'lnd', 'ln-counterparty'])
    arkade = await openArkade()
    storeDir = tempStoreDir()
    store = await SwapStore.open(`${storeDir}/swaps.sqlite`)
    ln = await openSolverLightning()
    arkadeOps = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    await ln?.close()
    arkade?.close()
  })

  it(
    'holds a swap AT the threshold with the sats unpaid, then pays it once approved',
    async () => {
      const stack = await gatedStack(GATING_THRESHOLD)
      expect(await stack.admin.listPendingApprovals()).toEqual([])

      const { swap, paymentHash } = await quoteAndFund(stack.service, AMOUNT_SATS)
      const pending = await driveUntilHeld(stack, swap.id)

      const expected = [{ swapId: swap.id, corridor: LN_SEND.pair, amountSats: AMOUNT_SATS }]
      expect(pending.map(({ swapId, corridor, amountSats }) => ({ swapId, corridor, amountSats }))).toEqual(expected)
      expect(stack.held).toEqual(expected)

      // Numeric, not a substring — a partial payment must not read as zero.
      const beforeApproval = await counterpartyInvoiceState(paymentHash)
      expect(beforeApproval.state).toBe('OPEN')
      expect(beforeApproval.settled).toBe(false)
      expect(Number(beforeApproval.amt_paid_sat)).toBe(0)

      for (let i = 0; i < HOLD_CONFIRM_TICKS; i++) {
        expect((await stack.service.tick(swap.id)).state).toBe('funded')
      }
      expect(await stack.admin.listPendingApprovals()).toHaveLength(1)
      expect(Number((await counterpartyInvoiceState(paymentHash)).amt_paid_sat)).toBe(0)

      // Completion here is what makes the hold attributable to the GATE rather
      // than to some unrelated stall: the same swap pays once approval lands.
      expect(await stack.admin.approveSwap(swap.id)).toBe(true)
      const row = await driveToTerminal(stack.service, swap.id)
      expect(row.state).toBe('claimed')
      expect(row.claimArkTxid).toBeTruthy()

      const paid = await counterpartyInvoiceState(paymentHash)
      expect(paid.state).toBe('SETTLED')
      expect(Number(paid.amt_paid_sat)).toBe(AMOUNT_SATS)
      expect(row.preimage).toBe(paid.r_preimage)
      expect(await stack.admin.listPendingApprovals()).toEqual([])
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'pays a swap ONE SAT below the threshold without holding it or recording anything',
    async () => {
      const stack = await gatedStack(PERMISSIVE_THRESHOLD)
      expect(await stack.admin.listPendingApprovals()).toEqual([])

      const { swap, paymentHash } = await quoteAndFund(stack.service, AMOUNT_SATS)
      const row = await driveToTerminal(stack.service, swap.id)
      expect(row.state).toBe('claimed')

      const paid = await counterpartyInvoiceState(paymentHash)
      expect(paid.state).toBe('SETTLED')
      expect(Number(paid.amt_paid_sat)).toBe(AMOUNT_SATS)
      expect(row.preimage).toBe(paid.r_preimage)

      // No row and no notification — a gate that held everything would fail here.
      expect(await stack.admin.listPendingApprovals()).toEqual([])
      expect(stack.held).toEqual([])
    },
    SWAP_TIMEOUT_MS,
  )
})
