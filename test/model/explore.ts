export interface Choice {
  readonly label: string
  run(): void
}

/** One execution, rebuilt from scratch for every path: a running worker cannot be copied, only replayed. */
export interface Run {
  choices(): Choice[]
  /** Two runs with the same fingerprint have the same future. */
  fingerprint(): string
  /** The name of a violated invariant, or null. */
  violated(): string | null
}

export interface Explored {
  readonly states: number
  readonly violation: { readonly invariant: string; readonly trace: readonly string[] } | null
}

// Everything in a run is in memory, so every worker reaches its next gate before this resolves.
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const replay = async (start: () => Run, trace: readonly string[]): Promise<Run> => {
  const run = start()
  await settle()
  for (const label of trace) {
    const choice = run.choices().find((c) => c.label === label)
    if (!choice) throw new Error(`replay diverged at ${label} in ${trace.join(' > ')}`)
    choice.run()
    await settle()
  }
  return run
}

/** Every interleaving, depth first, stopping at the first violated invariant. */
export const explore = async (start: () => Run, maxStates = 200_000): Promise<Explored> => {
  const seen = new Set<string>()
  const stack: string[][] = [[]]
  while (stack.length > 0) {
    const trace = stack.pop()!
    const run = await replay(start, trace)
    const fingerprint = run.fingerprint()
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const invariant = run.violated()
    if (invariant !== null) return { states: seen.size, violation: { invariant, trace } }
    if (seen.size > maxStates) throw new Error(`more than ${maxStates} states: the model is not bounded`)
    for (const choice of run.choices()) stack.push([...trace, choice.label])
  }
  return { states: seen.size, violation: null }
}
