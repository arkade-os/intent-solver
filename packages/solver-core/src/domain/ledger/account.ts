import type { Asset } from '../shared/asset.js'
import type { ValueOf } from '../shared/brand.js'
import type { Endpoint } from '../shared/endpoint.js'

export const AccountKind = {
  Asset: 'asset',
  Clearing: 'clearing',
  Equity: 'equity',
  Income: 'income',
  Expense: 'expense',
} as const

export type AccountKind = ValueOf<typeof AccountKind>

/** One account holds one asset: `clearing:swap` in BTC and in USDT are two accounts. */
export class Account {
  private constructor(
    readonly path: string,
    readonly asset: Asset,
    readonly kind: AccountKind,
  ) {}

  /** What we hold on a rail. */
  static holding(endpoint: Endpoint): Account {
    return new Account(`assets:${endpoint.rail}:${endpoint.asset}`, endpoint.asset, AccountKind.Asset)
  }

  /** Value in the middle of a swap: paid out and not yet collected, or the reverse. */
  static swapClearing(asset: Asset): Account {
    return new Account('clearing:swap', asset, AccountKind.Clearing)
  }

  static transferClearing(asset: Asset): Account {
    return new Account('clearing:transfer', asset, AccountKind.Clearing)
  }

  /** Where a swap that changes asset closes both sides, so each asset still balances on its own. */
  static trading(asset: Asset): Account {
    return new Account(`equity:trading:${asset}`, asset, AccountKind.Equity)
  }

  static swapIncome(route: string, asset: Asset): Account {
    return new Account(`income:swap:${route}`, asset, AccountKind.Income)
  }

  static swapExpense(route: string, asset: Asset): Account {
    return new Account(`expenses:swap:${route}`, asset, AccountKind.Expense)
  }

  static liquidityExpense(asset: Asset): Account {
    return new Account('expenses:liquidity', asset, AccountKind.Expense)
  }

  get key(): string {
    return `${this.path}#${this.asset}`
  }
}
