import type { RailId } from './rail.js'

/**
 * What a corridor DECLARES about itself.
 *
 * Every field here replaces an exhaustive `Record<Corridor, …>` that used to
 * live in core or admin. That shape was never laziness — `diagnostics.ts`
 * records the reason: a `Record` over a closed union "fails to COMPILE until
 * someone states which balance funds it", which made it a forcing function for
 * money-critical questions, not merely a lookup.
 *
 * So every field below is REQUIRED, and the forcing function survives the
 * inversion: it moves from "core will not compile until a maintainer answers"
 * to "the corridor will not compile until its author answers". What must never
 * happen is a field becoming optional with a default — that would retire the
 * question silently, which is exactly the fund-loss shape issue #88 took.
 */

/**
 * Which balance funds this corridor's payout.
 *
 * OPEN (`RailId` is `string`), not the closed trio it began as: a plugged-in
 * corridor may settle somewhere this build has never heard of, and a closed
 * union would make its rail a question only a maintainer could answer. The
 * host resolves the id against its rail registry and reports UNKNOWN — never
 * zero — for one it does not have.
 *
 * @see core/rail.ts
 */
export type PayoutRail = RailId

export interface CorridorDescriptor<State extends string = string> {
  /** `arkade:BTC->lightning:BTC` — the RFQ pair, and the registry key. */
  readonly pair: string
  /**
   * The env-variable stem for this corridor's knobs: `LN_SEND` gives
   * `LN_SEND_MAX_SATS`. A stem rather than the pair string because
   * `arkade:BTC->lightning:BTC` is not a legal shell identifier.
   */
  readonly envStem: string
  /** Which rail's balance funds this corridor's payout — the destination leg. */
  readonly payoutRail: PayoutRail
  /**
   * The corridor's own state vocabulary, so a host can bucket rows without
   * knowing what any state MEANS.
   *
   * `exposed` is a subset of `live` by convention, not by type: a state can be
   * both in flight and money-out, and admin checks exposed first because that is
   * the more urgent fact.
   */
  readonly states: {
    readonly live: readonly State[]
    readonly exposed: readonly State[]
    readonly delivered: readonly State[]
  }
}

export type CorridorRegistry = ReadonlyMap<string, CorridorDescriptor>

/**
 * Index descriptors by pair, refusing any collision at COMPOSITION time.
 *
 * Both collisions are silent-money bugs if allowed to stand: a duplicate pair
 * lets one corridor shadow another's quote path, and a duplicate stem makes
 * `<STEM>_ENABLED=false` dark a corridor the operator did not name.
 */
export const createCorridorRegistry = (descriptors: readonly CorridorDescriptor[]): CorridorRegistry => {
  const byPair = new Map<string, CorridorDescriptor>()
  const stems = new Map<string, string>()
  for (const descriptor of descriptors) {
    if (byPair.has(descriptor.pair)) throw new Error(`duplicate corridor pair: ${descriptor.pair}`)
    const claimed = stems.get(descriptor.envStem)
    if (claimed !== undefined) {
      throw new Error(`duplicate corridor env stem ${descriptor.envStem}: ${claimed} and ${descriptor.pair}`)
    }
    stems.set(descriptor.envStem, descriptor.pair)
    byPair.set(descriptor.pair, descriptor)
  }
  return byPair
}
