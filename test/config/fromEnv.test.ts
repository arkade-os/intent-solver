import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configFromKnobs, type Config } from '@arkade-os/solver-app/config.js'
import { loadConfig } from '@arkade-os/solver-app/config/load.js'
import { envToDocument, exportConfig } from '@arkade-os/solver-app/config/fromEnv.js'
import { AdminStore } from '@arkade-os/solver-app/admin/db.js'
import { resolveLimits } from '@arkade-os/solver-core/core/limits.js'
import { DEFAULT_SERVING } from '@arkade-os/solver-core/core/assetMarketConfig.js'

const limits = resolveLimits('regtest')
const USDA = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const inside = { MIN_SATS: String(limits.minSats + 1), MAX_SATS: String(limits.maxSats - 1) }

const corridor = (stem: string, extra: Record<string, string> = {}) => ({
  [`${stem}_ENABLED`]: 'true',
  [`${stem}_MIN_SATS`]: inside.MIN_SATS,
  [`${stem}_MAX_SATS`]: inside.MAX_SATS,
  [`${stem}_FEE_BPS`]: '10',
  [`${stem}_FEE_FLAT_SATS`]: '5',
  ...Object.fromEntries(Object.entries(extra).map(([suffix, value]) => [`${stem}_${suffix}`, value])),
})

