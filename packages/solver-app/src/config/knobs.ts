/**
 * The config document, flattened to the setting ids `config.ts` reads.
 *
 * The ids are the environment variable names the solver used before the
 * document existed. They stay the internal vocabulary because `config.ts`
 * validates by them and console overrides are stored under them; `pathOf`
 * maps each one back to where an operator wrote it.
 */
import { ALL_DESCRIPTORS } from '@arkade-os/solver-corridors/corridors/index.js'
import type { Knobs } from '../config.js'
import { jsonPath, type SolverDocument } from './document.js'

export interface Flattened {
  knobs: Knobs
  /** Setting id to JSON path, for every setting the document could have set — not only those it did. */
  pathOf: ReadonlyMap<string, string>
  /** The selected registered rail's own block; null for a built-in backend. */
  railBlock: unknown | null
}

type Row = readonly [path: string, knob: string, encode?: (value: unknown) => string]

export const PATHS: readonly Row[] = [
  ['network', 'SWAP_NETWORK'],
  ['name', 'SOLVER_NAME'],
  ['rails.arkade.mnemonic', 'ARK_MNEMONIC'],
  ['rails.arkade.serverUrl', 'ARK_SERVER_URL'],
  ['rails.arkade.emulatorUrl', 'EMULATOR_URL'],
  ['rails.arkade.esploraUrl', 'ARK_ESPLORA_URL'],
  ['rails.arkade.unilateralExitDelay', 'ARK_UNILATERAL_EXIT_DELAY'],
  ['rails.arkade.covclaimdUrl', 'COVCLAIMD_URL'],
  ['rails.arkade.poolAutoMint', 'POOL_AUTO_MINT'],
  ['rails.arkade.contractRetentionDays', 'CONTRACT_RETENTION_DAYS'],
  ['rails.lightning.backend', 'LN_BACKEND'],
  ['rails.lightning.lnd.socket', 'LND_SOCKET'],
  ['rails.lightning.lnd.cert', 'LND_CERT'],
  ['rails.lightning.lnd.certPath', 'LND_CERT_PATH'],
  ['rails.lightning.lnd.macaroon', 'LND_MACAROON'],
  ['rails.lightning.lnd.macaroonPath', 'LND_MACAROON_PATH'],
  ['rails.lightning.fake.statePath', 'FAKE_LN_STATE_PATH'],
  ['rails.lightning.lockupTimeoutSeconds', 'LOCKUP_TIMEOUT_SECONDS'],
  ['rails.lightning.sweepConcurrency', 'SWEEP_CONCURRENCY'],
  ['rails.lightning.sendHintScidDenylist', 'LN_SEND_HINT_SCID_DENYLIST'],
  ['rails.lightning.receiveAcceptUnilateralGap', 'LN_RECEIVE_ACCEPT_UNILATERAL_GAP'],
  // The onchain corridors' explorer, whichever rail moves the coins: the name is historical.
  ['rails.onchain.esploraUrl', 'LND_ESPLORA_URL'],
  ['rails.onchain.chainTipEsploraUrl', 'CHAIN_TIP_ESPLORA_URL'],
  ['rails.onchain.feeRateRefreshMs', 'ONCHAIN_FEE_RATE_REFRESH_MS'],
  ['rails.onchain.feeRateStaleMs', 'ONCHAIN_FEE_RATE_STALE_MS'],
  ['limits.maxSwapSats', 'MAX_SWAP_SATS'],
  ['limits.maxExposedSats', 'MAX_EXPOSED_SATS'],
  ['limits.approvalThresholdSats', 'APPROVAL_THRESHOLD_SATS'],
  ['offers.minFillAmount', 'OFFER_MIN_FILL_AMOUNT'],
  ['offers.maxFillAmount', 'OFFER_MAX_FILL_AMOUNT'],
  ['offers.chargeCarrier', 'OFFER_CHARGE_CARRIER'],
  ['offers.carrierPricing', 'ASSET_CARRIER_PRICING'],
  ['offers.quoteValiditySeconds', 'ASSET_QUOTE_VALIDITY_SECONDS'],
  ['relay.url', 'RELAY_URL'],
  ['relay.protocol', 'RELAY_PROTOCOL'],
  ['relay.healthPath', 'RELAY_HEALTH_PATH'],
  ['relay.openRfqMaxBidsPerMinute', 'OPEN_RFQ_MAX_BIDS_PER_MIN'],
  ['relay.adPublish', 'NOSTR_AD_PUBLISH'],
  ['relay.cardRelays', 'SOLVER_CARD_RELAYS'],
  ['storage.dir', 'DB_DIR'],
  ['storage.swapDb', 'SWAP_DB_PATH'],
  ['storage.arkDb', 'ARK_DB_PATH'],
  ['http.host', 'HOST'],
  ['http.port', 'PORT'],
  ['admin.host', 'ADMIN_HOST'],
  ['admin.port', 'ADMIN_PORT'],
  ['admin.restartEnabled', 'ADMIN_RESTART_ENABLED'],
  ['sentry.dsn', 'SENTRY_DSN'],
  ['sentry.environment', 'SENTRY_ENVIRONMENT'],
  ['sentry.release', 'SENTRY_RELEASE'],
  ['notify.telegramBotToken', 'TELEGRAM_BOT_TOKEN'],
  ['notify.telegramChatId', 'TELEGRAM_CHAT_ID'],
  ['notify.slackWebhookUrl', 'SLACK_WEBHOOK_URL'],
  ['notify.balanceReportIntervalMinutes', 'BALANCE_REPORT_INTERVAL_MINUTES'],
  ['diagnostics.latency', 'SOLVER_LATENCY_DIAGNOSTICS', (on) => (on ? '1' : '0')],
]

