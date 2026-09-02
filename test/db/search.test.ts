/**
 * Finding a swap from whatever the user gave you.
 *
 * An operator is handed a fragment — the first eight characters of a txid, a
 * payment hash pasted from a wallet, part of an address — and has to find the
 * row. Until now the console could filter by corridor and phase and nothing
 * else, so the answer was to open the raw JSON of every candidate.
 *
 * The search is a substring match, which forces three things to be right that
 * are all silent when wrong:
 *
 * - The OR group must be PARENTHESISED. `state = ? AND a LIKE ? OR b LIKE ?`
 *   binds as `(state AND a) OR b`, so a search returns rows from every state
 *   the caller filtered out. Nothing errors; the list is just wrong.
 * - LIKE wildcards in the term must be ESCAPED. `%` is "any run of characters"
 *   to SQLite, so searching for a literal `100%` otherwise matches everything.
 * - The term must be a PARAMETER. It is user input arriving over HTTP.
 *
 * Column names cannot be parameters, so they are supplied by each store from
 * its own schema constant and never taken from the request.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pageQuery, MIN_SEARCH_LENGTH } from '@arkade-os/solver-core/core/page.js'

const search = (term: string, columns = ['id', 'payment_hash']) => pageQuery('send_swap', { search: { term, columns } })

describe('pageQuery — searching', () => {
  it('matches a fragment anywhere in the value', () => {
    // The whole point: an operator has the middle of a txid, not the start.
    const { params } = search('efa0a57b')
    expect(params).toContain('%efa0a57b%')
  })

  it('ORs across every column it was given', () => {
    const { sql } = search('abc', ['id', 'payment_hash', 'lockup_txid'])
    expect(sql).toContain('id LIKE ?')
    expect(sql).toContain('payment_hash LIKE ?')
    expect(sql).toContain('lockup_txid LIKE ?')
    expect(sql.match(/ OR /g)).toHaveLength(2)
  })

  it('parenthesises the OR group, so a state filter still binds', () => {
    // The silent one. Without the brackets a search would return rows from
    // states the caller excluded, and nothing would report an error.
    const { sql } = pageQuery('send_swap', {
      states: ['stuck'],
      search: { term: 'abc', columns: ['id', 'payment_hash'] },
    })
    // Written as a plain string rather than a regex: the escape character is a
    // single backslash, and a regex literal needs it doubled, which is exactly
    // the confusion this clause exists to avoid.
    expect(sql).toContain("(id LIKE ? ESCAPE '\\' OR payment_hash LIKE ? ESCAPE '\\')")
    expect(sql).toContain('state IN (?)')
    // AND, not OR, between the state filter and the search group.
    expect(sql).toMatch(/state IN \(\?\) AND \(id LIKE/)
  })

  it('passes the term as a parameter, never into the SQL', () => {
    const { sql, params } = search("'; DROP TABLE send_swap; --")
    expect(sql).not.toContain('DROP TABLE')
    expect(params.some((p) => String(p).includes('DROP TABLE'))).toBe(true)
  })

  it('escapes a percent, so a literal % does not match everything', () => {
    const { params } = search('100%')
    expect(params).toContain('%100\\%%')
  })

  it('escapes an underscore, which otherwise matches any single character', () => {
    const { params } = search('a_b')
    expect(params).toContain('%a\\_b%')
  })

  it('escapes the escape character itself', () => {
    // Missed, a term ending in a backslash produces `ESCAPE '\'` followed by a
    // dangling escape and SQLite raises a syntax error on a valid search.
    const { params } = search('a\\b')
    expect(params).toContain('%a\\\\b%')
  })

  it('declares the escape character to SQLite', () => {
    // A backslash is not an escape in LIKE unless ESCAPE says so; without this
    // every escaping above is inert and the wildcards still apply.
    expect(search('abc').sql).toContain("ESCAPE '\\'")
  })

  it('trims the term, because operators paste with whitespace', () => {
    expect(search('  efa0a57b  ').params).toContain('%efa0a57b%')
  })

  it('refuses a term too short to be a search', () => {
    // One or two characters match nearly every row, so the result is a full
    // scan presented as an answer.
    expect(() => search('ab')).toThrow(/at least/i)
    expect(() => search('   a   ')).toThrow(/at least/i)
  })

  it('refuses an empty column list rather than matching nothing silently', () => {
    // `()` is a SQLite syntax error, and a search that quietly returned
    // everything would be worse.
    expect(() => search('abcdef', [])).toThrow(/column/i)
  })

  it('refuses a column name that is not a plain identifier', () => {
    // Columns are interpolated, not parameterised. They come from each store's
    // schema constant today, and this is what keeps that true if one day a
    // caller passes something through from a request.
    expect(() => search('abcdef', ['id; DROP TABLE send_swap'])).toThrow(/column/i)
    expect(() => search('abcdef', ['payment_hash) OR (1=1'])).toThrow(/column/i)
  })

  it('leaves the query alone when nothing is searched', () => {
    const { sql } = pageQuery('send_swap', {})
    expect(sql).not.toContain('LIKE')
  })

  it('still pages and orders the same way', () => {
    // Search narrows the set; it must not change the cursor contract.
    const { sql } = search('abcdef')
    expect(sql).toContain('ORDER BY created_at DESC, rowid DESC')
    expect(sql).toContain('LIMIT ?')
  })
})

/**
 * The column lists are interpolated into SQL, so a typo is not a type error —
 * it is a 500 the first time an operator searches. These check each list
 * against the schema constant in the same file.
 */
