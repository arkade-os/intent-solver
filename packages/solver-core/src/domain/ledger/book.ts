import { Amount } from '../shared/amount.js'
import type { Asset } from '../shared/asset.js'
import { Endpoint } from '../shared/endpoint.js'
import type { RouteId, SwapId } from '../shared/ids.js'
import type { UnixSeconds } from '../shared/time.js'
import { Account } from './account.js'
import { JournalLine, JournalEntry } from './journal_entry.js'

/** What the ledger needs to know about a swap; the application maps a swap onto it. */
export interface SwapBooking {
  readonly swapId: SwapId
  readonly route: RouteId
  /** `collected` is true once we claimed it. A client funding their lock does not change our books. */
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
  /** What the payout rail charged us. Null means the cost is not known, and nothing is booked for it. */
  readonly cost: Amount | null
}

const settled = (b: SwapBooking | null): boolean => b !== null && b.from.collected && b.to.paidOut && !b.to.returned
const writtenOff = (b: SwapBooking | null): boolean =>
  b !== null && b.lost && b.to.paidOut && !b.to.returned && !b.from.collected

const kept = (income: readonly Amount[], asset: Asset): Amount =>
  income.filter((amount) => amount.asset === asset).reduce((sum, amount) => sum.plus(amount), Amount.zero(asset))

const closing = ({ route, from, to, income = [] }: SwapBooking): JournalLine[] => {
  const [given, paid] = [from.amount, to.amount]
  if (given.asset !== paid.asset) {
    const [fee, spread] = [kept(income, given.asset), kept(income, paid.asset)]
    // Through trading on both sides, so each asset balances on its own without a price.
    return [
      JournalLine.debit(Account.swapClearing(given.asset), given),
      ...(fee.isZero ? [] : [JournalLine.credit(Account.swapIncome(route, given.asset), fee)]),
      JournalLine.credit(Account.trading(given.asset), given.minus(fee)),
      JournalLine.debit(Account.trading(paid.asset), paid.plus(spread)),
      ...(spread.isZero ? [] : [JournalLine.credit(Account.swapIncome(route, paid.asset), spread)]),
      JournalLine.credit(Account.swapClearing(paid.asset), paid),
    ]
  }
  const clearing = Account.swapClearing(given.asset)
  if (given.equals(paid)) return []
  return given.gte(paid)
    ? [
        JournalLine.debit(clearing, given.minus(paid)),
        JournalLine.credit(Account.swapIncome(route, given.asset), given.minus(paid)),
      ]
    : [
        JournalLine.debit(Account.swapExpense(route, given.asset), paid.minus(given)),
        JournalLine.credit(clearing, paid.minus(given)),
      ]
}

/** The entries one change of a swap produces: each fact is booked once, when it first becomes true. */
export const bookSwap = (before: SwapBooking | null, after: SwapBooking, at: UnixSeconds): JournalEntry[] => {
  const { swapId, route, from, to, cost } = after
  const entries: JournalEntry[] = []
  const book = (fact: string, lines: JournalLine[]): void => {
    if (lines.length > 0) entries.push(JournalEntry.of(`swap:${swapId}:${fact}`, at, lines))
  }
  const holdingTo = Account.holding(to.endpoint)
  const clearingTo = Account.swapClearing(to.amount.asset)

  if (to.paidOut && !before?.to.paidOut)
    book('paid-out', [JournalLine.debit(clearingTo, to.amount), JournalLine.credit(holdingTo, to.amount)])
  if (to.returned && !before?.to.returned)
    book('returned', [JournalLine.debit(holdingTo, to.amount), JournalLine.credit(clearingTo, to.amount)])
  if (from.collected && !before?.from.collected) {
    book('collected', [
      JournalLine.debit(Account.holding(from.endpoint), from.amount),
      JournalLine.credit(Account.swapClearing(from.amount.asset), from.amount),
    ])
  }
  if (settled(after) && !settled(before)) book('settled', closing(after))
  // Without this a lost payout would stay in clearing forever and look like money still on its way.
  if (writtenOff(after) && !writtenOff(before)) {
    book('lost', [
      JournalLine.debit(Account.swapExpense(route, to.amount.asset), to.amount),
      JournalLine.credit(clearingTo, to.amount),
    ])
  }
  if (cost !== null && !cost.isZero && (before === null || before.cost === null)) {
    book('cost', [
      JournalLine.debit(Account.swapExpense(route, cost.asset), cost),
      JournalLine.credit(Account.holding(Endpoint.of(to.endpoint.rail, cost.asset)), cost),
    ])
  }
  return entries
}