const EVM_FIELDS: Readonly<Record<string, string>> = {
  chainId: 'EVM_CHAIN_ID',
  rpcUrl: 'EVM_RPC_URL',
  htlcAddress: 'EVM_HTLC_ADDRESS',
  privateKey: 'EVM_PRIVATE_KEY',
  minConfirmations: 'EVM_MIN_CONFIRMATIONS',
  minAgeSeconds: 'EVM_MIN_AGE_SECONDS',
  fastestSecondsPerBlock: 'EVM_FASTEST_SECONDS_PER_BLOCK',
  slowestSecondsPerBlock: 'EVM_SLOWEST_SECONDS_PER_BLOCK',
  timelockFastestSecondsPerBlock: 'EVM_TIMELOCK_FASTEST_SECONDS_PER_BLOCK',
  timelockSlowestSecondsPerBlock: 'EVM_TIMELOCK_SLOWEST_SECONDS_PER_BLOCK',
  gasLimit: 'EVM_GAS_LIMIT',
  maxFeePerGasCeiling: 'EVM_MAX_FEE_PER_GAS_CEILING',
  feeHeadroomSeconds: 'EVM_FEE_HEADROOM_SECONDS',
  orderMarginSeconds: 'EVM_ORDER_MARGIN_SECONDS',
  quoteValiditySeconds: 'EVM_QUOTE_VALIDITY_SECONDS',
  logScanRange: 'EVM_LOG_SCAN_RANGE',
  directClaimsOnly: 'EVM_DIRECT_CLAIMS_ONLY',
}

type Family = 'lightning' | 'onchain send' | 'onchain receive' | 'erc20' | 'Arkade asset'

const COMMON = ['enabled', 'minSats', 'maxSats', 'feeBps', 'feeFlatSats']
const FIELDS: Readonly<Record<Family, readonly string[]>> = {
  lightning: COMMON,
  'onchain send': [...COMMON, 'feeCapSats', 'feeMinSats'],
  'onchain receive': [...COMMON, 'feeCapSats', 'feeMinSats', 'maxBandSats', 'bandBelowShare'],
  erc20: [...COMMON, 'minUnits', 'maxUnits'],
  'Arkade asset': ['enabled'],
}

