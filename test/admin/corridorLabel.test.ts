import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../packages/solver-app/src/admin/static/app.js', import.meta.url), 'utf8')
const between = (start: string, end: string): string => {
  const from = source.indexOf(start)
  return source.slice(from, source.indexOf(end, from))
}

const USDT = 'f121ac9b7656797cc68d1e8fecacfbaa2069ec1461edf0bf2f3c37404cb9791a0000'
const OTHER = 'f394dcbfe90ed53b6e9aa6916faf865e4be01a44fa4a0d1daad6fdbb459b4a790000'

const load = (tickers: Record<string, string>, state: { view: string; dialog?: object } = { view: 'pnl' }) => {
  let renders = 0
  const api = (path: string) => {
    const id = path.split('/').pop()!
    return id in tickers
      ? Promise.resolve({ assetId: id, shortId: `${id.slice(0, 8)}…${id.slice(-4)}`, ticker: tickers[id] })
      : Promise.reject(new Error('indexer down'))
  }
  const corridorLabel = new Function(
    'api',
    'render',
    'state',
    `${between('const shortId', 'const ago')}; ${between('const ASSET_ID', 'const carrierRfqPriced')};
     ${between('const corridorLabel', '/** Ended with')}; return corridorLabel`,
  )(api, () => renders++, state) as (corridor: string) => string
  return { corridorLabel, renders: () => renders }
}

const settle = () => new Promise((done) => setTimeout(done, 0))

describe('corridorLabel', () => {
  it('keeps the BTC corridors short', () => {
    expect(load({}).corridorLabel('arkade:BTC->lightning:BTC')).toBe('arkade→ln')
  })

  it('names an asset corridor by ticker once the lookup lands, repainting once', async () => {
    const { corridorLabel, renders } = load({ [USDT]: 'USDT' })
    expect(corridorLabel(`arkade:BTC->arkade:${USDT}`)).toBe('BTC→f121ac9b76…')
    corridorLabel(`arkade:${USDT}->arkade:BTC`)
    await settle()
    expect(renders()).toBe(1)
    expect(corridorLabel(`arkade:BTC->arkade:${USDT}`)).toBe('BTC→USDT')
    expect(corridorLabel(`btc->${USDT}`)).toBe('BTC→USDT')
  })

  it('keeps the short id, and does not repaint, when the lookup fails', async () => {
    const { corridorLabel, renders } = load({})
    corridorLabel(`arkade:BTC->arkade:${OTHER}`)
    await settle()
    expect(renders()).toBe(0)
    expect(corridorLabel(`arkade:BTC->arkade:${OTHER}`)).toBe('BTC→f394dcbfe9…')
  })

  it('tells apart two assets that share a ticker', async () => {
    const { corridorLabel } = load({ [USDT]: 'USDT', [OTHER]: 'USDT' })
    corridorLabel(`arkade:${USDT}->arkade:${OTHER}`)
    await settle()
    expect(corridorLabel(`arkade:${USDT}->arkade:${OTHER}`)).toBe('USDT f121ac9b…0000→USDT f394dcbf…0000')
  })

  it('holds the repaint wherever the swaps listener holds its reload', async () => {
    const pages = [
      { view: 'pricing' },
      { view: 'markets' },
      { view: 'activity', dialog: {} },
      { view: 'reconciliation' },
    ]
    const counts = await Promise.all(
      pages.map(async (state) => {
        const page = load({ [USDT]: 'USDT' }, state)
        page.corridorLabel(`arkade:BTC->arkade:${USDT}`)
        await settle()
        return page.renders()
      }),
    )
    expect(counts).toEqual([0, 0, 0, 1])
  })

  it('passes through a spelling it does not know', () => {
    expect(load({}).corridorLabel('arkade:BTC->ethereum:0xa0b8')).toBe('arkade:BTC->ethereum:0xa0b8')
  })
})
