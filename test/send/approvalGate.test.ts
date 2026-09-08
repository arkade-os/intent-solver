// The gate sits immediately before the CAS into `paying`, the last line before
// `payInvoice`, so these assert on `payCalls` — the only proof money moved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { SendSwapService, type ArkadeOps } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { APPROVAL_REFUSAL, type ApprovalCheck, type ApprovalVerdict } from '@arkade-os/solver-core/core/approvalGate.js'
import type { PayInvoiceParams, PaymentResult } from '@arkade-os/solver-core/ports/lightning.js'

const AMOUNT = 2100
const INVOICE_TIMESTAMP = 1_734_606_755
const EXPIRY = 6 * 3600
const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const key = (fill: number): string => hex.encode(keyBytes(fill))

const FORGED = forgeInvoiceWithPreimage({
  network: 'bc',
  amountSats: AMOUNT,
  timestamp: INVOICE_TIMESTAMP,
  expirySeconds: EXPIRY,
})

const REFUND_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(5),
  server: keyBytes(3),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 4096,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(9),
    receiverPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(13)]),
    senderPkScript: Uint8Array.from([0x51, 0x20, ...keyBytes(5)]),
  },
})
  .address('ark', keyBytes(3))
  .encode()

let clock: number
let store: SwapStore
let payCalls: PayInvoiceParams[]
let asked: { swapId: string; amountSats: number }[]

const fakeLn = () => ({
  payInvoice: async (params: PayInvoiceParams): Promise<PaymentResult> => {
    payCalls.push(params)
    return { id: 'pay-1', status: 'pending' as const }
  },
  getPayment: async (): Promise<PaymentResult> => ({ id: 'pay-1', status: 'pending' }),
  routeCltvBudgetBlocks: 200,
  enforcesRouteCltv: true,
  getSendHtlcState: async () => null,
  getOwnInvoiceState: async () => null,
  walletFingerprint: async () => 'w',
})

const fakeArkade = () =>
  ({
    providerPubkey: key(1),
    serverPubkey: key(3),
    emulatorPubkey: key(9),
    receiverPkScript: hex.encode(Uint8Array.from([0x51, 0x20, ...keyBytes(1)])),
    delays: { unilateralClaimDelay: 4096, unilateralRefundDelay: 4608, unilateralRefundWithoutReceiverDelay: 5120 },
    hrp: 'ark',
    findLockups: async () => [{ txid: 'f'.repeat(64), vout: 0, value: AMOUNT }],
    lockupProvablySpent: async () => false,
    claim: async () => 'claim-txid',
    refund: async () => 'refund-txid',
  }) as unknown as ArkadeOps

const serviceWith = (approvalGate?: ApprovalCheck) =>
  new SendSwapService({
    store,
    ln: fakeLn() as never,
    arkade: fakeArkade(),
    limits: { minSats: 500, maxSats: 10_000 },
    invoicePrefix: 'bc',
    maxExposedSats: 50_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    approvalGate,
    now: () => clock,
  })

beforeEach(async () => {
  clock = INVOICE_TIMESTAMP + 100
  store = await SwapStore.open(':memory:', () => clock)
  payCalls = []
  asked = []
})
afterEach(() => store.close())

const fundedSwap = async (service: SendSwapService): Promise<string> => {
  const outcome = await service.quote(FORGED.invoice, REFUND_ADDRESS, { clientRefundPubkey: key(11) })
  if (!outcome.accepted) throw new Error(`fixture quote refused: ${outcome.reason}`)
  return outcome.swap.id
}

const holds: ApprovalVerdict = { proceed: false, reason: APPROVAL_REFUSAL }
const recording =
  (verdict: () => ApprovalVerdict): ApprovalCheck =>
  async (swap) => {
    asked.push(swap)
    return verdict()
  }

describe('the approval gate on arkade:BTC->lightning:BTC', () => {
  it('pays exactly as before when no gate is wired', async () => {
    const service = serviceWith()
    const row = await service.tick(await fundedSwap(service))
    expect(payCalls).toHaveLength(1)
    expect(row.state).not.toBe('funded')
  })

  it('DOES NOT PAY while the gate holds, and leaves the row funded', async () => {
    const service = serviceWith(async () => holds)
    const row = await service.tick(await fundedSwap(service))
    expect(payCalls).toHaveLength(0)
    expect(row.state).toBe('funded')
  })

  it('pays once the gate proceeds — a hold is not terminal', async () => {
    let verdict: ApprovalVerdict = holds
    const service = serviceWith(recording(() => verdict))
    const id = await fundedSwap(service)
    expect((await service.tick(id)).state).toBe('funded')
    verdict = { proceed: true }
    expect((await service.tick(id)).state).not.toBe('funded')
    expect(payCalls).toHaveLength(1)
  })

  it('asks about the LOCKUP amount and the row id', async () => {
    const service = serviceWith(recording(() => holds))
    const id = await fundedSwap(service)
    await service.tick(id)
    expect(asked).toEqual([{ swapId: id, amountSats: AMOUNT }])
  })

  // The gate sits AFTER the payment decision, so a lapsed hold refuses rather
  // than waiting forever.
  it('a held swap still self-expires into refused when the invoice lapses', async () => {
    const service = serviceWith(async () => holds)
    const id = await fundedSwap(service)
    expect((await service.tick(id)).state).toBe('funded')
    clock = INVOICE_TIMESTAMP + EXPIRY + 1
    const row = await service.tick(id)
    expect(row.state).toBe('refused')
    expect(payCalls).toHaveLength(0)
  })

  // A gate consulted once would let a restart wave a held swap through.
  it('re-asks on every tick rather than caching the first answer', async () => {
    const service = serviceWith(recording(() => holds))
    const id = await fundedSwap(service)
    await service.tick(id)
    await service.tick(id)
    expect(asked).toHaveLength(2)
  })

  // `whenPaying` recovers a row whose sats may ALREADY be committed, so gating it
  // would strand committed money behind a human.
  it('does NOT gate the recovery path for a row already in paying', async () => {
    const service = serviceWith(recording(() => holds))
    const id = await fundedSwap(service)
    await store.transition(id, 'quoted', 'funded', {})
    // `submitPayment` refuses to pay without an idempotency key.
    await store.transition(id, 'funded', 'paying', {
      pay_attempted_at: clock,
      idempotency_key: `swap-${(await store.get(id)).paymentHash}`,
    })
    asked.length = 0
    await service.tick(id)
    expect(asked).toEqual([])
    expect(payCalls).toHaveLength(1)
  })
})
