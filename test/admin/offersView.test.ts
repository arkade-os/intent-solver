/**
 * The offers screen: that it exists, and that it shows both halves. Reads the
 * source, as `test/admin/quotesView.test.ts` does — `app.js` is a browser module
 * with no exports and no DOM here.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const appSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url)),
  'utf8',
)

const offersView = (): string => {
  const start = appSource.indexOf('const offersView')
  if (start === -1) throw new Error('offersView is gone')
  const end = appSource.indexOf('\n}', start)
  if (end === -1) throw new Error('offersView does not close')
  return appSource.slice(start, end + 2)
}

describe('the offers screen is reachable', () => {
  it('is in the nav, so an operator finds it without knowing the URL', () => {
    expect(appSource).toMatch(/VIEWS\s*=\s*\[[\s\S]*?\['offers', 'offers'\]/)
  })

  it('is routed to a body, so the tab renders something', () => {
    expect(appSource).toMatch(/BODIES\s*=\s*\{[\s\S]*?offers:\s*offersView/)
  })

  it('loads from the offers endpoint', () => {
    expect(appSource).toMatch(/offers:\s*\(\)\s*=>\s*'\/api\/offers'/)
  })
})

describe('the offers screen shows a fill', () => {
  it('renders the fill txid, which is what proves a fill landed', () => {
    expect(offersView()).toContain('offer.fillTxid')
  })

  it('renders the state word and the outpoint the offer is about', () => {
    expect(offersView()).toContain('offer.state')
    expect(offersView()).toContain('offer.outpoint')
  })

  it('renders BOTH legs, so a fill can be reconciled against what was paid', () => {
    expect(offersView()).toContain('offer.offerAmount')
    expect(offersView()).toContain('offer.wantAmount')
  })
})

describe('the offers screen shows a refusal', () => {
  // Sliced: the whole function would let the fills table satisfy these.
  const refusalHalf = (): string => offersView().slice(offersView().indexOf('recent refusals'))

  it('has a refusals section at all', () => {
    expect(offersView()).toContain('recent refusals')
  })

  it('renders the reason the offer was declined', () => {
    expect(refusalHalf()).toContain('refusal.reason')
  })

  it('renders the detail, which names the bounds in force and which set them', () => {
    expect(refusalHalf()).toContain('refusal.detail')
  })

  it('says the list is in-memory, so an empty one is not read as "none refused"', () => {
    const standing = refusalHalf().slice(0, refusalHalf().indexOf('d.refusals.entries.length === 0'))
    expect(standing).toMatch(/h\(\s*'p\.notice'/)
    expect(standing).toMatch(/memory only/i)
  })
})

describe('the offers screen distinguishes "none" from "not serving"', () => {
  it('says so when the deployment serves no market, rather than showing an empty table', () => {
    const standing = offersView().slice(0, offersView().indexOf('d.offers.length === 0'))
    expect(standing).toContain('d.serving')
    expect(standing).toMatch(/OFFER_MARKETS/)
  })
})
