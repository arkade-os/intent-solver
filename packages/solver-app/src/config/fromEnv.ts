/**
 * The config document for an environment written the old way: the migration
 * path, printed by `cli config-from-env`. The inverse of `knobs.ts`.
 */
import { existsSync } from 'node:fs'
import { z } from 'zod'
import { ALL_DESCRIPTORS } from '@arkade-os/solver-corridors/corridors/index.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { resolveDbLayout } from '@arkade-os/solver-corridors/db/layout.js'
import { parseEvmTokens } from '@arkade-os/solver-core/core/evmCorridorConfig.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import { swapDbPath } from '../config.js'
import { parseAssetRfqTokens } from '../ops/assetRfqMarkets.js'
import { lightningRailFor } from '../ops/rails.js'
import { DECIMAL, documentSchema, type SolverDocument } from './document.js'
import { BTC_FAMILY, CORRIDOR_FIELDS, corridorKnob, EVM_FIELDS, PATHS } from './knobs.js'
import { loadConfig, type LoadOptions } from './load.js'

/** The two legs of a stored market row; null is BTC. */
export interface MarketPair {
  base: string | null
  quote: string | null
}

const CHAIN_LABELS: Readonly<Record<string, string>> = { '1': 'ethereum', '42161': 'arbitrum', '8453': 'base' }

const SCHEMA = documentSchema([]) as z.ZodTypeAny

const unwrap = (schema: z.ZodTypeAny): z.ZodTypeAny => {
  if (schema.description === DECIMAL) return schema
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return unwrap(schema.unwrap())
  if (schema instanceof z.ZodEffects) return unwrap(schema.innerType())
  return schema
}

const schemaAt = (segments: readonly string[]): z.ZodTypeAny =>
  segments.reduce((schema, key) => {
    const node = unwrap(schema)
    if (node instanceof z.ZodRecord) return node.valueSchema as z.ZodTypeAny
    if (node instanceof z.ZodObject) return (node.shape[key] ?? node._def.catchall) as z.ZodTypeAny
    throw new Error(`no schema at ${segments.join('.')}`)
  }, SCHEMA)

/** A raw environment string as the value the document holds at that path. An unparseable one stays a string, so the schema names it. */
const decodeAt = (segments: readonly string[], raw: string): unknown => {
  const schema = unwrap(schemaAt(segments))
  if (schema.description === DECIMAL || schema instanceof z.ZodString) return raw
  if (schema instanceof z.ZodNumber) return Number.isFinite(Number(raw)) ? Number(raw) : raw
  if (schema instanceof z.ZodBoolean) return raw === 'true' ? true : raw === 'false' ? false : raw
  if (schema instanceof z.ZodArray) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return raw
}