describe('each corridor searches columns it actually has', () => {
  const STORES = {
    'packages/solver-corridors/src/db/swaps.ts': 'SEND_SEARCH_COLUMNS',
    'packages/solver-corridors/src/db/receiveSwaps.ts': 'RECEIVE_SEARCH_COLUMNS',
    'packages/solver-corridors/src/db/onchainSwaps.ts': 'ONCHAIN_SEND_SEARCH_COLUMNS',
    'packages/solver-corridors/src/db/onchainReceiveSwaps.ts': 'ONCHAIN_RECEIVE_SEARCH_COLUMNS',
  } as const

  /**
   * The names inside a `SEARCH_COLUMNS` array.
   *
   * Anchored on `= [`, not on the first `]`: the declaration is typed
   * `readonly string[]`, so the first bracket pair closes before the array
   * begins and slicing there captured nothing at all.
   */
  const searchedBy = (path: string, name: string): string[] => {
    const source = readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    const start = source.indexOf(`export const ${name}`)
    if (start === -1) throw new Error(`${name} is gone from ${path}`)
    const open = source.indexOf('= [', start)
    const body = source.slice(open, source.indexOf(']', open))
    return [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((v): v is string => v !== undefined)
  }

  const declaredBy = (path: string): Set<string> => {
    const source = readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    return new Set(
      [...source.matchAll(/^\s{2}([a-z_]+)\s+(?:TEXT|INTEGER)/gm)]
        .map((m) => m[1])
        .filter((v): v is string => v !== undefined),
    )
  }

  for (const [path, name] of Object.entries(STORES)) {
    it(`${name} names only real columns`, () => {
      const searched = searchedBy(path, name)
      expect(searched.length).toBeGreaterThan(3)
      const declared = declaredBy(path)
      for (const column of searched) {
        expect(declared, `${name} searches ${column}, which the table does not declare`).toContain(column)
      }
    })

    it(`${name} carries the identifiers an operator is given`, () => {
      // The three every corridor has and every user can quote back at you.
      const searched = searchedBy(path, name)
      for (const column of ['id', 'lockup_address', 'rfq_id']) {
        expect(searched, name).toContain(column)
      }
    })
  }
})

describe('the console and the server agree on the minimum', () => {
  it('mirrors MIN_SEARCH_LENGTH in app.js', () => {
    // The console holds a term back below this rather than sending a request it
    // knows is a 400. Drift either way is visible only as a bug report: too low
    // and every short term flashes an error banner mid-typing, too high and the
    // console refuses searches the server would have run.
    const app = readFileSync(fileURLToPath(new URL('../../src/admin/static/app.js', import.meta.url)), 'utf8')
    const client = app.match(/const MIN_SEARCH = (\d+)/)?.[1]
    expect(client, 'MIN_SEARCH is gone from app.js').toBeDefined()
    expect(Number(client)).toBe(MIN_SEARCH_LENGTH)
  })
})
