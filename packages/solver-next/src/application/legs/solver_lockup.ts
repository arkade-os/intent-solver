import { hex } from '@scure/base'
import type { ValueOf } from '../../domain/shared/brand.js'
import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import { Preimage } from '../../domain/swap/hashlock.js'
import { Reference } from '../../domain/swap/leg.js'
import type { Swap } from '../../domain/swap/swap.js'
import type {
  ArkadeLockups,
  LockupContract,
  LockupContracts,
  LockupOutpoint,
  FundedOutput,
  Outpoint,
} from '../../ports/arkade.js'

export const LockupStatus = {
  NotFunded: 'not_funded',
  Funded: 'funded',
  Claimed: 'claimed',
  /** A unilateral exit took it onto Bitcoin. It is gone from Arkade and still ours to refund there. */
  Unrolled: 'unrolled',
  Refunded: 'refunded',
  /** Spent, with no claim readable and no refund of ours. Read lag, or something we cannot explain yet. */
  Gone: 'gone',
} as const

export type LockupStatus = ValueOf<typeof LockupStatus>

export interface Lockup {
  readonly status: LockupStatus
  readonly outpoint: Reference | null
  readonly preimage: Preimage | null
  readonly refundTx: Reference | null
}

export interface RefundTimes {
  readonly refundOpen: boolean
  readonly refundOpensAt: UnixSeconds
  readonly secondsToRefundAlone: number
}

const same =
  (wanted: Outpoint) =>
  (output: Outpoint): boolean =>
    output.txid === wanted.txid && output.vout === wanted.vout

const referenceOf = (outpoint: Outpoint): Reference => Reference.of(`${outpoint.txid}:${outpoint.vout}`)

const OUTPOINT = /^([^:]+):(0|[1-9]\d*)$/

const outpointOf = (reference: string | null): Outpoint | null => {
  if (reference === null || !reference.includes(':')) return null
  const [, txid, vout] = OUTPOINT.exec(reference) ?? []
  if (txid === undefined) throw new RuleViolated(`not an outpoint: ${reference}`)
  return { txid, vout: Number(vout) }
}

// The lockup address is public from the quote on, so anyone can pay dust to it. Only an output of exactly the
// payout is ours. A spent one is still ours: a claimed fill must be found, not sent again.
const adoptFunding = (history: readonly LockupOutpoint[], payoutSats: number): LockupOutpoint | null => {
  const exact = history.filter((output) => output.value === payoutSats)
  return exact.find((output) => !output.spent) ?? exact[0] ?? null
}

export class SolverLockup {
  constructor(
    private readonly contracts: LockupContracts,
    private readonly arkade: ArkadeLockups,
  ) {}

  async refundTimes(swap: Swap): Promise<RefundTimes> {
    const contract = await this.contracts.contract(swap.id)
    return {
      refundOpen: await this.arkade.refundOpen(contract),
      refundOpensAt: UnixSeconds.of(await this.arkade.refundOpensAt(contract)),
      secondsToRefundAlone: this.arkade.secondsToRefundAlone(contract),
    }
  }

