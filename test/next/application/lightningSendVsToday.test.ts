import { describe, expect, it } from 'vitest'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import { planSend, type SendReads } from '@arkade-os/solver-core/core/sendPlan.js'
import { rawDelaySeconds } from '@arkade-os/solver-core/core/timelocks.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { FromArkade } from '@arkade-os/solver-next/application/legs/from_arkade.js'
import { LightningSend, type SendStep, type SendTerms } from '@arkade-os/solver-next/application/lightning_send.js'
import { swapFromSendRow, type SendSwapRecord } from '@arkade-os/solver-next/infrastructure/db/send_swap_row.js'
import type { ClientLockupContract, ClientLockupOutput } from '@arkade-os/solver-next/ports/arkade.js'
import { forgeInvoiceWithPreimage } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { hex } from '@scure/base'
import { t } from '../domain/support.js'

const MINUTE = 60
const HOUR = 60 * MINUTE
const NOW = 1_800_000_000
const AMOUNT = 10_030
const STATES = ['quoted', 'funded', 'paying', 'paid', 'claiming', 'claimed', 'refused', 'stuck'] as const

const INVOICES = [9, 40, 144].map((minFinalCltvBlocks) => {
  const forged = forgeInvoiceWithPreimage({
    network: 'bcrt',
    amountSats: 10_000,
    timestamp: NOW - HOUR,
    expirySeconds: 30 * 24 * HOUR,
    minFinalCltvBlocks,
  })
  return { ...decodeInvoice(forged.invoice), preimage: hex.encode(forged.preimage) }
})

interface Situation {
  state: (typeof STATES)[number]
  invoice: (typeof INVOICES)[number]
  quotedAt: number
  invoiceExpiresAt: number
  refundOpensAt: number
  quotedRefundDeadline: number | null
  rawRefundAloneDelay: number
  outputs: ClientLockupOutput[]
  lockedSats: number | null
  adopted: { txid: string; vout: number; value: number }[] | null
  keyStillOurs: boolean
  approved: boolean
  nodeCapsTheRoute: boolean
  routeBudget: number
  batchReady: boolean
  network: string
  longestWait: number
}

// Built once and pointed at one situation at a time.
let s: Situation

// Today's pay deadline is a private method of the send service. It is called on a stand-in holding only what it reads.
const service = SendSwapService.prototype as unknown as {
  payDeadline(this: unknown, row: unknown, refundDeadline: number): Promise<number>
  availableLockups: unknown
}
const standIn = {
  deps: { arkade: { findLockups: async () => s.outputs, findSweptLockups: async () => [] }, network: '' },
  now: () => NOW,
  batchClaimReady: () => s.batchReady,
  availableLockups: service.availableLockups,
}

const rowOf = (s: Situation) => {
  const funded = !['quoted', 'refused'].includes(s.state)
  const sent = ['paying', 'paid', 'claiming', 'claimed'].includes(s.state)
  const paid = ['paid', 'claiming', 'claimed'].includes(s.state)
  return {
    id: 'swap-1',
    state: s.state,
    createdAt: s.quotedAt,
    updatedAt: NOW - 1,
    invoice: s.invoice.invoice,
    paymentHash: s.invoice.paymentHash,
    amountSats: AMOUNT,
    invoiceSats: s.invoice.amountSats,
    invoiceExpiresAt: s.invoiceExpiresAt,
    quotedRefundDeadline: s.quotedRefundDeadline,
    refundWithoutReceiverDelay: s.rawRefundAloneDelay,
    pkScript: 'pk',
    lockupTxid: funded ? 'tx0' : null,
    lockupVout: funded ? 0 : null,
    lockupValue: funded ? s.lockedSats : null,
    lockupOutpoints: funded && s.adopted !== null ? JSON.stringify(s.adopted) : null,
    payAttemptedAt: sent ? NOW - 30 : null,
    paymentId: sent ? 'pay-1' : null,
    preimage: paid ? s.invoice.preimage : null,
    claimArkTxid: s.state === 'claimed' ? 'claim' : null,
    refundArkTxid: null,
    failureReason: ['refused', 'stuck'].includes(s.state) ? 'gave up' : null,
    rfqId: null,
  } satisfies SendSwapRecord & Record<string, unknown>
}

