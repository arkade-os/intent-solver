import { describe, it, expect } from 'vitest'
import { documentToKnobs, PATHS, renameKnobs } from '@arkade-os/solver-app/config/knobs.js'
import type { SolverDocument } from '@arkade-os/solver-app/config/document.js'
import { FULL_DOCUMENT } from '../support/configDocuments.js'

const USDA_ID = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'

/** A document holding `value` at a dotted path. */
const docAt = (path: string, value: unknown): SolverDocument => {
  const doc: Record<string, unknown> = {}
  const segments = path.split('.')
  let node = doc
  for (const segment of segments.slice(0, -1)) {
    node[segment] = {}
    node = node[segment] as Record<string, unknown>
  }
  node[segments.at(-1)!] = value
  return doc as SolverDocument
}

const evmDoc = (extra: Record<string, unknown> = {}): SolverDocument =>
  ({
    rails: { evm: { arbitrum: { chainId: 42161 } } },
    assets: {
      'USDC@arbitrum': { kind: 'erc20', chain: 'arbitrum', address: USDC, decimals: 6, priceFeed: 'http://feed' },
    },
    ...extra,
  }) as SolverDocument

describe('documentToKnobs — fixed paths', () => {
  it.each(PATHS.map(([path, knob, encode]) => ({ path, knob, encode })))('$path ⇄ $knob', ({ path, knob, encode }) => {
    const { knobs, pathOf } = documentToKnobs(docAt(path, 'sentinel'))
    expect(knobs[knob]).toBe(encode ? encode('sentinel') : 'sentinel')
    expect(pathOf.get(knob)).toBe(path)
  })

  it('writes booleans, numbers and lists the way the readers parse them', () => {
    const { knobs } = documentToKnobs({
      rails: { arkade: { poolAutoMint: true }, lightning: { sendHintScidDenylist: ['00aa', '00bb'] } },
      limits: { maxSwapSats: 5000 },
      diagnostics: { latency: true },
    })
    expect(knobs).toMatchObject({
      POOL_AUTO_MINT: 'true',
      LN_SEND_HINT_SCID_DENYLIST: '00aa,00bb',
      MAX_SWAP_SATS: '5000',
      SOLVER_LATENCY_DIAGNOSTICS: '1',
    })
  })

  it('leaves an absent or null key absent, so the reader applies its default', () => {
    const { knobs } = documentToKnobs({ admin: { port: null } })
    expect(knobs).not.toHaveProperty('ADMIN_PORT')
  })

  it('flattens the full document without complaint', () => {
    expect(() => documentToKnobs(FULL_DOCUMENT as SolverDocument)).not.toThrow()
  })
})

