import { describe, it, expect } from 'vitest'
import type { LightningRail, LightningRailModule } from '@arkade-os/solver-app/index.js'
import { registerLightningRail } from '@arkade-os/solver-app/ops/rails.js'
import { loadConfig, type LoadOptions } from '@arkade-os/solver-app/config/load.js'
import {
  applyOverrides,
  editableKnobValues,
  exportDocument,
  UnexportableConfig,
} from '@arkade-os/solver-app/admin/settings.js'

const RAIL = 'example-rail'
registerLightningRail(RAIL, {
  create: async (): Promise<LightningRail> => {
    throw new Error('never built here')
  },
  mintPayeeInvoice: async () => 'lnbcrt1example',
} satisfies LightningRailModule)

const LN_SEND = 'arkade:BTC->lightning:BTC'
const ONCHAIN_SEND = 'arkade:BTC->onchain:BTC'
const MNEMONIC = 'secret mnemonic words, never a real one'

const base = () => ({
  network: 'regtest',
  rails: {
    arkade: { mnemonic: MNEMONIC, operatorUrl: 'http://localhost:7070', emulatorUrl: 'http://localhost:7073' },
    lightning: { backend: 'fake' },
  },
  corridors: { [LN_SEND]: { feeBps: 10, minSats: 1_000, maxSats: 100_000 } },
})

const evmChain = (rpcUrl: string, privateKey: string) => ({
  chainId: 8453,
  rpcUrl,
  htlcAddress: `0x${'1'.repeat(40)}`,
  privateKey,
  minConfirmations: 12,
  minAgeSeconds: 720,
  fastestSecondsPerBlock: 0.25,
  slowestSecondsPerBlock: 1,
  timelockFastestSecondsPerBlock: 0.25,
  timelockSlowestSecondsPerBlock: 1,
  gasLimit: '300000',
  maxFeePerGasCeiling: '5000000000',
  feeHeadroomSeconds: 600,
  orderMarginSeconds: 7200,
  quoteValiditySeconds: 60,
  logScanRange: 5000,
})

const load = (doc: unknown, profile?: LoadOptions['profile']) =>
  loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(doc) }, profile })

const withMnemonic = (exported: unknown): unknown =>
  JSON.parse(JSON.stringify(exported).replace('"<RAILS_ARKADE_MNEMONIC>"', JSON.stringify(MNEMONIC)))

