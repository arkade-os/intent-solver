import { hex } from '@scure/base'
import { RuleViolated } from '../../domain/shared/error.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import { Preimage } from '../../domain/swap/hashlock.js'
import { Reference, type Side } from '../../domain/swap/leg.js'
import { NOT_SEEN, type LegStatus, type SpendStatus } from '../../domain/swap/observation.js'
import type { Swap } from '../../domain/swap/swap.js'
import type { ArkadeLockups, LockupContracts, LockupOutpoint, LockupOutput, Outpoint } from '../../ports/arkade.js'
import { SendStatus, type RailService, type SendResult } from '../../ports/rail.js'

const NOT_SENT: SendResult = { status: SendStatus.NotSent }
const UNKNOWN: SendResult = { status: SendStatus.Unknown }
const sent = (reference: string): SendResult => ({ status: SendStatus.Sent, reference: Reference.of(reference) })

// The lockup address is public from the quote on, so anyone can pay dust to it. Only an output of exactly the
// payout is ours. A spent one is still ours: a claimed payout must be found, not paid again.
const ours = (history: readonly LockupOutpoint[], payoutSats: number): LockupOutpoint | null => {
  const exact = history.filter((output) => output.value === payoutSats)
  return exact.find((output) => !output.spent) ?? exact[0] ?? null
}

const same =
  (wanted: Outpoint) =>
  (output: Outpoint): boolean =>
    output.txid === wanted.txid && output.vout === wanted.vout

/** `txid:vout`, or null for a bare txid: the output of a payout just sent is not known yet. */
const outpointOf = (reference: string | null): Outpoint | null => {
  const [txid, vout] = (reference ?? '').split(':')
  return !txid || vout === undefined ? null : { txid, vout: Number(vout) }
}

// A payout just sent is recorded by its transaction alone, so its output is looked up in what the script holds.
const recorded = (swap: Swap, history: readonly LockupOutpoint[]): Outpoint | null => {
  const txid = swap.to.reference('funding')
  return txid === null ? null : (history.find((output) => output.txid === txid) ?? null)
}

/** Our side of a swap paid out on Arkade: a lockup the client claims with the preimage, or we refund. */
export class ArkadeLockup implements RailService {
  constructor(
    private readonly contracts: LockupContracts,
    private readonly arkade: ArkadeLockups,
  ) {}

  // Reads cost a call to the indexer each, and every open swap is read on every tick, so each state asks for
  // the least that can change its decision.
  async status(swap: Swap): Promise<LegStatus> {
    const { arkade } = this
    const contract = await this.contracts.contract(swap.id)
    const deadlines = {
      refundOpen: await arkade.refundOpen(contract),
      refundOpensAt: UnixSeconds.of(await arkade.refundOpensAt(contract)),
      refundAloneDelay: arkade.refundAloneDelaySeconds(contract),
    }
    const landed = (lockup: Outpoint): LegStatus => ({
      ...NOT_SEEN,
      ...deadlines,
      lock: 'landed',
      lockReference: Reference.of(`${lockup.txid}:${lockup.vout}`),
    })

    // Paid out and waiting for the client: while our output is still there, nothing else needs reading.
    const known = outpointOf(swap.to.reference('funding'))
    let spendable: readonly LockupOutput[] | null = null
    if (swap.to.state === 'locked' && known !== null) {
      spendable = await arkade.spendable(contract)
      if (spendable.some(same(known))) return landed(known)
    }

    const history = await arkade.history(contract)
    const lockup = known ?? recorded(swap, history) ?? ours(history, contract.payoutSats)
    if (lockup === null) return { ...NOT_SEEN, ...deadlines }
    const seen = history.find(same(lockup))
    // Not recorded as paid out yet, and the indexer shows it untouched: adopting it is all there is to decide.
    const adopting = swap.to.state === 'pending' || swap.to.state === 'locking'
    if (adopting && seen?.spent === false) return landed(lockup)

    // A claim counts on any output the script held: a payout sent twice has siblings, and each reveals the preimage.
    const preimage = await arkade.claimPreimage(contract, history.length > 0 ? history : [lockup])
    // Asked of our own output, not of the script: dust left at the address must not look like an unspent payout.
    // A lockup taken onto Bitcoin is gone from Arkade but is still ours to refund there.
    // The history is final about an output that was spent. About one that was not, only the spendable read is:
    // an output in an expired batch is neither spent nor spendable.
    const there = seen?.spent === true ? false : (spendable ?? (await arkade.spendable(contract))).some(same(lockup))
    const unspent = there || seen?.unrolled === true
    const refund = swap.to.reference('refund')
    const lostRefund =
      preimage === null && !unspent && refund === null && swap.to.state === 'refunding'
        ? ((await arkade.finishLostRefund?.(contract)) ?? null)
        : null
    const refunded = refund !== null || lostRefund !== null
    const spent: SpendStatus =
      preimage !== null
        ? { by: 'claim', preimage: Preimage.of(hex.encode(preimage)) }
        : unspent
          ? { by: 'nobody' }
          : { by: refunded ? 'refund' : 'unknown' }
    // A refund that only swept dust leaves our output in place, and then it has not landed.
    return { ...landed(lockup), spent, refund: !unspent && preimage === null && refunded ? 'landed' : 'none' }
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