const READS = {
  now: () => NOW,
  lockupTimeout: () => s.longestWait,
  maxLockupOutputs: () => 4,
  providerKeyCurrent: () => s.keyStillOurs,
  invoiceProbe: () => 'own',
  backendName: () => undefined,
  routeCltvBudgetBlocks: () => s.routeBudget,
  enforcesRouteCltv: () => s.nodeCapsTheRoute,
  hintDenylist: () => new Set<string>(),
  lockups: async () => ({
    held: s.outputs.reduce((sum, o) => sum + o.value, 0),
    spendable: s.outputs.filter((o) => !o.assets?.length),
  }),
  refundDeadline: async () => s.refundOpensAt,
  coupledReceive: async () => null,
  failedReceive: async () => null,
  payDeadline: (refundDeadline: number) =>
    service.payDeadline.call({ ...standIn, deps: { ...standIn.deps, network: s.network } }, rowOf(s), refundDeadline),
  approved: async () => s.approved,
} as unknown as SendReads

const contractOf = (s: Situation): ClientLockupContract => {
  const row = rowOf(s)
  return {
    id: row.id,
    pkScript: row.pkScript,
    amountSats: AMOUNT,
    lockedSats: row.lockupValue,
    adopted: row.lockupOutpoints === null ? null : s.adopted,
    refundLocktime: s.refundOpensAt,
    refundWithoutReceiverDelay: s.rawRefundAloneDelay,
  }
}
const termsOf = (s: Situation): SendTerms => ({
  quotedAt: t(s.quotedAt),
  invoiceExpiresAt: t(s.invoiceExpiresAt),
  amountSats: AMOUNT,
  lockedSats: rowOf(s).lockupValue,
  quotedRefundOpensAt: s.quotedRefundDeadline === null ? null : t(s.quotedRefundDeadline),
  blocks: {
    finalHop: s.invoice.minFinalCltvBlocks,
    worstRouteHint: s.invoice.worstRouteHintCltvBlocks,
    bestRouteHint: s.invoice.bestRouteHintCltvBlocks,
    routeBudget: s.routeBudget,
    nodeCapsTheRoute: s.nodeCapsTheRoute,
  },
  keyStillOurs: s.keyStillOurs,
})

const SEND = new LightningSend(
  new FromArkade(
    { contract: async () => contractOf(s) },
    {
      available: async () => s.outputs,
      claimsOutlastTheBatch: (contract) => s.network === 'regtest' || (s.batchReady && contract.adopted !== null),
      refundOpensAt: async () => s.refundOpensAt,
      secondsToRefundAlone: () => rawDelaySeconds(s.rawRefundAloneDelay),
    },
    () => t(NOW),
  ),
  { of: async () => termsOf(s) },
  async () => s.approved,
  () => t(NOW),
  { maxLockupOutputs: 4, longestWaitForTheLockup: 15 * MINUTE },
)

// Once the payment is started today's planner hands over to code that is not compared yet; the new model waits there.
const asToday = (step: SendStep, state: Situation['state']): Record<string, unknown> => {
  if (step.do === 'adopt') return { do: 'adopt_lockup' }
  if (step.do === 'wait' && ['paying', 'paid', 'claiming'].includes(state)) return { do: 'hand_over' }
  const { heldSats, outputs: _outputs, ...rest } = step
  return heldSats === undefined ? rest : { ...rest, lockupValue: heldSats }
}

