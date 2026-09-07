type Sats = number | bigint

export interface SettleBalance {
  readonly boarding?: { readonly confirmed?: Sats; readonly [key: string]: unknown } | undefined
  readonly settled?: Sats
  readonly preconfirmed?: Sats
  readonly recoverable?: Sats
  readonly [key: string]: unknown
}

export declare const unsettledSats: (balance: SettleBalance) => number
export declare const staleBoardingSuspected: (balance: SettleBalance) => boolean
export declare const settleTimeoutMessage: (balance: SettleBalance, ms: number) => string
export declare const DEFAULT_SETTLE_TIMEOUT_MS: number
export declare const settleTimeoutMs: (raw: string | undefined) => number
export declare const settleWithin: <T>(start: () => Promise<T>, ms: number, message: string) => Promise<T>
