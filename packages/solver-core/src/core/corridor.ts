/**
 * A corridor, as the host sees it.
 *
 * The host — RFQ ingress, the sweep loop, the admin console — knows only this.
 * It never learns what `arkade:BTC->lightning:BTC` means, which is what lets a
 * corridor the host was never compiled against serve traffic.
 *
 * Optionality follows `ln/port.ts`'s discipline exactly: required core, optional
 * capabilities, and an absent capability means a DOCUMENTED degradation rather
 * than a guess. A corridor that cannot answer honestly must not pretend.
 */
import type { CorridorDescriptor } from './corridorDescriptor.js'
import type { PageOptions } from './page.js'

/** What a corridor hands back from an RFQ. Mirrors `ingress/rfq.ts`'s outcome. */
export interface CorridorRfqOutcome {
  kind: 'quote' | 'refused' | 'invalid'
  payload: Record<string, unknown>
  detail?: string
}

/**
 * What the TRANSPORT knows about a request that the payload does not say.
 *
 * `requesterKey` is the relay/HTTP identity a quote is admitted against, and it
 * is the only defence against one client exhausting the quote budget for
 * everyone. It has to reach the corridor: dropping it here would silently
 * disable admission control on every corridor that uses it, and nothing
 * downstream could tell an unthrottled solver from a quiet one.
 */
export interface QuoteOptions {
  requesterKey?: string
}

/**
 * One row as the host handles it: an id, a state word, and otherwise opaque.
 *
 * Deliberately only the two fields the host itself keys on. A corridor returns
 * a far richer object — the admin projection's `AdminSwap`, today — and the
 * host forwards it verbatim without ever naming its fields. Widening this to
 * an index signature would be worse than useless: TypeScript refuses to assign
 * an `interface` to an index-signature type at all, so it would force every
 * corridor's view through a cast, and casting is how a host starts silently
 * depending on a shape corridors are free to change.
 *
 * `state` is here rather than opaque because it is the corridor's OWN state
 * word and the host buckets on it via `descriptor.states` — that is the one
 * piece of a row's content the host legitimately reads.
 */
export type CorridorPhase = 'open' | 'exposed' | 'done' | 'failed'

export interface CorridorSwapView {
  readonly id: string
  /** The corridor's OWN state word, never normalised away. */
  readonly state: string
  /**
   * Which bucket the host files this row under.
   *
   * Supplied by the corridor rather than derived here from
   * `descriptor.states`, because a corridor may PRESENT a state differently
   * from how it stores it — the two send legs record a refund as a patch column
   * on a `refused` row, so their real word for "refunded" is `refused`, and
   * showing that hides the refund. Only the corridor knows that about itself.
   */
  readonly phase: CorridorPhase
  /** Sort keys. The host orders across corridors, so both must be comparable. */
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * What a corridor can do with its STORE alone: be read.
 *
 * Split from {@link Corridor} because the codebase already draws this line, and
 * enforcing it in a type is cheaper than rediscovering it. `createServices`
 * builds a corridor's service only when the corridor is ENABLED, but opens its
 * store either way — so a switched-off corridor must stay READABLE: the admin
 * console lists its in-flight swaps and the status route answers for
 * negotiations it quoted before it went dark. Both are things an operator needs
 * precisely BECAUSE the corridor was turned off.
 *
 * Conflating the two costs behaviour in a direction nobody notices quickly: a
 * disabled corridor's swaps would stop appearing in the console, and the status
 * route would answer "no negotiation with this rfq_id" about a live one.
 */
export interface CorridorReader {
  readonly descriptor: CorridorDescriptor

  /**
   * This corridor's status payload for an rfq id, or null when the id is not
   * one of its own.
   *
   * Null-or-answer rather than an outcome, because a STATUS request carries no
   * `pair` — `rfq_id` identifies at most one negotiation anywhere, so the host
   * asks each corridor in turn and takes the first non-null. That fall-through
   * is what `respondToRfqStatus` already does across four hardcoded stores; the
   * registry only makes the list open. Iteration order is a latency choice
   * rather than a correctness one, exactly as that function's own doc says.
   *
   * A corridor MUST answer null for an id it does not hold, never a refusal: a
   * refusal here would end the fall-through and hide a live swap belonging to
   * the corridor after it.
   */
  statusFor(rfqId: string): Promise<Record<string, unknown> | null>

  /** Rows the sweep should drive, with the lockup scripts worth watching. */
  findRecoverable(): Promise<readonly { id: string; pkScript: string }[]>

  /**
   * This corridor's live lockups, in whatever shape the settlement layer needs
   * to rebuild their scripts.
   *
   * `unknown[]` because core must not name `CovenantScriptRow` — that type
   * belongs to `src/arkade/`, and core importing it would be the very edge this
   * method exists to remove. The Arkade lifecycle narrows it; a corridor that
   * settles somewhere else supplies its own shape and its own lifecycle reads it.
   *
   * OPTIONAL IN THE TYPE, MANDATORY IN FACT for any corridor that funds
   * lockups the settlement layer must register. Absence means "this corridor
   * holds no such lockups" — NOT "skip me". A corridor that HAS them and omits
   * this loses renewal protection and its recovery path for every one of them,
   * which is capital rather than display.
   *
   * The type cannot enforce that, and neither can the settlement layer: a
   * corridor with genuinely nothing to report is entitled to omit the method,
   * and nothing at that layer can distinguish the two. So the obligation is
   * stated here, where an implementer reads it.
   *
   * What IS enforced, in `liveLockupRows`: a non-empty set where NOTHING
   * answered throws, because that can only be a set assembled wrong. Partial
   * silence — some answering, others mute — cannot throw for the reason above,
   * so it logs the mute corridors by name instead, leaving the judgement with
   * the operator who wired them.
   */
  liveLockups?(): Promise<readonly unknown[]>

