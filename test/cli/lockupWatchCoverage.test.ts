/**
 * Every corridor is on the funding fast path, not just the one that got it first.
 *
 * A source-level guard for the same reason `refundDestination.test.ts` gives:
 * `src/cli.ts` runs `main()` then `process.exit()` at module load and exports
 * nothing, so the wiring cannot be called from a test.
 *
 * This is worth pinning because the failure is invisible. A corridor left off
 * the subscription is not broken — the sweep still drives it, every test still
 * passes, and the only symptom is that funding detection costs seconds instead
 * of arriving as a push. That is exactly how the Lightning-send corridor ended
 * up as the only one watched while onchain send, which has the identical shape,
 * was already being registered as a contract a few lines away.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cliSource = readFileSync(fileURLToPath(new URL('../../src/cli.ts', import.meta.url)), 'utf8')

/** The body of the function that decides which scripts the watcher subscribes to. */
const resyncBody = (): string => {
  const start = cliSource.indexOf('const resyncWatchedScripts')
  if (start === -1) throw new Error('the watcher is no longer pointed at anything')
  const rest = cliSource.slice(start)
  const end = rest.indexOf('\n  }')
  if (end === -1) throw new Error('unterminated resyncWatchedScripts')
  return rest.slice(0, end)
}

/**
 * The four hand-written registrations this used to pin are gone: the corridor
 * registry replaced them with one loop, so "every corridor is watched" is now
 * STRUCTURAL rather than something four lines have to keep agreeing about.
 *
 * The property is unchanged and still worth pinning, because its failure is
 * still invisible. What can go wrong has moved: nobody can forget a corridor
 * any more, but somebody can reintroduce a filter — and a `.filter(...)` or an
 * `if` inside the loop would silently drop a corridor off the fast path with
 * every test still green, which is exactly the failure this file was written
 * for. So the assertions are now: it iterates the registry, it drives each
 * corridor with ITS OWN handle, and it singles out no corridor by name.
 */
describe('the lockup subscription', () => {
  it('iterates the corridor registry rather than naming corridors one by one', () => {
    expect(resyncBody()).toContain('for (const corridor of services.corridors)')
  })

  it('drives each corridor with its own findRecoverable and its own tick', () => {
    // Asserted as ONE call: watching a script and then ticking a DIFFERENT
    // corridor would look like it worked — the sweep would finish the swap
    // either way. Substring rather than a whole line, so prettier's wrapping is
    // not part of the contract.
    expect(resyncBody()).toContain('watch(await corridor.findRecoverable(), (id) => corridor.tick(id))')
  })

  /**
   * The registry holds exactly the ENABLED corridors — a disabled one has no
   * service, so it never enters the set. That gate belongs at construction, not
   * here: a second filter in the loop would be a corridor dropped from the fast
   * path for a reason nothing else in the process agrees with.
   */
  it.each(['services.store', 'services.onchainStore', 'services.receiveStore', 'services.onchainReceiveStore'])(
    'no longer singles out %s',
    (store) => {
      expect(resyncBody()).not.toContain(store)
    },
  )

  it('applies no filter of its own to the registry', () => {
    expect(resyncBody()).not.toMatch(/services\.corridors[\s\S]{0,40}\.filter\(/)
  })
})
