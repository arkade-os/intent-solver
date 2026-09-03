/**
 * How the configured markets reach a running solver, and what a deployment that
 * has configured none still looks like.
 *
 * Two halves, because the two claims need different evidence:
 *
 * - the WIRING is asserted against the source text of `createServices`, for the
 *   reason `evmServices.test.ts` gives: constructing the stack needs an Arkade
 *   wallet, a Lightning node and a chain a unit test has none of.
 * - the BEHAVIOUR of the decision `createServices` delegates to is exercised for
 *   real, because that is where the fund-loss shape lives.
 */

import { describe, it, expect } from 'vitest'
import { assetMarketPolicy, type AssetMarketConfig } from '@arkade-os/solver-core/core/assetMarketConfig.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { createServicesBody } from '../support/createServicesBody.js'

const USDT = 'aa'.repeat(34)

const market = (over: Partial<AssetMarketConfig> = {}): AssetMarketConfig => ({
  base: null,
  quote: USDT,
  baseDecimals: 8,
  quoteDecimals: 6,
  feedUrl: 'https://feed.test/price',
  pricePath: '/price',
  toleranceBps: 10,
  feeBps: 25,
  sellBase: null,
  buyBase: null,
  enabled: true,
  ...over,
})

describe('createServices — asset markets', () => {
  it('reads them from the admin store at startup', () => {
    const body = createServicesBody()
    expect(body).toContain('assetMarketPolicy(await adminStore.listMarkets())')
  })

  it('hands BOTH derived lists to Services, from the one call', () => {
    // Never assembled separately at this call site. `assetMarketPolicy` derives
    // the pair list and the pricing list from one filter precisely so that a
    // market cannot leave one without the other — reconstructing either here
    // would put that back.
    const body = createServicesBody()
    expect(body).toContain('assetMarkets: assetMarkets.pricing')
    expect(body).toContain('assetMarketPairs: assetMarkets.pairs')
    expect(body).not.toMatch(/assetMarkets:.*\.filter\(/)
  })

  it('does not swallow a bad market the way it deliberately swallows a bad override', () => {
    // `applyOverrides` skips what it cannot validate, and is right to: refusing
    // to boot over a preference takes a solver down for nothing. Markets get
    // the opposite treatment and the asymmetry must stay visible — a `try`
    // around this call would restore the silent-empty-pricing path.
    const body = createServicesBody()
    const at = body.indexOf('assetMarketPolicy(')
    expect(at).toBeGreaterThan(-1)
    expect(body.slice(Math.max(0, at - 200), at)).not.toContain('try {')
  })

  it('resolves the markets from the stored rows alone, with no feed read', () => {
    // The probe belongs to the write path. Booting behind a price API would
    // take four unrelated BTC corridors down with it, and the runtime already
    // fails closed on a feed it cannot read.
    //
    // SCOPED to the call: `createServices` legitimately builds a price feed for
    // the EVM corridors further down, so a whole-body search for one would fail
    // for the wrong reason.
    const body = createServicesBody()
    const at = body.indexOf('assetMarketPolicy(')
    expect(at).toBeGreaterThan(-1)
    const call = body.slice(at, body.indexOf('\n', at))
    expect(call).toBe('assetMarketPolicy(await adminStore.listMarkets())')
    // Exactly once: a second resolution could disagree with the first, and only
    // one of them reaches `Services`.
    expect(body.match(/assetMarketPolicy\(/g)).toHaveLength(1)
  })
})

describe('a deployment that has configured no markets', () => {
  it('gets two empty lists, and therefore serves no offer at all', async () => {
    // The additive claim, end to end: an untouched admin database yields the
    // same nothing the offer path had before markets could be configured.
    const store = await AdminStore.open(':memory:', () => 1)
    const policy = assetMarketPolicy(await store.listMarkets())
    expect(policy).toEqual({ pairs: [], pricing: [] })
    await store.close()
  })

  it('opens no new database file — the table lives beside the overrides', async () => {
    // `db/layout.ts`'s rule: nothing invents a file for a table with no previous
    // release. A market write must be readable from the same store handle that
    // already held the overrides and the audit log.
    const store = await AdminStore.open(':memory:', () => 1)
    await store.putMarket(market())
    expect(await store.listMarkets()).toHaveLength(1)
    expect(await store.getOverrides()).toEqual({})
    await store.close()
  })
})

describe('what startup does with a stored market', () => {
  it('carries an enabled market through to both lists', async () => {
    const store = await AdminStore.open(':memory:', () => 1)
    await store.putMarket(market())
    const policy = assetMarketPolicy(await store.listMarkets())
    expect(policy.pairs).toEqual([{ a: null, b: USDT }])
    expect(policy.pricing).toHaveLength(1)
    await store.close()
  })

  it('refuses to start on a market that no longer validates, rather than dropping it', async () => {
    // Reachable only by a hand-edited database or a bound tightened in a later
    // release — the route refuses this before it is ever written. It matters
    // because dropping it would empty `pricing`, and an empty `pricing` is read
    // by `AssetOfferService` as "not opted into price gating": it fills at
    // whatever a maker asks. Loud beats silent-and-generous.
    const store = await AdminStore.open(':memory:', () => 1)
    await store.putMarket(market())
    // Straight past the store's own API, which is the only way to produce it.
    await (store as unknown as { driver: { run: (sql: string) => Promise<unknown> } }).driver.run(
      'UPDATE admin_market SET tolerance_bps = 10000',
    )
    await expect(store.listMarkets().then(assetMarketPolicy)).rejects.toThrow(/switched off/)
    await store.close()
  })

  it('leaves a disabled market out of BOTH lists, so pausing one cannot open the gate', async () => {
    const store = await AdminStore.open(':memory:', () => 1)
    await store.putMarket(market({ enabled: false }))
    expect(assetMarketPolicy(await store.listMarkets())).toEqual({ pairs: [], pricing: [] })
    await store.close()
  })
})