describe('documentToKnobs — corridors', () => {
  it('maps a BTC corridor terms block to its stem', () => {
    const { knobs } = documentToKnobs({ corridors: { 'arkade:BTC->lightning:BTC': { enabled: false, feeBps: 50 } } })
    expect(knobs).toMatchObject({ LN_SEND_ENABLED: 'false', LN_SEND_FEE_BPS: '50' })
  })

  it('maps the onchain receive band to its own knobs', () => {
    const { knobs } = documentToKnobs({
      corridors: { 'onchain:BTC->arkade:BTC': { maxBandSats: 100, bandBelowShare: 0.5, feeCapSats: 9 } },
    })
    expect(knobs).toMatchObject({
      ONCHAIN_RECEIVE_MAX_BAND_SATS: '100',
      ONCHAIN_RECEIVE_BAND_BELOW_SHARE: '0.5',
      ONCHAIN_RECEIVE_FEE_CAP_SATS: '9',
    })
  })

  it('refuses feeCapSats on a lightning corridor', () => {
    expect(() => documentToKnobs({ corridors: { 'lightning:BTC->arkade:BTC': { feeCapSats: 1 } } })).toThrow(
      'corridors["lightning:BTC->arkade:BTC"].feeCapSats: not valid on a lightning corridor',
    )
  })

  it('refuses the band on the onchain send corridor', () => {
    expect(() => documentToKnobs({ corridors: { 'arkade:BTC->onchain:BTC': { maxBandSats: 1 } } })).toThrow(
      'corridors["arkade:BTC->onchain:BTC"].maxBandSats: not valid on an onchain send corridor',
    )
  })

  it('resolves an erc20 label into EVM_TOKENS and per-direction knobs', () => {
    const { knobs, pathOf } = documentToKnobs(
      evmDoc({
        corridors: {
          'arkade:BTC->USDC@arbitrum': { maxUnits: '1000000000', minUnits: '1000000' },
          'USDC@arbitrum->arkade:BTC': { enabled: false },
        },
      }),
    )
    expect(knobs).toMatchObject({
      EVM_TOKENS: `USDC:${USDC}:6`,
      EVM_USDC_PRICE_FEED: 'http://feed',
      EVM_SEND_USDC_MAX_UNITS: '1000000000',
      EVM_SEND_USDC_MIN_UNITS: '1000000',
      EVM_RECEIVE_USDC_ENABLED: 'false',
      EVM_CHAIN_ID: '42161',
    })
    expect(pathOf.get('EVM_SEND_USDC_MAX_UNITS')).toBe('corridors["arkade:BTC->USDC@arbitrum"].maxUnits')
    expect(pathOf.get('EVM_USDC_PRICE_PATH')).toBe('assets["USDC@arbitrum"].pricePath')
    expect(pathOf.get('EVM_MIN_CONFIRMATIONS')).toBe('rails.evm.arbitrum.minConfirmations')
  })

  it('refuses units on a BTC corridor', () => {
    expect(() => documentToKnobs({ corridors: { 'arkade:BTC->lightning:BTC': { maxUnits: '1' } } })).toThrow(
      'corridors["arkade:BTC->lightning:BTC"].maxUnits: not valid on a lightning corridor',
    )
  })

  it('maps an Arkade asset corridor by the leg the client gives', () => {
    const { knobs } = documentToKnobs({
      assets: { USDA: { kind: 'arkade', assetId: USDA_ID, approvalThreshold: '250' } },
      corridors: { 'USDA->arkade:BTC': { enabled: false }, 'arkade:BTC->USDA': { enabled: true } },
    })
    expect(knobs).toMatchObject({
      ASSET_MARKETS: `USDA:${USDA_ID}`,
      ASSET_USDA_TO_BTC_ENABLED: 'false',
      ASSET_USDA_FROM_BTC_ENABLED: 'true',
      ASSET_USDA_APPROVAL_THRESHOLD: '250',
    })
  })

  it('admits only enabled on an Arkade asset corridor', () => {
    expect(() =>
      documentToKnobs({
        assets: { USDA: { kind: 'arkade', assetId: USDA_ID } },
        corridors: { 'USDA->arkade:BTC': { feeBps: 5 } },
      }),
    ).toThrow('corridors["USDA->arkade:BTC"].feeBps: not valid on an Arkade asset corridor')
  })

  it('refuses a corridor naming an unknown asset', () => {
    expect(() => documentToKnobs({ corridors: { 'arkade:BTC->NOPE': { enabled: true } } })).toThrow(
      'corridors["arkade:BTC->NOPE"]: NOPE is neither a BTC rail nor an asset in assets',
    )
  })

  it('refuses a pair no corridor serves', () => {
    expect(() => documentToKnobs({ corridors: { 'lightning:BTC->onchain:BTC': {} } })).toThrow(
      'corridors["lightning:BTC->onchain:BTC"]: no corridor serves this pair',
    )
  })
})