describe('the Lightning send decision', () => {
  it('is the one production makes today, on 5,000 random rows read from the table', async () => {
    let seed = 20261128
    const next = () => (seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296) / 4_294_967_296
    const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)]!
    const reached = new Set<string>()

    for (let i = 0; i < 5_000; i++) {
      const invoice = pick(INVOICES)
      const routeBudget = pick([432, 432, 100])
      const worst = invoice.minFinalCltvBlocks + routeBudget
      const untilRefund = pick([
        90 * MINUTE,
        2 * HOUR + worst * 600,
        2 * HOUR + invoice.minFinalCltvBlocks * 600,
        400 * HOUR,
      ])
      const refundOpensAt = NOW + (next() < 0.5 ? 400 * HOUR : untilRefund + pick([-1, 0, 1, MINUTE]))
      const inFifths = next() < 0.05
      const outputs = Array.from({ length: inFifths ? 5 : pick([0, 1, 1, 1, 2, 5]) }, (_, n) => ({
        txid: `tx${n}`,
        vout: 0,
        value: inFifths ? AMOUNT / 5 : pick([AMOUNT, AMOUNT, AMOUNT, 5_000, 5_030, 1, AMOUNT + 1]),
        ...(!inFifths && next() < 0.05 ? { assets: [{}] } : {}),
        ...(next() < 0.3 ? { expiresAt: NOW + pick([HOUR, 5 * HOUR, 500 * HOUR]) } : {}),
      }))
      const taken = outputs.filter((o) => !('assets' in o)).map(({ txid, vout, value }) => ({ txid, vout, value }))
      const quotedAt = NOW - pick([0, MINUTE, 14 * MINUTE, 15 * MINUTE, 16 * MINUTE])
      const rawRefundAloneDelay = next() < 0.85 ? 4_194_304 - 512 : pick([512, 86_400 + 512])
      const aloneAfter = rawDelaySeconds(rawRefundAloneDelay)
      s = {
        state: pick([...STATES, 'quoted', 'funded', 'funded', 'funded', 'funded']),
        invoice,
        quotedAt,
        invoiceExpiresAt: NOW + pick([0, -1, 2 * MINUTE - 1, 2 * MINUTE, 20 * MINUTE, HOUR, HOUR]),
        refundOpensAt,
        // Around the moment the client could refund alone, so that which deadline is judged decides the answer.
        quotedRefundDeadline: pick([null, refundOpensAt, refundOpensAt, quotedAt + aloneAfter + pick([-1, 0, 1])]),
        rawRefundAloneDelay,
        outputs,
        lockedSats: pick([AMOUNT, AMOUNT, AMOUNT, AMOUNT, null, AMOUNT - 1]),
        adopted: next() < 0.8 && taken.length > 0 ? taken : null,
        keyStillOurs: next() < 0.95,
        approved: next() < 0.9,
        nodeCapsTheRoute: next() < 0.5,
        routeBudget,
        batchReady: next() < 0.3,
        network: pick(['regtest', 'mutinynet', 'bitcoin']),
        longestWait: 15 * MINUTE,
      }
      const row = rowOf(s)
      const old = await planSend(row as never, READS)
      const step = await SEND.next(swapFromSendRow(row))
      const ours = asToday(step, s.state)
      if (JSON.stringify(ours) !== JSON.stringify(old)) {
        throw new Error(
          `differs on ${JSON.stringify({ ...s, invoice: s.invoice.minFinalCltvBlocks })}: today ${JSON.stringify(old)}, ours ${JSON.stringify(step)}`,
        )
      }
      const spendable = outputs.filter((o) => !('assets' in o))
      if (step.do === 'adopt' && JSON.stringify(step.outputs) !== JSON.stringify(spendable)) {
        throw new Error(`row ${i} adopts ${JSON.stringify(step.outputs)}, not ${JSON.stringify(spendable)}`)
      }
      reached.add(
        step.do === 'fail'
          ? step.reason!.replace(/\d+/g, 'N')
          : `${s.state === 'quoted' || s.state === 'funded' ? s.state : 'later'}:${step.do}`,
      )
    }
    expect([...reached].sort()).toMatchInlineSnapshot(`
      [
        "funded:start_paying",
        "funded:wait",
        "invoice expired before funding completed",
        "later:wait",
        "lockup arrived after the funding deadline",
        "lockup funded in N outputs, over N",
        "lockup funded on an asset vtxo a claim cannot spend: N held, N spendable",
        "lockup timeout",
        "lockup timeout with partial N sats",
        "overfunded lockup: N > N sats",
        "provider key rotated since quote; refusing to pay an unclaimable lockup",
        "quoted:adopt",
        "quoted:wait",
        "refused to pay: claim_window_too_short",
        "refused to pay: cltv_budget_too_short",
        "refused to pay: invoice_expired",
        "refused to pay: invoice_expires_too_soon",
        "refused to pay: lockup_insufficient",
        "refused to pay: uncapped_route_deadline_too_short",
        "refused to proceed: client solo refund opens before the quoted refund",
      ]
    `)
  }, 60_000)
})