const setAt = (doc: Record<string, unknown>, segments: readonly string[], value: unknown): void => {
  let node = doc
  for (const key of segments.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>
  node[segments.at(-1)!] = value
}

export const envToDocument = (
  env: NodeJS.ProcessEnv,
  rows: readonly MarketPair[],
  where = 'the admin database',
): SolverDocument => {
  // Set-but-blank is unset, the discipline every reader applies.
  const read = (name: string): string | undefined => env[name]?.trim() || undefined
  const doc: Record<string, unknown> = {}
  const put = (segments: readonly string[], raw: string | undefined): void => {
    if (raw !== undefined) setAt(doc, segments, decodeAt(segments, raw))
  }

  for (const [path, knob, encode] of PATHS) {
    const raw = read(knob)
    if (raw === undefined) continue
    const segments = path.split('.')
    setAt(doc, segments, encode ? encode(true) === raw : decodeAt(segments, raw))
  }

  const backend = read('LN_BACKEND')
  const railBlock = backend === undefined ? undefined : lightningRailFor(backend)?.legacyEnv?.toBlock(env)
  if (railBlock !== undefined) setAt(doc, ['rails', 'lightning', backend!], railBlock)

  for (const { pair, envStem } of ALL_DESCRIPTORS) {
    for (const field of CORRIDOR_FIELDS[BTC_FAMILY[pair]!]) {
      put(['corridors', pair, field], read(corridorKnob(envStem, field)))
    }
  }

  const chain = CHAIN_LABELS[read('EVM_CHAIN_ID') ?? ''] ?? 'evm'
  for (const [field, knob] of Object.entries(EVM_FIELDS)) put(['rails', 'evm', chain, field], read(knob))
  for (const token of parseEvmTokens(read('EVM_TOKENS'))) {
    const label = `${token.symbol}@${chain}`
    if (!(doc.rails as { evm?: object } | undefined)?.evm) setAt(doc, ['rails', 'evm', chain], {})
    setAt(doc, ['assets', label], {
      kind: 'erc20',
      chain,
      address: token.address,
      decimals: token.decimals,
      ...(read(`EVM_${token.symbol}_PRICE_FEED`) ? { priceFeed: read(`EVM_${token.symbol}_PRICE_FEED`) } : {}),
      ...(read(`EVM_${token.symbol}_PRICE_PATH`) ? { pricePath: read(`EVM_${token.symbol}_PRICE_PATH`) } : {}),
    })
    for (const [stem, pair] of [
      [`EVM_SEND_${token.symbol}`, `arkade:BTC->${label}`],
      [`EVM_RECEIVE_${token.symbol}`, `${label}->arkade:BTC`],
    ] as const) {
      for (const field of CORRIDOR_FIELDS.erc20) put(['corridors', pair, field], read(corridorKnob(stem, field)))
    }
  }

  const labelOf = new Map<string, string>()
  for (const token of parseAssetRfqTokens(read('ASSET_MARKETS'), () => undefined)) {
    const { symbol, assetId } = token
    labelOf.set(assetId, symbol)
    const threshold = read(`ASSET_${symbol}_APPROVAL_THRESHOLD`)
    setAt(doc, ['assets', symbol], { kind: 'arkade', assetId, ...(threshold ? { approvalThreshold: threshold } : {}) })
    put(['corridors', `${symbol}->arkade:BTC`, 'enabled'], read(`ASSET_${symbol}_TO_BTC_ENABLED`))
    put(['corridors', `arkade:BTC->${symbol}`, 'enabled'], read(`ASSET_${symbol}_FROM_BTC_ENABLED`))
    // The old names were row-relative: `_BUY` is sell_base, the client giving the BASE.
    const row = rows.find(
      (candidate) => (candidate.base ?? candidate.quote) === assetId && !(candidate.base && candidate.quote),
    )
    if (row === undefined) {
      const placed = ['BUY', 'SELL'].map((suffix) => `ASSET_${symbol}_${suffix}_ENABLED`).filter((name) => read(name))
      if (placed.length > 0) {
        throw new Error(
          `${placed.join(' and ')} ${placed.length > 1 ? 'are' : 'is'} set, but no market row in ${where} carries ` +
            `${symbol}: export with the deployment's data volume mounted, or unset it and set the direction in the document`,
        )
      }
      continue
    }
    const assetIsBase = row.base === assetId
    for (const [suffix, givesBase] of [
      ['BUY', true],
      ['SELL', false],
    ] as const) {
      const givesAsset = givesBase === assetIsBase
      put(
        ['corridors', givesAsset ? `${symbol}->arkade:BTC` : `arkade:BTC->${symbol}`, 'enabled'],
        read(`ASSET_${symbol}_${suffix}_ENABLED`),
      )
    }
  }

  const markets = read('OFFER_MARKETS')
  if (markets !== undefined) {
    setAt(
      doc,
      ['offers', 'markets'],
      markets.split(',').map((market) =>
        market
          .trim()
          .split('/')
          .map((leg) => labelOf.get(leg) ?? leg)
          .join('/'),
      ),
    )
  }
  return doc as SolverDocument
}

/** Each stored row's legs, read without opening the store, whose open migrates the schema. */
const storedPairs = async (path: string): Promise<MarketPair[]> => {
  if (!existsSync(path)) return []
  const driver = betterSqliteDriver(path)
  try {
    return await driver.all<MarketPair>('SELECT base, quote FROM admin_market')
  } catch (error) {
    if (/no such table/.test(messageOf(error))) return []
    throw error
  } finally {
    await driver.close()
  }
}

/** The document for this environment, checked by the loader that will read it, with the deployment's profile. */
export const exportConfig = async (env: NodeJS.ProcessEnv, profile?: LoadOptions['profile']): Promise<string> => {
  const admin = resolveDbLayout(swapDbPath(env)).admin
  const doc = envToDocument(env, await storedPairs(admin), admin)
  loadConfig({ env: { SOLVER_CONFIG_JSON: JSON.stringify(doc) }, profile })
  return JSON.stringify(doc, null, 2)
}

const IMAGE_HEALTH_PATHS = ['/data/relay-health', '.data/relay-health']

/** The image's HEALTHCHECK read RELAY_HEALTH_PATH; it now reads a fixed path, so a custom one goes unwatched. */
export const healthPathNote = (env: NodeJS.ProcessEnv): string | null => {
  const path = env.RELAY_HEALTH_PATH?.trim()
  return path && !IMAGE_HEALTH_PATHS.includes(path)
    ? `relay.healthPath is ${path}: the image's HEALTHCHECK reads /data/relay-health only`
    : null
}