  committedSats(): Promise<number>

  page(options: PageOptions): Promise<{ swaps: CorridorSwapView[]; nextCursor: string | null }>

  /** One row plus its timeline, or null when this corridor has no such id. */
  detail(id: string): Promise<{
    raw: unknown
    swap: CorridorSwapView
    history: { at: number; from: string | null; to: string; detail: string | null }[]
  } | null>

  close(): Promise<void>
}

/**
 * A corridor that is also SERVING — quoting, and driven by the sweep.
 *
 * Present iff this deployment enabled the corridor. Everything a reader can do,
 * plus the two things that need a live service behind them.
 */
export interface Corridor extends CorridorReader {
  /**
   * Validate an RFQ request and issue or refuse terms.
   *
   * The corridor owns its OWN wire schema — that ownership is what deletes the
   * `if (pair === …)` chain and the four schema imports from `ingress/rfq.ts`.
   * The host still validates what comes BACK: the refusal vocabulary is the
   * wire contract and stays the host's to enforce.
   */
  quote(payload: unknown, options?: QuoteOptions): Promise<CorridorRfqOutcome>

  /** Drive one swap one step. Must be re-entrant and re-read the row. */
  tick(id: string): Promise<void>

  /**
   * Drive EVERY non-terminal row one step, and answer how many were driven.
   *
   * REQUIRED, not optional, and it is not `findRecoverable` + `tick` in a loop.
   * The lockup watcher only fires when a script sees activity, so it advances a
   * row waiting on FUNDING and never one waiting on a DEADLINE — this periodic
   * pass is the safety net that moves everything else. A corridor without it
   * would appear to work right up until a swap needed to time out.
   *
   * Nor can the host synthesise it: the built-in implementations run bounded
   * concurrent workers off one shared iterator, honour the tick-error backoff,
   * de-duplicate rows already in flight, and isolate one row's failure from the
   * rest of the sweep. A naive loop here would quietly drop all four.
   *
   * The count is for the operator's recovery line, not for control flow.
   */
  tickAll(): Promise<number>

  // ---- Optional capabilities. Absence degrades, documented per method. ----

  /**
   * A fast cadence for a corridor whose latency is dominated by one step.
   * Absent means the corridor is driven only by the ordinary sweep, which is
   * correct but slower — today only Lightning-send has one.
   */
  tickHot?(): Promise<void>

  /** Sweep refunds this corridor can push unattended. Absent means none exist. */
  refundSweep?(): Promise<string[]>

  /** Operator-forced refund. Absent means the console offers no such button. */
  refundNow?(id: string): Promise<string | null>

  /** Operator-forced claim. Absent means the console offers no such button. */
  claimNow?(id: string): Promise<{ txid: string } | { refused: string }>
}

export interface CorridorSet extends Iterable<Corridor> {
  get(pair: string): Corridor | undefined
  readonly size: number
}

/**
 * Every corridor this deployment has a STORE for, serving or not.
 *
 * Wider than {@link CorridorSet} on purpose — that one holds only corridors
 * that can quote. The console and the status route read this one, so a corridor
 * an operator switched off keeps reporting its in-flight swaps instead of
 * silently vanishing from both.
 */
export interface CorridorReaderSet extends Iterable<CorridorReader> {
  get(pair: string): CorridorReader | undefined
  readonly size: number
}

/**
 * Index corridors by pair, refusing any collision at COMPOSITION time.
 *
 * Same two collisions `createCorridorRegistry` refuses, for the same reasons: a
 * duplicate pair lets one corridor shadow another's quote path, and a duplicate
 * stem makes `<STEM>_ENABLED=false` dark a corridor the operator did not name.
 *
 * `get` answers undefined rather than throwing, unlike `descriptorFor`: this one
 * IS the dispatch, and an unknown pair is a routine client request to refuse
 * rather than a build fault.
 */
export const createCorridorSet = (corridors: readonly Corridor[]): CorridorSet => {
  const byPair = new Map<string, Corridor>()
  const stems = new Map<string, string>()
  for (const corridor of corridors) {
    const { pair, envStem } = corridor.descriptor
    if (byPair.has(pair)) throw new Error(`duplicate corridor pair: ${pair}`)
    const claimed = stems.get(envStem)
    if (claimed !== undefined) throw new Error(`duplicate corridor env stem ${envStem}: ${claimed} and ${pair}`)
    stems.set(envStem, pair)
    byPair.set(pair, corridor)
  }
  return {
    get: (pair) => byPair.get(pair),
    get size() {
      return byPair.size
    },
    [Symbol.iterator]: () => byPair.values(),
  }
}

/**
 * The same indexing for readers, which is every corridor with a store.
 *
 * A separate function rather than a generic over both, because the collision
 * rules differ in what they protect: for SERVING corridors a duplicate pair
 * means one shadowing another's quote path, whereas here it would only mean an
 * ambiguous read. Both are still refused — a registry that quietly dropped one
 * of two identically-named corridors would make the console under-report, which
 * is the same class of silent narrowing this split exists to prevent.
 */
export const createCorridorReaderSet = (corridors: readonly CorridorReader[]): CorridorReaderSet => {
  const byPair = new Map<string, CorridorReader>()
  for (const corridor of corridors) {
    if (byPair.has(corridor.descriptor.pair)) {
      throw new Error(`duplicate corridor pair: ${corridor.descriptor.pair}`)
    }
    byPair.set(corridor.descriptor.pair, corridor)
  }
  return {
    get: (pair) => byPair.get(pair),
    get size() {
      return byPair.size
    },
    [Symbol.iterator]: () => byPair.values(),
  }
}
