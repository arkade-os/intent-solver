/**
 * Every transaction a swap made, reachable from its timeline.
 *
 * The console renders identifiers an operator would otherwise paste into an
 * explorer by hand, mid-incident, deciding whether to refund or claim. A field
 * the timeline never links is a field that gets copied out of the raw JSON blob
 * at the bottom of the modal — if the operator thinks to look.
 *
 * This shipped wrong and unnoticed. `STEP_LINKS` was written against the
 * `arkade:BTC->lightning:BTC` row and never revisited, so it looked for
 * `lockupTxid` — a SEND field. The receive corridor records the same fact as
 * `arkadeLockupTxid`, which appeared nowhere, so a settled `lightning:BTC->
 * arkade:BTC` swap showed `armed -> funded` with no link at all while the txid
 * sat in the row. Reported from mainnet on swap 28043f5d: "we funded this htlc
 * and they claimed it yet no txs are shown and linked."
 *
 * So the test that matters is not "does field X link" — it is COMPLETENESS.
 * These read the field names out of the four row types and require each one to
 * be linked or exempted by name, which is what makes adding a corridor, or a
 * field, fail here rather than in production.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

const appSource = read('../../src/admin/static/app.js')

/** The four corridor row types, and the file each lives in. */
const ROW_SOURCES = {
  'arkade:BTC->lightning:BTC': '../../packages/solver-corridors/src/db/swaps.ts',
  'lightning:BTC->arkade:BTC': '../../packages/solver-corridors/src/db/receiveSwaps.ts',
  'arkade:BTC->onchain:BTC': '../../packages/solver-corridors/src/db/onchainSwaps.ts',
  'onchain:BTC->arkade:BTC': '../../packages/solver-corridors/src/db/onchainReceiveSwaps.ts',
} as const

/**
 * Capture group 1 of every match, with the `undefined` TypeScript insists on
 * removed. A group inside `matchAll` is optional to the type system even when
 * the pattern makes it mandatory.
 */
const captures = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].map((m) => m[1]).filter((v): v is string => v !== undefined)

/**
 * Field names a reader would expect to be a link.
 *
 * Deliberately blunt — anything ending `Txid` or `Address`. Over-inclusive is
 * the safe direction: a field caught here that should NOT link is one line in
 * {@link NOT_LINKED} with a reason, whereas a field missed is invisible.
 */
const linkableFieldsOf = (source: string): string[] => [
  ...new Set(captures(source, /^\s+(?:readonly\s+)?([a-zA-Z]+(?:Txid|Address))\??:/gm)),
]

/**
 * Fields that intentionally have no timeline link, and why.
 *
 * Empty on purpose right now: every identifier these rows carry is one an
 * operator has a reason to open. Kept as a named list so a future exemption has
 * to be argued in writing rather than dropped silently.
 */
const NOT_LINKED: Record<string, string> = {}

/** Every field name mentioned in the `STEP_LINKS` table. */
const linkedFields = (): string[] => {
  const start = appSource.indexOf('const STEP_LINKS')
  if (start === -1) throw new Error('STEP_LINKS is gone')
  const table = appSource.slice(start, appSource.indexOf('\n}', start))
  return [...new Set(captures(table, /\['([a-zA-Z]+)',/g))]
}

describe('the timeline links every identifier a row carries', () => {
  for (const [corridor, path] of Object.entries(ROW_SOURCES)) {
    it(`covers every txid and address in ${corridor}`, () => {
      const linked = linkedFields()
      const missing = linkableFieldsOf(read(path)).filter((f) => !linked.includes(f) && !(f in NOT_LINKED))
      // Named in the failure so the fix is obvious: the message IS the todo.
      expect(missing, `unlinked in ${corridor}`).toEqual([])
    })
  }

  it('links the receive corridor lockup, which is what went missing', () => {
    // The specific regression, pinned by name so a table rewrite cannot quietly
    // drop it again while the completeness test above is still satisfied by
    // some other corridor mentioning the field.
    expect(linkedFields()).toContain('arkadeLockupTxid')
  })

  it('sends every arkade identifier to the arkade explorer and every L1 one to mempool', () => {
    // Crossing them is worse than a dead link: an L1 txid on an Arkade explorer
    // answers "not found", which reads exactly like the money is gone.
    const start = appSource.indexOf('const STEP_LINKS')
    const table = appSource.slice(start, appSource.indexOf('\n}', start))
    for (const [, field, chain] of table.matchAll(/\['([a-zA-Z]+)',\s*'(arkade|onchain)'/g)) {
      const expected = /^onchain/i.test(field ?? '') || field === 'fundingTxid' ? 'onchain' : 'arkade'
      expect(chain, `${field} should point at the ${expected} explorer`).toBe(expected)
    }
  })
})

describe('notes that name a transaction', () => {
  /** The allowlist `noteLinks` gates on. */
  const allowed = (): string[] => {
    const start = appSource.indexOf('const ARKADE_ONLY_CORRIDORS')
    if (start === -1) throw new Error('ARKADE_ONLY_CORRIDORS is gone')
    return captures(appSource.slice(start, appSource.indexOf('\n', start)), /'([^']+)'/g)
  }

  it('links notes on BOTH pure-Arkade corridors, not just the send one', () => {
    // `refund pushed <txid>` is written as a note on the receive corridor too,
    // and that corridor moves only on Arkade — so the txid a note names is
    // unambiguously an Arkade transaction there, exactly as it is on send.
    expect(allowed()).toEqual(['arkade:BTC->lightning:BTC', 'lightning:BTC->arkade:BTC'])
  })

  it('still refuses the onchain corridors, where a bare txid is ambiguous', () => {
    // Those corridors move on two chains and a note's 64 hex characters do not
    // say which. Guessing sends an operator to an explorer that answers "not
    // found" about someone else's chain — worse than no link at all.
    expect(allowed()).not.toContain('arkade:BTC->onchain:BTC')
    expect(allowed()).not.toContain('onchain:BTC->arkade:BTC')
  })

  it('actually gates on that list rather than naming it and ignoring it', () => {
    // A constant the function does not consult is decoration; the two tests
    // above would pass just the same.
    const start = appSource.indexOf('const noteLinks')
    expect(appSource.slice(start, appSource.indexOf('\n}', start))).toContain('ARKADE_ONLY_CORRIDORS')
  })
})