describe('exportDocument', () => {
  it('writes each stored override where the document holds it, as the type the document takes', () => {
    const exported = exportDocument(load(base()), { LN_SEND_FEE_BPS: '25', MAX_EXPOSED_SATS: '500000' }) as ReturnType<
      typeof base
    > & { limits: { maxExposedSats: number } }
    expect(exported.corridors[LN_SEND]).toEqual({ feeBps: 25, minSats: 1_000, maxSats: 100_000, enabled: true })
    expect(exported.limits.maxExposedSats).toBe(500_000)
  })

  it('boots to the settings the console shows', () => {
    const config = load(base())
    const overrides = {
      LN_SEND_FEE_FLAT_SATS: '7',
      LN_SEND_MIN_SATS: '200000',
      LN_RECEIVE_ENABLED: 'false',
      LN_RECEIVE_MAX_SATS: '90000',
      ONCHAIN_SEND_FEE_BPS: '30',
      LOCKUP_TIMEOUT_SECONDS: '900',
      ASSET_CARRIER_PRICING: 'true',
    }
    const reloaded = load(withMnemonic(exportDocument(config, overrides)))
    expect(editableKnobValues(reloaded)).toEqual(editableKnobValues(applyOverrides(config, overrides)))
    expect(reloaded.corridorEnabled[ONCHAIN_SEND]).toBe(false)
  })

  it('boots to the console’s settings from a document with no Lightning rail and no corridors', () => {
    const { lightning: _none, ...rails } = base().rails
    const config = load({ network: 'regtest', rails })
    const overrides = { LN_SEND_FEE_BPS: '25', LOCKUP_TIMEOUT_SECONDS: '900', ASSET_CARRIER_PRICING: 'true' }
    const reloaded = load(withMnemonic(exportDocument(config, overrides)))
    expect(editableKnobValues(reloaded)).toEqual(editableKnobValues(applyOverrides(config, overrides)))
    expect(reloaded.lnBackend).toBe(config.lnBackend)
  })

  it('refuses a corridor range the console widened past what a file can hold', () => {
    const exporting = () => exportDocument(load(base()), { LN_SEND_MAX_SATS: '2000000', LN_SEND_FEE_BPS: '25' })
    expect(exporting).toThrow(UnexportableConfig)
    expect(exporting).toThrow(`corridors["${LN_SEND}"].maxSats is 2000000 here but would load as 1000000`)
  })

  it('refuses, with the loader’s reason, a range a file would not load at all', () => {
    const exporting = () => exportDocument(load(base()), { LN_SEND_MIN_SATS: '1500000', LN_SEND_MAX_SATS: '2000000' })
    expect(exporting).toThrow(UnexportableConfig)
    expect(exporting).toThrow(/cannot hold what this console runs: .*empty/)
  })

  it('writes nothing an override does not move', () => {
    const exported = exportDocument(load(base()), {
      LN_SEND_FEE_BPS: '10',
      LN_RECEIVE_FEE_BPS: 'not a number',
      REBALANCE_POLICY: '{"enabled":true}',
    })
    expect(withMnemonic(exported)).toEqual(base())
  })

  it('leaves the document the solver booted from untouched', () => {
    const config = load(base())
    exportDocument(config, { LN_SEND_FEE_BPS: '25', ONCHAIN_SEND_FEE_BPS: '30' })
    expect(config.configDocument).toEqual(base())
  })

  it('exports the document as written, not as a profile rewrote it', () => {
    const profile: LoadOptions['profile'] = (doc) => {
      if (doc.name !== undefined) throw new Error('the profile names the solver itself')
      return { ...doc, name: 'from-profile' }
    }
    const exported = withMnemonic(exportDocument(load(base(), profile), { LN_SEND_FEE_BPS: '25' }))
    expect(exported).not.toHaveProperty('name')
    expect(load(exported, profile).corridorFees[LN_SEND].bps).toBe(25)
  })

  it('puts a placeholder the loader refuses in place of every credential', () => {
    const secrets = {
      'rails.lightning.lnd.cert': 'secret-lnd-certificate',
      'rails.lightning.lnd.macaroon': 'secret-lnd-macaroon',
      'rails.evm.base.rpcUrl': 'https://rpc.example/v2/secret-evm-path-key',
      'rails.evm.base.privateKey': `${'5ec7e7'.repeat(10)}abcd`,
      'assets.USDC@base.priceFeed': 'https://feed.example/v1/secret-feed-path-key/price',
      'notify.slackWebhookUrl': 'https://hooks.example/services/secret-slack-path',
      'notify.telegramBotToken': 'secret-telegram-token',
      'sentry.dsn': 'https://secretdsnkey@sentry.example/1',
      'relay.url': 'wss://relay.example/?auth=secret-relay-query',
      'rails.lightning.example-rail.apiKey': 'secret-rail-key',
      'rails.lightning.example-rail.rpcUrl': 'https://rpc.example/v2/secret-rail-path-key',
    }
    const doc = {
      ...base(),
      rails: {
        ...base().rails,
        lightning: {
          backend: RAIL,
          lnd: { cert: secrets['rails.lightning.lnd.cert'], macaroon: secrets['rails.lightning.lnd.macaroon'] },
          [RAIL]: {
            apiKey: secrets['rails.lightning.example-rail.apiKey'],
            rpcUrl: secrets['rails.lightning.example-rail.rpcUrl'],
            apiToken: 987_654_321,
            region: 'eu',
          },
        },
        evm: { base: evmChain(secrets['rails.evm.base.rpcUrl'], secrets['rails.evm.base.privateKey']) },
      },
      assets: {
        'USDC@base': {
          kind: 'erc20',
          chain: 'base',
          address: `0x${'2'.repeat(40)}`,
          decimals: 6,
          priceFeed: secrets['assets.USDC@base.priceFeed'],
          pricePath: '/price',
        },
      },
      notify: {
        slackWebhookUrl: secrets['notify.slackWebhookUrl'],
        telegramBotToken: secrets['notify.telegramBotToken'],
        telegramChatId: '12345',
      },
      sentry: { dsn: secrets['sentry.dsn'] },
      relay: { url: secrets['relay.url'] },
    }
    const exported = exportDocument(load(doc), {})
    const text = JSON.stringify(exported)
    for (const value of [MNEMONIC, ...Object.values(secrets), '987654321']) expect(text).not.toContain(value)
    expect(exported).toMatchObject({
      rails: {
        arkade: { mnemonic: '<RAILS_ARKADE_MNEMONIC>', operatorUrl: 'http://localhost:7070' },
        lightning: {
          lnd: { cert: '<RAILS_LIGHTNING_LND_CERT>' },
          [RAIL]: {
            apiKey: '<RAILS_LIGHTNING_EXAMPLE_RAIL_API_KEY>',
            rpcUrl: '<RAILS_LIGHTNING_EXAMPLE_RAIL_RPC_URL>',
            apiToken: '<RAILS_LIGHTNING_EXAMPLE_RAIL_API_TOKEN>',
            region: 'eu',
          },
        },
        evm: { base: { rpcUrl: '<RAILS_EVM_BASE_RPC_URL>', chainId: 8453 } },
      },
      assets: { 'USDC@base': { priceFeed: '<ASSETS_USDC_BASE_PRICE_FEED>', decimals: 6 } },
      notify: { slackWebhookUrl: '<NOTIFY_SLACK_WEBHOOK_URL>', telegramChatId: '12345' },
      relay: { url: '<RELAY_URL>' },
    })
    expect(() => load(exported)).toThrow(/still holds .*<RAILS_ARKADE_MNEMONIC>/)
  })

  it('redacts an EVM chain the written document holds even when a profile dropped it', () => {
    const rpcUrl = 'https://rpc.example/v2/secret-profiled-away-key'
    const doc = { ...base(), rails: { ...base().rails, evm: { mine: evmChain(rpcUrl, '7'.repeat(64)) } } }
    const withoutEvm: LoadOptions['profile'] = ({ rails: { evm: _evm, ...rails } = {}, ...rest }) => ({
      ...rest,
      rails,
    })
    const exported = exportDocument(load(doc, withoutEvm), {})
    expect(JSON.stringify(exported)).not.toContain(rpcUrl)
    expect(exported).toMatchObject({ rails: { evm: { mine: { rpcUrl: '<RAILS_EVM_MINE_RPC_URL>' } } } })
  })
})