describe('documentToKnobs — assets', () => {
  it('derives the symbol from the label', () => {
    const { knobs } = documentToKnobs({ assets: { usda: { kind: 'arkade', assetId: USDA_ID } } })
    expect(knobs.ASSET_MARKETS).toBe(`USDA:${USDA_ID}`)
  })

  it('refuses a label that does not start with a symbol', () => {
    expect(() => documentToKnobs({ assets: { '9lives': { kind: 'arkade', assetId: USDA_ID } } })).toThrow(
      'assets["9lives"]: label must start with a 1-12 character symbol',
    )
  })

  it('refuses a label that could not appear in a corridor key', () => {
    expect(() => documentToKnobs({ assets: { 'US:DA': { kind: 'arkade', assetId: USDA_ID } } })).toThrow(
      'assets["US:DA"]: label may hold only letters, digits, @ . _ -',
    )
  })

  it('refuses two assets of one kind sharing a symbol', () => {
    expect(() =>
      documentToKnobs({
        assets: { usda: { kind: 'arkade', assetId: USDA_ID }, 'USDA@x': { kind: 'arkade', assetId: USDA_ID } },
      }),
    ).toThrow('assets: usda and USDA@x share the symbol USDA')
  })

  it('refuses an Arkade asset labelled BTC, which offers.markets reads as bitcoin, and only an Arkade one', () => {
    expect(() => documentToKnobs({ assets: { btc: { kind: 'arkade', assetId: USDA_ID } } })).toThrow(
      'assets.btc: BTC names bitcoin in offers.markets and cannot label an Arkade asset',
    )
    const erc20 = { kind: 'erc20' as const, chain: 'arbitrum', address: USDC, decimals: 8 }
    expect(() => documentToKnobs({ rails: { evm: { arbitrum: {} } }, assets: { 'BTC@arbitrum': erc20 } })).not.toThrow()
  })

  it('refuses an erc20 asset on a chain rails.evm does not name', () => {
    expect(() =>
      documentToKnobs({ assets: { USDC: { kind: 'erc20', chain: 'base', address: USDC, decimals: 6 } } }),
    ).toThrow('assets.USDC.chain: base is not a chain in rails.evm')
  })

  it('resolves offer market labels to asset ids, and passes BTC and raw ids through', () => {
    const { knobs } = documentToKnobs({
      assets: { USDA: { kind: 'arkade', assetId: USDA_ID } },
      offers: { markets: ['BTC/USDA', `BTC/${'ab'.repeat(34)}`] },
    })
    expect(knobs.OFFER_MARKETS).toBe(`BTC/${USDA_ID},BTC/${'ab'.repeat(34)}`)
  })
})

describe('documentToKnobs — rail block', () => {
  it('hands back the block of a registered backend', () => {
    const { railBlock } = documentToKnobs({ rails: { lightning: { backend: 'custom', custom: { mnemonic: 'm' } } } })
    expect(railBlock).toEqual({ mnemonic: 'm' })
  })

  it('has none for a built-in backend', () => {
    expect(documentToKnobs({ rails: { lightning: { backend: 'lnd' } } }).railBlock).toBeNull()
  })
})

describe('renameKnobs', () => {
  const { pathOf } = documentToKnobs(evmDoc())

  it('renames knob ids in an error to JSON paths', () => {
    expect(renameKnobs('LN_SEND_FEE_BPS must be an integer between 0 and 9999, got 10000', pathOf)).toBe(
      'corridors["arkade:BTC->lightning:BTC"].feeBps must be an integer between 0 and 9999, got 10000',
    )
  })

  it('knows every BTC corridor knob, set or not', () => {
    expect(renameKnobs('LN_RECEIVE_MAX_SATS must be set', pathOf)).toBe(
      'corridors["lightning:BTC->arkade:BTC"].maxSats must be set',
    )
  })

  it('never renames part of a longer id', () => {
    expect(renameKnobs('ADMIN_HOST and HOST', pathOf)).toBe('admin.host and http.host')
  })

  it('redacts a secret knob value in a renamed message', () => {
    const renamed = renameKnobs('EVM_RPC_URL must be a URL, got https://x/v2/KEY', pathOf)
    expect(renamed).toBe('rails.evm.arbitrum.rpcUrl must be a URL, got <redacted>')
  })

  it('redacts a secret by its value, wherever the message quotes it', () => {
    const knobs = { EVM_RPC_URL: 'https://x/v2/KEY' }
    expect(renameKnobs('cannot reach https://x/v2/KEY: refused', pathOf, knobs)).toBe(
      'cannot reach <redacted>: refused',
    )
  })
})