/** Every setting the solver reads, each set to a value it accepts. */
const FULL_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  SOLVER_NAME: 'full-solver',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  ARK_ESPLORA_URL: 'http://localhost:3000/api',
  ARK_UNILATERAL_EXIT_DELAY: '260096',
  COVCLAIMD_URL: 'http://localhost:7080',
  POOL_AUTO_MINT: 'true',
  CONTRACT_RETENTION_DAYS: '14',
  LN_BACKEND: 'lnd',
  LND_SOCKET: 'lnd:10009',
  LND_CERT: 'Y2VydA==',
  LND_MACAROON: 'bWFj',
  FAKE_LN_STATE_PATH: '/data/fake-ln.json',
  LOCKUP_TIMEOUT_SECONDS: '600',
  SWEEP_CONCURRENCY: '4',
  LN_SEND_HINT_SCID_DENYLIST: '0123456789abcdef,fedcba9876543210',
  LN_RECEIVE_ACCEPT_UNILATERAL_GAP: 'true',
  LND_ESPLORA_URL: 'http://localhost:3000/api',
  CHAIN_TIP_ESPLORA_URL: 'http://localhost:3001/api',
  ONCHAIN_FEE_RATE_REFRESH_MS: '30000',
  ONCHAIN_FEE_RATE_STALE_MS: '600000',
  MAX_SWAP_SATS: String(limits.maxSats),
  MAX_EXPOSED_SATS: '9000000',
  APPROVAL_THRESHOLD_SATS: '100000',
  ...corridor('LN_SEND'),
  ...corridor('LN_RECEIVE'),
  ...corridor('ONCHAIN_SEND', { FEE_CAP_SATS: '20000', FEE_MIN_SATS: '500' }),
  ...corridor('ONCHAIN_RECEIVE', { FEE_CAP_SATS: '20000', FEE_MIN_SATS: '500' }),
  ONCHAIN_RECEIVE_MAX_BAND_SATS: '1000',
  ONCHAIN_RECEIVE_BAND_BELOW_SHARE: '0.5',
  OFFER_MARKETS: `BTC/${USDA}`,
  OFFER_MIN_FILL_AMOUNT: '1000',
  OFFER_MAX_FILL_AMOUNT: '5000000',
  OFFER_CHARGE_CARRIER: 'true',
  ASSET_CARRIER_PRICING: 'true',
  ASSET_QUOTE_VALIDITY_SECONDS: '45',
  ASSET_MARKETS: `USDA:${USDA}`,
  ASSET_USDA_APPROVAL_THRESHOLD: '250000000',
  EVM_TOKENS: `USDC:${USDC}:6`,
  EVM_RPC_URL: 'http://localhost:8545',
  EVM_HTLC_ADDRESS: '0x1111111111111111111111111111111111111111',
  EVM_CHAIN_ID: '42161',
  EVM_PRIVATE_KEY: '22'.repeat(32),
  EVM_MIN_CONFIRMATIONS: '12',
  EVM_MIN_AGE_SECONDS: '720',
  EVM_FASTEST_SECONDS_PER_BLOCK: '0.25',
  EVM_SLOWEST_SECONDS_PER_BLOCK: '1',
  EVM_TIMELOCK_FASTEST_SECONDS_PER_BLOCK: '0.25',
  EVM_TIMELOCK_SLOWEST_SECONDS_PER_BLOCK: '1',
  EVM_GAS_LIMIT: '300000',
  EVM_MAX_FEE_PER_GAS_CEILING: '5000000000',
  EVM_FEE_HEADROOM_SECONDS: '600',
  EVM_ORDER_MARGIN_SECONDS: '7200',
  EVM_QUOTE_VALIDITY_SECONDS: '60',
  EVM_LOG_SCAN_RANGE: '5000',
  EVM_DIRECT_CLAIMS_ONLY: 'true',
  EVM_USDC_PRICE_FEED: 'http://localhost:9000/btc-usdc',
  EVM_USDC_PRICE_PATH: '/price',
  ...corridor('EVM_SEND_USDC', { MIN_UNITS: '1000000', MAX_UNITS: '1000000000' }),
  EVM_RECEIVE_USDC_ENABLED: 'false',
  EVM_RECEIVE_USDC_MIN_UNITS: '2000000',
  EVM_RECEIVE_USDC_MAX_UNITS: '2000000000',
  RELAY_URL: 'wss://relay.example',
  RELAY_PROTOCOL: 'dev',
  RELAY_HEALTH_PATH: '/data/relay-health',
  OPEN_RFQ_MAX_BIDS_PER_MIN: '10',
  NOSTR_AD_PUBLISH: 'manual',
  SOLVER_CARD_RELAYS: 'wss://a.example, wss://b.example',
  DB_DIR: '/data',
  SWAP_DB_PATH: '/data/swaps.sqlite',
  ARK_DB_PATH: '/data/ark.sqlite',
  HOST: '0.0.0.0',
  PORT: '9787',
  ADMIN_HOST: '0.0.0.0',
  ADMIN_PORT: '9788',
  ADMIN_RESTART_ENABLED: 'true',
  SENTRY_DSN: 'https://key@o0.ingest.sentry.io/1',
  SENTRY_ENVIRONMENT: 'staging',
  SENTRY_RELEASE: '1.2.3',
  TELEGRAM_BOT_TOKEN: 'bot-token',
  TELEGRAM_CHAT_ID: '42',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X',
  BALANCE_REPORT_INTERVAL_MINUTES: '60',
  SOLVER_LATENCY_DIAGNOSTICS: '1',
}

const MINIMAL_ENV = {
  SWAP_NETWORK: 'mutinynet',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'https://mutinynet.arkade.sh',
  EMULATOR_URL: 'https://emulator.example',
  LN_BACKEND: 'fake',
}

const withoutDocumentFields = ({ configPaths: _paths, lightningRailBlock: _block, ...rest }: Config) => rest

const loadedFrom = (doc: unknown) => loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(doc) } })

describe('envToDocument round-trips', () => {
  it('every setting the environment can carry', () => {
    const doc = envToDocument(FULL_ENV, [])
    expect(withoutDocumentFields(loadedFrom(doc))).toEqual(withoutDocumentFields(configFromKnobs(FULL_ENV)))
  })

  it('a minimal mutinynet environment', () => {
    const doc = envToDocument(MINIMAL_ENV, [])
    expect(withoutDocumentFields(loadedFrom(doc))).toEqual(withoutDocumentFields(configFromKnobs(MINIMAL_ENV)))
  })
})