const SUFFIX: Readonly<Record<string, string>> = {
  enabled: 'ENABLED',
  minSats: 'MIN_SATS',
  maxSats: 'MAX_SATS',
  feeBps: 'FEE_BPS',
  feeFlatSats: 'FEE_FLAT_SATS',
  feeCapSats: 'FEE_CAP_SATS',
  feeMinSats: 'FEE_MIN_SATS',
  minUnits: 'MIN_UNITS',
  maxUnits: 'MAX_UNITS',
}

// Named outright rather than built from a stem: they predate the per-corridor naming.
const ABSOLUTE: Readonly<Record<string, string>> = {
  maxBandSats: 'ONCHAIN_RECEIVE_MAX_BAND_SATS',
  bandBelowShare: 'ONCHAIN_RECEIVE_BAND_BELOW_SHARE',
}

const BTC_FAMILY: Readonly<Record<string, Family>> = {
  'arkade:BTC->lightning:BTC': 'lightning',
  'lightning:BTC->arkade:BTC': 'lightning',
  'arkade:BTC->onchain:BTC': 'onchain send',
  'onchain:BTC->arkade:BTC': 'onchain receive',
}

const BTC_SIDES = new Set(['arkade:BTC', 'lightning:BTC', 'onchain:BTC'])
const LABEL = /^[A-Za-z0-9@._-]{1,32}$/
const SYMBOL = /^[A-Z][A-Z0-9]{0,11}$/

const encode = (value: unknown): string => (Array.isArray(value) ? value.join(',') : String(value))

const at = (doc: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], doc)

interface Asset {
  label: string
  symbol: string
  kind: 'erc20' | 'arkade'
}

const article = (family: Family): string => (/^[aeiouA]/.test(family) ? 'an' : 'a')

