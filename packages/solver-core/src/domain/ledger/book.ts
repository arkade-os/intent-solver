import { Amount } from '../shared/amount.js'
import type { Asset } from '../shared/asset.js'
import { Endpoint } from '../shared/endpoint.js'
import type { SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'
import { Account } from './account.js'
import { Posting, JournalEntry } from './journal_entry.js'

/** What the ledger needs to know about a swap; the application maps a swap onto it. */
export interface SwapBooking {
  readonly swapId: SwapId
  readonly route: string
  /** `collected`: we claimed it. A client merely funding their lock moves nothing of ours. */
  readonly from: { readonly endpoint: Endpoint; readonly amount: Amount; readonly collected: boolean }
  readonly to: {
    readonly endpoint: Endpoint
    readonly amount: Amount
    readonly paidOut: boolean
    readonly returned: boolean
  }
  /** Paid out and never to be collected. */
  readonly lost: boolean
  /**
   * What we keep when the swap changes asset, in each asset's own units: a flat fee in the one
   * given, a spread in the one paid. A swap in one asset keeps the difference of its legs.
   */
  readonly income?: readonly Amount[]
  /** What the payout rail charged us. Null is UNKNOWN, never zero, and books nothing. */
  readonly cost: Amount | null
}

const settled = (b: SwapBooking | null): boolean => b !== null && b.from.collected && b.to.paidOut && !b.to.returned
const writtenOff = (b: SwapBooking | null): boolean =>
  b !== null && b.lost && b.to.paidOut && !b.to.returned && !b.from.collected

const kept = (income: readonly Amount[], asset: Asset): Amount =>
  income.filter((amount) => amount.asset === asset).reduce((sum, amount) => sum.plus(amount), Amount.zero(asset))

const closing = ({ route, from, to, income = [] }: SwapBooking): Posting[] => {
  const [given, paid] = [from.amount, to.amount]
  if (given.asset !== paid.asset) {
    const [fee, spread] = [kept(income, given.asset), kept(income, paid.asset)]
    // Through trading on both sides, so each asset balances on its own without a price.
    return [
      Posting.debit(Account.swapClearing(given.asset), given),
      ...(fee.isZero ? [] : [Posting.credit(Account.swapIncome(route, given.asset), fee)]),
      Posting.credit(Account.trading(given.asset), given.minus(fee)),
      Posting.debit(Account.trading(paid.asset), paid.plus(spread)),
      ...(spread.isZero ? [] : [Posting.credit(Account.swapIncome(route, paid.asset), spread)]),
      Posting.credit(Account.swapClearing(paid.asset), paid),
    ]
  }
  const clearing = Account.swapClearing(given.asset)
  if (given.equals(paid)) return []
  return given.gte(paid)
    ? [
        Posting.debit(clearing, given.minus(paid)),
        Posting.credit(Account.swapIncome(route, given.asset), given.minus(paid)),
      ]
    : [
        Posting.debit(Account.swapExpense(route, given.asset), paid.minus(given)),
        Posting.credit(clearing, paid.minus(given)),
      ]
}

/** The entries one change of a swap produces: each fact is booked once, when it first becomes true. */
export const bookSwap = (before: SwapBooking | null, after: SwapBooking, at: UnixSeconds): JournalEntry[] => {
  const { swapId, route, from, to, cost } = after
  const entries: JournalEntry[] = []
  const book = (fact: string, postings: Posting[]): void => {
    if (postings.length > 0) entries.push(JournalEntry.of(`swap:${swapId}:${fact}`, at, postings))
  }
  const holdingTo = Account.holding(to.endpoint)
  const clearingTo = Account.swapClearing(to.amount.asset)

  if (to.paidOut && !before?.to.paidOut)
    book('paid-out', [Posting.debit(clearingTo, to.amount), Posting.credit(holdingTo, to.amount)])
  if (to.returned && !before?.to.returned)
    book('returned', [Posting.debit(holdingTo, to.amount), Posting.credit(clearingTo, to.amount)])
  if (from.collected && !before?.from.collected) {
    book('collected', [
      Posting.debit(Account.holding(from.endpoint), from.amount),
      Posting.credit(Account.swapClearing(from.amount.asset), from.amount),
    ])
  }
  if (settled(after) && !settled(before)) book('settled', closing(after))
  // Without this a lost payout would sit in clearing forever, looking like money still on its way.
  if (writtenOff(after) && !writtenOff(before)) {
    book('lost', [
      Posting.debit(Account.swapExpense(route, to.amount.asset), to.amount),
      Posting.credit(clearingTo, to.amount),
    ])
  }
  if (cost !== null && !cost.isZero && (before === null || before.cost === null)) {
    book('cost', [
      Posting.debit(Account.swapExpense(route, cost.asset), cost),
      Posting.credit(Account.holding(Endpoint.of(to.endpoint.rail, cost.asset)), cost),
    ])
  }
  return entries
}