describe('envToDocument — what it writes', () => {
  it('labels assets by symbol, and an erc20 by its chain', () => {
    const doc = envToDocument(FULL_ENV, [])
    expect(Object.keys(doc.assets ?? {}).sort()).toEqual(['USDA', 'USDC@arbitrum'])
    expect(Object.keys(doc.rails?.evm ?? {})).toEqual(['arbitrum'])
    expect(doc.offers?.markets).toEqual(['BTC/USDA'])
  })

  it('names a chain it does not know evm', () => {
    const doc = envToDocument({ ...MINIMAL_ENV, EVM_RPC_URL: 'http://x', EVM_CHAIN_ID: '777' }, [])
    expect(Object.keys(doc.rails?.evm ?? {})).toEqual(['evm'])
  })

  it('maps an LND secret given as a path', () => {
    const doc = envToDocument({ LND_CERT_PATH: '/secrets/tls.cert', LND_MACAROON_PATH: '/secrets/m' }, [])
    expect(doc.rails?.lightning?.lnd).toEqual({ certPath: '/secrets/tls.cert', macaroonPath: '/secrets/m' })
  })

  it('omits what is unset, and what is set but blank', () => {
    expect(envToDocument({ SWAP_NETWORK: 'regtest', RELAY_URL: '  ' }, [])).toEqual({ network: 'regtest' })
  })
})

describe('envToDocument — the old direction names, against the stored rows', () => {
  const env = { ...MINIMAL_ENV, ASSET_MARKETS: `USDA:${USDA}`, ASSET_USDA_BUY_ENABLED: 'false' }

  it('reads _BUY as the client giving BTC when BTC is the base', () => {
    expect(envToDocument(env, [{ base: null, quote: USDA }]).corridors).toEqual({
      'arkade:BTC->USDA': { enabled: false },
    })
  })

  it('reads _BUY as the client giving the asset when the asset is the base', () => {
    expect(envToDocument(env, [{ base: USDA, quote: null }]).corridors).toEqual({
      'USDA->arkade:BTC': { enabled: false },
    })
  })

  // A data volume left unmounted reads as no rows, and dropping the flag would reopen the direction.
  it('refuses them where no row carries the asset, naming where it looked', () => {
    expect(() => envToDocument(env, [], '/data/swaps-admin.sqlite')).toThrow(
      'ASSET_USDA_BUY_ENABLED is set, but no market row in /data/swaps-admin.sqlite carries USDA',
    )
  })

  it('exports an asset no row carries yet when no direction was set', () => {
    expect(envToDocument({ ...env, ASSET_USDA_BUY_ENABLED: undefined }, []).assets?.USDA).toMatchObject({
      kind: 'arkade',
    })
  })
})

describe('exportConfig', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the stored rows from the deployment database, and prints a document the loader accepts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solver-export-'))
    dirs.push(dir)
    const store = await AdminStore.open(join(dir, 'swaps.sqlite'))
    await store.putMarket({
      ...DEFAULT_SERVING,
      base: null,
      quote: USDA,
      symbol: 'USDA',
      baseDecimals: 8,
      quoteDecimals: 6,
      feedUrl: 'https://feed.test/p',
      pricePath: '/p',
      toleranceBps: 10,
      feeBps: 25,
      sellBase: null,
      buyBase: null,
      enabled: true,
    })
    await store.close()
    const printed = await exportConfig({
      ...MINIMAL_ENV,
      DB_DIR: dir,
      ASSET_MARKETS: `USDA:${USDA}`,
      ASSET_USDA_BUY_ENABLED: 'false',
    })
    const doc = JSON.parse(printed)
    expect(doc.corridors).toEqual({ 'arkade:BTC->USDA': { enabled: false } })
    expect(loadedFrom(doc).network).toBe('mutinynet')
  })

  it('creates no database where there is none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solver-export-'))
    dirs.push(dir)
    await exportConfig({ ...MINIMAL_ENV, DB_DIR: join(dir, 'absent') })
    expect(() => rmSync(join(dir, 'absent'))).toThrow()
  })

  it('refuses an environment the solver would refuse, in JSON paths', async () => {
    await expect(exportConfig({ ...MINIMAL_ENV, LN_SEND_FEE_BPS: '10000' })).rejects.toThrow(
      'corridors["arkade:BTC->lightning:BTC"].feeBps must be an integer between 0 and 9999',
    )
  })
})