  /** `not_funded` alone does not make funding safe: fund only a leg that is still `pending`. */
  async state(swap: Swap): Promise<Lockup> {
    const { arkade } = this
    const contract = await this.contracts.contract(swap.id)
    const fundTxid = swap.to.fact('funding')
    const recorded = this.recordedOutpoint(swap)

    // One read while the fill waits for the client. Once our refund is open, a claim is looked for first.
    let spendable: readonly FundedOutput[] | null = null
    if (swap.to.state === 'locked' && recorded !== null) {
      spendable = await arkade.spendable(contract)
      // When that cannot be learned, the refund is taken as open: the full read below is the careful one.
      const refundOpen = await arkade.refundOpen(contract).catch(() => true)
      if (spendable.some(same(recorded)) && !refundOpen) return lockupAt(LockupStatus.Funded, recorded)
    }

    const history = await arkade.history(contract)
    const ours =
      recorded ?? history.find((output) => output.txid === fundTxid) ?? adoptFunding(history, contract.payoutSats)
    if (ours === null) return { status: LockupStatus.NotFunded, outpoint: null, preimage: null, refundTx: null }
    const seen = history.find(same(ours)) ?? null
    if (recorded === null && seen?.spent === false) return lockupAt(LockupStatus.Funded, ours)

    // A claim counts on any output the script held: a fill sent twice has siblings, and each reveals the preimage.
    // Our own output is always searched, so indexer lag never narrows the search.
    const searched = seen === null ? [...history, ours] : history
    const preimage = this.verified(swap, await arkade.claimPreimage(contract, searched))
    if (preimage !== null) return lockupAt(LockupStatus.Claimed, ours, { preimage })

    // Before the spendable read, which shows an unrolled lockup as empty.
    if (seen?.unrolled === true) return lockupAt(LockupStatus.Unrolled, ours)
    // The history is final about a spent output. About an unspent one only the spendable read is:
    // an output in an expired batch is neither spent nor spendable.
    if (seen?.spent !== true) {
      const now = spendable ?? (await arkade.spendable(contract))
      if (now.some(same(ours))) return lockupAt(LockupStatus.Funded, ours)
      if (seen !== null) return lockupAt(LockupStatus.Gone, ours)
    }

    // A refund transaction on record proves nothing alone: it may have swept only dust. Our output must be spent.
    const refundTx = swap.to.fact('refund')
    if (refundTx !== null && seen?.spent === true) return lockupAt(LockupStatus.Refunded, ours, { refundTx })
    const lost = swap.to.state === 'refunding' ? ((await arkade.finalizePendingRefund?.(contract)) ?? null) : null
    return lost === null
      ? lockupAt(LockupStatus.Gone, ours)
      : lockupAt(LockupStatus.Refunded, ours, { refundTx: Reference.of(lost) })
  }

  /** Null only when it is certain nothing left our wallet. A throw does not mean it was not funded: read the state again. */
  async fund(swap: Swap): Promise<Reference | null> {
    const txid = await this.arkade.fund(await this.contracts.contract(swap.id))
    return txid === null ? null : Reference.of(txid)
  }

  // Call it only after `state` answered `funded` for a leg already `refunding`: that read looked for a claim.
  // Null when our own output is not there. A throw does not mean it was not refunded: read the state again.
  async refund(swap: Swap): Promise<Reference | null> {
    const ours = this.recordedOutpoint(swap)
    if (ours === null) throw new RuleViolated(`swap ${swap.id}: no funded outpoint recorded to refund`)
    const contract = await this.contracts.contract(swap.id)
    // A refund of dust alone would return a transaction id that nothing could tell from a refund of the fill.
    const outputs = await this.arkade.spendable(contract)
    if (!outputs.some(same(ours))) return null
    return Reference.of(await this.arkade.refund(contract, outputs))
  }

  hasOutpointOnRecord(swap: Swap): boolean {
    return OUTPOINT.test(swap.to.fact('funding') ?? '')
  }

  private recordedOutpoint(swap: Swap): Outpoint | null {
    const recorded = outpointOf(swap.to.fact('funding'))
    const mustBeRecorded = swap.to.state !== 'pending' && swap.to.state !== 'locking'
    if (recorded === null && mustBeRecorded) {
      throw new RuleViolated(`swap ${swap.id}: to leg is ${swap.to.state} with no funded outpoint recorded`)
    }
    return recorded
  }

  // A claim that reveals something other than this swap's preimage contradicts the contract: nothing may act on it.
  private verified(swap: Swap, revealed: Uint8Array | null): Preimage | null {
    if (revealed === null) return null
    const opens =
      swap.hashlock !== null &&
      revealed.length === 32 &&
      Preimage.opens(Preimage.of(hex.encode(revealed)), swap.hashlock)
    if (!opens) throw new RuleViolated(`swap ${swap.id}: a claim revealed a preimage that does not open the hashlock`)
    return Preimage.of(hex.encode(revealed))
  }
}

const lockupAt = (
  status: LockupStatus,
  ours: Outpoint,
  extra: { readonly preimage?: Preimage; readonly refundTx?: Reference } = {},
): Lockup => ({
  status,
  outpoint: referenceOf(ours),
  preimage: extra.preimage ?? null,
  refundTx: extra.refundTx ?? null,
})
