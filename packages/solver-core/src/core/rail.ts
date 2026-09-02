/**
 * A balance a corridor's payout draws on.
 *
 * Open (`RailId = string`) because a plugged-in corridor may settle somewhere
 * this build has never heard of. It was a closed
 * `'lightning' | 'arkade' | 'onchain'`, which made the payout rail a question
 * only a maintainer could answer — the same closed-union shape §4.1 of the SDK
 * spec is about, one layer down.
 */
export type RailId = string

/** What a rail reported, once. Null value means UNKNOWN — never zero. */
export interface RailBalance {
  /**
   * Spendable sats, or null when the rail could not be read.
   *
   * `diagnostics.ts` states the contract and it is the whole point: unknown is
   * not zero. A rail reporting 0 for "I could not reach the backend" makes a
   * solver look broke rather than blind, and `canHonourMax` would then read
   * false for a reason with nothing to do with headroom.
   */
  value: number | null
  error: string | null
}

export interface Rail {
  readonly id: RailId
  /** Must not throw: one dead rail may not take the others down with it. */
  balance(): Promise<RailBalance>
}

/** Every rail's balance as of one moment. */
export type RailBalances = ReadonlyMap<RailId, RailBalance>

/**
 * Read every rail EXACTLY ONCE, concurrently.
 *
 * The single read is the point, not an optimisation. Two corridors pay out on
 * Arkade today; asking that wallet twice can return two different numbers and
 * report the pair inconsistently — one corridor shown as able to honour its max
 * beside another shown as unable, off the same underlying balance. Callers
 * INDEX the returned map inside their per-corridor loop; they must never call
 * `balance()` there.
 *
 * A rail that throws despite the contract is recorded as unreadable rather than
 * being allowed to fail the whole snapshot — same reason each read is caught
 * separately today.
 */
export const readRails = async (rails: readonly Rail[]): Promise<RailBalances> => {
  const entries = await Promise.all(
    rails.map(async (rail): Promise<readonly [RailId, RailBalance]> => {
      try {
        return [rail.id, await rail.balance()]
      } catch (error) {
        return [rail.id, { value: null, error: error instanceof Error ? error.message : String(error) }]
      }
    }),
  )
  return new Map(entries)
}

/**
 * What a corridor's rail reported, or UNKNOWN when no such rail is registered.
 *
 * A corridor naming a rail this build does not have is exactly the plugged-in
 * case, and it must land on the same "unknown" a dead rail does — never on
 * zero, and never on a throw that would take the diagnostics page down.
 */
export const balanceOfRail = (balances: RailBalances, id: RailId): RailBalance =>
  balances.get(id) ?? { value: null, error: `no rail registered for ${id}` }