export const documentToKnobs = (doc: SolverDocument): Flattened => {
  const knobs: Record<string, string> = {}
  const pathOf = new Map<string, string>()
  const set = (knob: string, path: string, value: unknown, as: (value: unknown) => string = encode): void => {
    pathOf.set(knob, path)
    if (value !== undefined && value !== null) knobs[knob] = as(value)
  }

  for (const [path, knob, as] of PATHS) set(knob, path, at(doc, path), as)

  const chains = Object.entries(doc.rails?.evm ?? {})
  for (const [chain, fields] of chains) {
    for (const [field, knob] of Object.entries(EVM_FIELDS)) {
      set(knob, jsonPath(['rails', 'evm', chain, field]), (fields as Record<string, unknown>)[field])
    }
  }

  const assets = new Map<string, Asset>()
  const evmTokens: string[] = []
  const arkadeTokens: string[] = []
  const bySymbol = new Map<string, string>()
  for (const [label, asset] of Object.entries(doc.assets ?? {})) {
    const here = jsonPath(['assets', label])
    if (!LABEL.test(label) || label.includes('->')) {
      throw new Error(`${here}: label may hold only letters, digits, @ . _ -`)
    }
    const symbol = label.split('@')[0]!.toUpperCase()
    if (!SYMBOL.test(symbol)) throw new Error(`${here}: label must start with a 1-12 character symbol`)
    const taken = bySymbol.get(`${asset.kind}:${symbol}`)
    if (taken !== undefined) throw new Error(`assets: ${taken} and ${label} share the symbol ${symbol}`)
    bySymbol.set(`${asset.kind}:${symbol}`, label)
    assets.set(label, { label, symbol, kind: asset.kind })

    if (asset.kind === 'erc20') {
      if (!chains.some(([chain]) => chain === asset.chain)) {
        throw new Error(`${jsonPath(['assets', label, 'chain'])}: ${asset.chain} is not a chain in rails.evm`)
      }
      evmTokens.push(`${symbol}:${asset.address}:${asset.decimals}`)
      set(`EVM_${symbol}_PRICE_FEED`, jsonPath(['assets', label, 'priceFeed']), asset.priceFeed)
      set(`EVM_${symbol}_PRICE_PATH`, jsonPath(['assets', label, 'pricePath']), asset.pricePath)
    } else {
      arkadeTokens.push(`${symbol}:${asset.assetId}`)
      set(
        `ASSET_${symbol}_APPROVAL_THRESHOLD`,
        jsonPath(['assets', label, 'approvalThreshold']),
        asset.approvalThreshold,
      )
    }
  }
  set('EVM_TOKENS', 'assets', evmTokens.length > 0 ? evmTokens : undefined)
  set('ASSET_MARKETS', 'assets', arkadeTokens.length > 0 ? arkadeTokens : undefined)

  // Every corridor's settings are knowable before any is written, so each id maps to a path even when unset.
  const stems = new Map<string, { stem: string; family: Family }>()
  for (const { pair, envStem } of ALL_DESCRIPTORS) stems.set(pair, { stem: envStem, family: BTC_FAMILY[pair]! })
  for (const { label, symbol, kind } of assets.values()) {
    const family: Family = kind === 'erc20' ? 'erc20' : 'Arkade asset'
    const send = kind === 'erc20' ? `EVM_SEND_${symbol}` : `ASSET_${symbol}_FROM_BTC`
    const receive = kind === 'erc20' ? `EVM_RECEIVE_${symbol}` : `ASSET_${symbol}_TO_BTC`
    stems.set(`arkade:BTC->${label}`, { stem: send, family })
    stems.set(`${label}->arkade:BTC`, { stem: receive, family })
  }
  const knobOf = (stem: string, field: string): string => ABSOLUTE[field] ?? `${stem}_${SUFFIX[field]}`
  for (const [pair, { stem, family }] of stems) {
    for (const field of FIELDS[family]) pathOf.set(knobOf(stem, field), jsonPath(['corridors', pair, field]))
  }

  for (const [pair, terms] of Object.entries(doc.corridors ?? {})) {
    const here = jsonPath(['corridors', pair])
    const corridor = stems.get(pair)
    if (corridor === undefined) {
      const unknown = pair.split('->').find((side) => !BTC_SIDES.has(side) && !assets.has(side))
      throw new Error(
        unknown === undefined
          ? `${here}: no corridor serves this pair`
          : `${here}: ${unknown} is neither a BTC rail nor an asset in assets`,
      )
    }
    for (const [field, value] of Object.entries(terms)) {
      if (!FIELDS[corridor.family].includes(field)) {
        throw new Error(
          `${jsonPath(['corridors', pair, field])}: not valid on ${article(corridor.family)} ${corridor.family} corridor`,
        )
      }
      set(knobOf(corridor.stem, field), jsonPath(['corridors', pair, field]), value)
    }
  }

  const markets = doc.offers?.markets?.map((market) =>
    market
      .split('/')
      .map((leg) => {
        const asset = doc.assets?.[leg]
        return asset?.kind === 'arkade' ? asset.assetId : leg
      })
      .join('/'),
  )
  set('OFFER_MARKETS', 'offers.markets', markets)

  const backend = doc.rails?.lightning?.backend
  const railBlock =
    backend === undefined || backend === 'lnd' || backend === 'fake' ? null : (doc.rails?.lightning?.[backend] ?? null)
  return { knobs, pathOf, railBlock }
}

/** Settings whose value is a credential: an error naming one never repeats what was written. */
export const SECRET_KNOBS: ReadonlySet<string> = new Set([
  'ARK_MNEMONIC',
  'LND_CERT',
  'LND_MACAROON',
  'EVM_PRIVATE_KEY',
  'EVM_RPC_URL',
  'SENTRY_DSN',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
])

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const renameKnobs = (message: string, pathOf: ReadonlyMap<string, string>): string => {
  const ids = [...pathOf.keys()].sort((a, b) => b.length - a.length)
  if (ids.length === 0) return message
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${ids.map(escape).join('|')})(?![A-Za-z0-9_])`, 'g')
  const secret = [...message.matchAll(pattern)].some((match) => SECRET_KNOBS.has(match[1]!))
  const renamed = message.replace(pattern, (id) => pathOf.get(id) ?? id)
  return secret ? renamed.replace(/\bgot\b[\s\S]*$/, 'got <redacted>') : renamed
}
