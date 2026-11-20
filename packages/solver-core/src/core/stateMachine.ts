// No imports, on purpose: corridor descriptors reach this through `machines/*`
// on `loadConfig()`'s path, which must not load the native SQLite binding.

export interface StateSpec<S extends string> {
  /** Driven by the sweep and counted toward committed sats. `false` means terminal. */
  readonly live: boolean
  /** The solver may have paid out and not yet been made whole. Implies `live`. */
  readonly exposed: boolean
  readonly to: readonly S[]
}

type Table<T> = { readonly [K in keyof T]: StateSpec<keyof T & string> }
export type FlagsOf<T> = Exclude<{ [K in keyof T]: keyof T[K] }[keyof T], keyof StateSpec<string>> & string

export interface StateMachine<S extends string, F extends string = never> {
  readonly states: readonly S[]
  /** In declaration order, which is also the order {@link sqlList} writes into schema text. */
  readonly live: readonly S[]
  readonly exposed: readonly S[]
  readonly terminal: readonly S[]
  readonly edges: Readonly<Record<S, readonly S[]>>
  isLive(state: S): boolean
  isTerminal(state: S): boolean
  isExposed(state: S): boolean
  canTransition(from: S, to: S): boolean
  where(flag: F): readonly S[]
  sqlList(states: readonly S[]): string
}

export type StateOf<M> = M extends { readonly states: readonly (infer S)[] } ? S : never

/** A state with no entry does not compile; a live state without a step, or a terminal one with one, throws here. */
export const stepFor = <S extends string, Row extends { readonly state: S }>(
  machine: Pick<StateMachine<S>, 'states' | 'isLive'>,
  handlers: { readonly [K in S]: ((row: Row) => Promise<boolean>) | null },
): ((row: Row) => Promise<boolean>) => {
  for (const state of machine.states) {
    if (machine.isLive(state) !== (handlers[state] !== null)) {
      throw new Error(
        `state machine: '${state}' is ${machine.isLive(state) ? 'live but has no step' : 'terminal but has a step'}`,
      )
    }
  }
  return async (row) => (await handlers[row.state]?.(row)) ?? false
}

export const defineMachine = <const T extends Table<T>>(table: T): StateMachine<keyof T & string, FlagsOf<T>> => {
  type S = keyof T & string
  const states = Object.keys(table) as S[]
  for (const state of states) {
    const spec = table[state]
    if (spec.exposed && !spec.live) throw new Error(`state machine: '${state}' is exposed but not live`)
    for (const to of spec.to) {
      if (!(to in table)) throw new Error(`state machine: '${state}' has an edge to unknown state '${to}'`)
    }
  }
  const pick = (test: (spec: StateSpec<S>) => boolean) => states.filter((s) => test(table[s]))
  const live = new Set(pick((spec) => spec.live))
  const exposed = new Set(pick((spec) => spec.exposed))
  const edges = new Map(states.map((s) => [s, new Set<S>(table[s].to)]))
  return {
    states,
    live: [...live],
    exposed: [...exposed],
    terminal: pick((spec) => !spec.live),
    edges: Object.fromEntries(states.map((s) => [s, table[s].to])) as Record<S, readonly S[]>,
    isLive: (state) => live.has(state),
    isTerminal: (state) => !live.has(state),
    isExposed: (state) => exposed.has(state),
    canTransition: (from, to) => edges.get(from)?.has(to) ?? false,
    where: (flag) => pick((spec) => (spec as unknown as Record<string, unknown>)[flag] === true),
    sqlList: (list) => list.map((s) => `'${s}'`).join(','),
  }
}
