import type { Amount } from '../shared/amount.js'
import type { Asset } from '../shared/asset.js'
import type { UnixSeconds } from '../shared/time.js'
import type { Account } from './account.js'

/** Positive units are a debit, negative a credit. */
export interface Posting {
  readonly account: Account
  readonly units: bigint
}

const side =
  (sign: 1n | -1n) =>
  (account: Account, amount: Amount): Posting => {
    if (amount.asset !== account.asset) throw new Error(`${account.path} holds ${account.asset}, not ${amount.asset}`)
    return { account, units: sign * amount.units }
  }

export const debit = side(1n)
export const credit = side(-1n)

export class JournalEntry {
  private constructor(
    /** Unique per booked fact: appending the same key twice books it once. */
    readonly key: string,
    readonly at: UnixSeconds,
    readonly postings: readonly Posting[],
  ) {}

  static of(key: string, at: UnixSeconds, postings: readonly Posting[]): JournalEntry {
    if (key === '') throw new Error('journal entry needs a key')
    if (postings.length < 2) throw new Error(`journal entry ${key} needs at least two postings`)
    const sums = new Map<Asset, bigint>()
    for (const { account, units } of postings) {
      if (units === 0n) throw new Error(`journal entry ${key} has an empty posting to ${account.path}`)
      sums.set(account.asset, (sums.get(account.asset) ?? 0n) + units)
    }
    for (const [asset, sum] of sums) {
      if (sum !== 0n) throw new Error(`journal entry ${key} does not balance in ${asset}: off by ${sum}`)
    }
    return new JournalEntry(key, at, postings)
  }
}
