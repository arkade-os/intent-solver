/**
 * What the quotes screen claims, and what it actually shows.
 *
 * The two lists on it are empty for completely different reasons, and both
 * emptinesses are easy to misread as "this solver is doing nothing":
 *
 * - `quoted` is a LIVE SNAPSHOT. A quote is a swap in `quoted` state — there is
 *   no separate quote store, `insertQuote` writes the row — and `/api/quotes`
 *   filters `findRecoverable()` down to that one state. A funded quote leaves
 *   within seconds and lives under swaps; an expired or refused one goes
 *   terminal and drops out of `findRecoverable` entirely.
 * - `bids` is an in-memory ring buffer cleared on every restart, because open-RFQ
 *   bids are persisted nowhere (`src/admin/bids.ts`).
 *
 * Both were reported as confusing by an operator asking "why are we only
 * getting swaps but not quotes" — after a day of redeploys, which is precisely
 * when both lists are emptiest and least meaningful. The bid half already
 * explained itself; the quote half said only "nothing quoted right now", which
 * states the fact and hides the meaning.
 *
 * `app.js` is a browser module with no exports and no DOM here, so this reads
 * the source, as `test/admin/armedActions.test.ts` does and for the same reason.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(fileURLToPath(new URL('../../src/admin/static/app.js', import.meta.url)), 'utf8')

const quotesView = (): string => {
  const start = appSource.indexOf('const quotesView')
  if (start === -1) throw new Error('quotesView is gone')
  const end = appSource.indexOf('\n}', start)
  if (end === -1) throw new Error('quotesView does not close')
  return appSource.slice(start, end + 2)
}

describe('the quotes list says what its emptiness means', () => {
  /**
   * Everything rendered ABOVE the list itself — i.e. the standing explanation,
   * not the message shown only when the list happens to be empty.
   *
   * Sliced deliberately. A first version of these tests searched the whole
   * function, and the empty-state string alone satisfied them: deleting the
   * notice left them green, because that string also says "awaiting funding".
   * A test that a heading satisfies is not a test that the explanation exists.
   */
  const standingExplanation = (): string => quotesView().slice(0, quotesView().indexOf('d.quoted.length === 0'))

  it('carries a standing notice, shown whether or not the list is empty', () => {
    expect(standingExplanation()).toContain("h('p.notice'")
  })

  it('tells the reader these are quotes awaiting funding, not all quotes ever', () => {
    expect(standingExplanation()).toMatch(/awaiting funding/i)
  })

  it('says where a funded quote went, so an empty list is not read as no demand', () => {
    // The actual question asked: "why are we only getting swaps but not
    // quotes". The answer is that they became the swaps.
    expect(standingExplanation()).toMatch(/move to swaps|under swaps/i)
  })

  it('does not leave the bare "nothing quoted right now" that caused the confusion', () => {
    expect(quotesView()).not.toContain('nothing quoted right now')
  })
})

describe('the bid list keeps saying it is ephemeral', () => {
  it('warns that bids live in memory and are cleared on restart', () => {
    // Load-bearing after a redeploy: an empty list means "nothing since boot",
    // never "this solver has made no bids".
    const body = quotesView()
    expect(body).toMatch(/memory only/i)
    expect(body).toMatch(/cleared on restart/i)
  })

  it('says the empty case is scoped to this process, not to all time', () => {
    expect(quotesView()).toContain('since this process started')
  })

  it('names the capacity, so a short list is not read as the whole history', () => {
    expect(quotesView()).toContain('capacity')
  })
})

describe('the server half these messages describe', () => {
  const status = readFileSync(fileURLToPath(new URL('../../src/admin/routes/status.ts', import.meta.url)), 'utf8')

  it('really does filter to the single `quoted` state', () => {
    // If this ever became a history query, every message above would be wrong.
    const handler = status.slice(status.indexOf("app.get('/api/quotes'"))
    expect(handler.slice(0, 500)).toContain("state === 'quoted'")
  })

  it('really does source it from the live set, so terminal rows are excluded', () => {
    const handler = status.slice(status.indexOf("app.get('/api/quotes'"))
    expect(handler.slice(0, 500)).toContain('liveSwaps')
  })

  it('still ships the ephemeral flag with the bids, whatever the UI does with it', () => {
    const bids = readFileSync(fileURLToPath(new URL('../../src/admin/bids.ts', import.meta.url)), 'utf8')
    expect(bids).toContain('ephemeral')
  })
})
