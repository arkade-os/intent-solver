/**
 * A rail whose Lightning and onchain legs are ONE pool, and why that has to be
 * said out loud rather than reported as a second number.
 *
 * A rail is a pair (`packages/solver-app/src/ops/rails.ts`), and on some vendors the pair is one
 * wallet: the onchain leg pays out of the same balance the Lightning leg
 * reports, so the honest onchain figure — the one that answers "can this
 * corridor fund a swap" — is a number the console has ALREADY shown on another
 * row. Returning it plainly invites an operator to add the two and believe they
 * hold twice what they do.
 *
 * The alternatives are both worse. Throwing blanks the backends row and the
 * diagnostics page for a corridor that can in fact be funded; answering zero is
 * indistinguishable from a solver with no float. So it is reported, and marked
 * as the same pool — one number, said once, with the sharing visible.
 *
 * None of the rails this repo ships is in that shape: LND really does keep a
 * separate onchain wallet. The flag and its rendering are pinned here anyway
 * because they are exactly what a consumer's rail needs in order to be
 * reportable, and a field with no shipped implementer is a field a cleanup
 * deletes without knowing what it was for.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('the port admits the shared case', () => {
  it('carries a flag for it rather than leaving it to prose', () => {
    const port = source('../../packages/solver-core/src/ports/onchain.ts')
    expect(port).toContain('sharedWithLightning')
  })

  it('leaves it optional, so LND — which really has its own wallet — says nothing', () => {
    // A required flag would force every adapter to answer a question only the
    // single-wallet rails have.
    const port = source('../../packages/solver-core/src/ports/onchain.ts')
    expect(port).toMatch(/sharedWithLightning\?:/)
  })
})

describe('the console says it, because the payload alone cannot', () => {
  /**
   * The `probe('onchain', …)` call alone, bounded by the NEXT probe rather than
   * by a character count.
   *
   * A fixed window is the wrong instrument here: the probes are a sequential
   * list, so `indexOf` finds the start exactly, but the end was a guess. Adding
   * a few lines of comment inside the probe slid the assertion out of the
   * window and failed the test for a reason that had nothing to do with what it
   * checks — and the same guess one line shorter would have passed while
   * reading a DIFFERENT probe's body.
   */
  const onchainProbe = (): string => {
    const probes = source('../../packages/solver-app/src/admin/probes.ts')
    const start = probes.indexOf("probe('onchain'")
    expect(start, 'no onchain probe to read — the probe list was renamed').toBeGreaterThan(-1)
    const next = probes.indexOf("probe('", start + 1)
    return next === -1 ? probes.slice(start) : probes.slice(start, next)
  }

  it('renders the sharing on the backends row', () => {
    // A flag nothing displays is the same as no flag: the double-count happens
    // in the operator's head, reading two rows.
    expect(onchainProbe()).toContain('sharedWithLightning')
  })

  it('still reports the fee rate, which is what proves the backend answered', () => {
    expect(onchainProbe()).toContain('estimateFeeRate')
  })
})
