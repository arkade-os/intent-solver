import { hex } from '@scure/base'
import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import { Preimage } from '../../domain/swap/hashlock.js'
import { Reference, type Side } from '../../domain/swap/leg.js'
import { NOT_SEEN, type LegStatus, type SpendStatus } from '../../domain/swap/observation.js'
import type { Swap } from '../../domain/swap/swap.js'
import type {
  ArkadeLockups,
  LockupContract,
  LockupContracts,
  LockupOutpoint,
  LockupOutput,
  Outpoint,
} from '../../ports/arkade.js'
import { SendStatus, type RailService, type SendResult } from '../../ports/rail.js'

const NOT_SENT: SendResult = { status: SendStatus.NotSent }
const UNKNOWN: SendResult = { status: SendStatus.Unknown }
const sent = (reference: string): SendResult => ({ status: SendStatus.Sent, reference: Reference.of(reference) })

const same =
  (wanted: Outpoint) =>
  (output: Outpoint): boolean =>
    output.txid === wanted.txid && output.vout === wanted.vout

/** `txid:vout`, or null for a bare txid: the output of a payout just sent is not known yet. */
const outpointOf = (reference: string | null): Outpoint | null => {
  const [txid, vout] = (reference ?? '').split(':')
  return !txid || vout === undefined ? null : { txid, vout: Number(vout) }
}

// The lockup address is public from the quote on, so anyone can pay dust to it. Only an output of exactly the
// payout is ours. A spent one is still ours: a claimed payout must be found, not paid again.
const exactPayout = (history: readonly LockupOutpoint[], payoutSats: number): LockupOutpoint | null => {
  const exact = history.filter((output) => output.value === payoutSats)
  return exact.find((output) => !output.spent) ?? exact[0] ?? null
}

const landed = (base: LegStatus, lockup: Outpoint): LegStatus => ({
  ...base,
  lock: 'landed',
  lockReference: Reference.of(`${lockup.txid}:${lockup.vout}`),
})

/** Our side of a swap paid out on Arkade: a lockup the client claims with the preimage, or we refund. */
export class ArkadeLockup implements RailService {
  constructor(
    private readonly contracts: LockupContracts,
    private readonly arkade: ArkadeLockups,
  ) {}

  // Each read is a call to the indexer, made for every open swap on every tick. The steps go from the cheapest
  // answer to the dearest and stop at the first one that settles the decision.
  async status(swap: Swap): Promise<LegStatus> {
    const { arkade } = this
    const contract = await this.contracts.contract(swap.id)
    const nothing: LegStatus = {
      ...NOT_SEEN,
      refundOpen: await arkade.refundOpen(contract),
      refundOpensAt: UnixSeconds.of(await arkade.refundOpensAt(contract)),
      refundAloneDelay: arkade.refundAloneDelaySeconds(contract),
    }
    const known = outpointOf(swap.to.reference('funding'))

    // 1. Paid out and waiting for the client: one read says whether our output is still there.
    let spendable: readonly LockupOutput[] | null = null
    if (swap.to.state === 'locked' && known !== null) {
      spendable = await arkade.spendable(contract)
      if (spendable.some(same(known))) return landed(nothing, known)
    }

    // 2. Find our output among everything the script ever held.
    const history = await arkade.history(contract)
    const sentTx = swap.to.reference('funding')
    const lockup =
      known ?? history.find((output) => output.txid === sentTx) ?? exactPayout(history, contract.payoutSats)
    if (lockup === null) return nothing
    const seen = history.find(same(lockup)) ?? null
    const notRecordedYet = swap.to.state === 'pending' || swap.to.state === 'locking'
    if (notRecordedYet && seen?.spent === false) return landed(nothing, lockup)

    // 3. It was spent, or we are refunding it: find out who has it.
    const spent = await this.spentBy(swap, contract, history, lockup, seen, spendable)
    return { ...landed(nothing, lockup), spent, refund: spent.by === 'refund' ? 'landed' : 'none' }
  }

  private async spentBy(
    swap: Swap,
    contract: LockupContract,
    history: readonly LockupOutpoint[],
    lockup: Outpoint,
    seen: LockupOutpoint | null,
    spendable: readonly LockupOutput[] | null,
  ): Promise<SpendStatus> {
    const { arkade } = this
    // A claim counts on any output the script held: a payout sent twice has siblings, and each reveals the preimage.
    const preimage = await arkade.claimPreimage(contract, history.length > 0 ? history : [lockup])
    if (preimage !== null) return { by: 'claim', preimage: Preimage.of(hex.encode(preimage)) }

    // Taken onto Bitcoin by a unilateral exit: gone from Arkade, still ours to refund there.
    if (seen?.unrolled === true) return { by: 'nobody' }
    // The history is final about a spent output. About an unspent one only the spendable read is:
    // an output in an expired batch is neither spent nor spendable.
    if (seen?.spent !== true) {
      const now = spendable ?? (await arkade.spendable(contract))
      if (now.some(same(lockup))) return { by: 'nobody' }
    }

    // Gone, with no claim. It is our refund if we recorded one, or if the server finished one whose answer we lost.
    if (swap.to.reference('refund') !== null) return { by: 'refund' }
    const lost = swap.to.state === 'refunding' ? await arkade.finishLostRefund?.(contract) : null
    return { by: lost ? 'refund' : 'unknown' }
  }

  async lock(swap: Swap): Promise<SendResult> {
    const contract = await this.contracts.contract(swap.id)
    try {
      const txid = await this.arkade.fund(contract)
      return txid === null ? NOT_SENT : sent(txid)
    } catch {
      return UNKNOWN
    }
  }

  async claim(swap: Swap, side: Side): Promise<SendResult> {
    throw new RuleViolated(`swap ${swap.id}: the ${side} leg is claimed by the client, never by us`)
  }

  async refund(swap: Swap): Promise<SendResult> {
    const contract = await this.contracts.contract(swap.id)
    const outputs = await this.arkade.spendable(contract)
    if (outputs.length === 0) return NOT_SENT
    try {
      return sent(await this.arkade.refund(contract, outputs))
    } catch {
      return UNKNOWN
    }
  }
}
