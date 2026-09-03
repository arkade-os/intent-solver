/**
 * The solver's Arkade asset holdings, in a shape JSON can carry and a human can read.
 *
 * TWO PROBLEMS, ONE MODULE, because they are the same problem from either end.
 *
 * **The balance cannot be serialised at all.** `WalletBalance.assets[].amount` is a
 * `bigint`, and `JSON.stringify` throws on one rather than skipping it. The status
 * routes hand the balance object straight to `c.json`, so a solver holding ANY asset
 * answered `500 Do not know how to serialize a BigInt` on `/api/overview` AND
 * `/api/wallet` — and since the console loads the overview on every view, that is the
 * whole console dark, not one missing row. An operator running the asset-offer
 * corridor is exactly the operator who cannot see anything.
 *
 * `util/poll.ts`'s `json` already settled the encoding for the CLI, and this follows
 * it: a bigint becomes a decimal STRING, never a number. `Number(amount)` would round
 * silently, because the SDK's own `Asset` type says asset supplies routinely exceed
 * `Number.MAX_SAFE_INTEGER`.
 *
 * **And an id is unreadable.** The console exists to answer one question for the
 * asset-offer corridor — "do I hold what this taker is asking for?" — which nobody
 * answers from 64 characters of hex. @see labelled ids below.
 */

import type { Asset, AssetDetails, KnownMetadata, WalletBalance } from '@arkade-os/sdk'

/**
 * Enough of each end of an id to tell two apart at a glance, while staying short
 * enough to sit inline in a balance row.
 *
 * Head and tail rather than a prefix: ids are content-addressed hex with no
 * human-meaningful structure, so two that share a prefix are not unusual and a
 * prefix alone would show them as the same asset.
 */
const ID_HEAD = 8
const ID_TAIL = 4

/** The short form, or the id itself when shortening would not actually shorten it. */
export const shortAssetId = (assetId: string): string =>
  assetId.length <= ID_HEAD + ID_TAIL + 1 ? assetId : `${assetId.slice(0, ID_HEAD)}…${assetId.slice(-ID_TAIL)}`

/**
 * One asset holding, as the console reads it.
 *
 * THE AMOUNT IS ALWAYS BASE UNITS, and there is deliberately no decimals-adjusted
 * figure beside it. An offer names its `wantAmount` in base units and
 * `offerInventoryFrom` compares base units against base units, so a scaled figure
 * shown as *the* number is one an operator would compare directly against a taker's
 * request and get wrong by a factor of `10 ** decimals`. `decimals` rides along as a
 * LABEL so the operator can do that conversion knowingly.
 */
export interface ConsoleAsset {
  assetId: string
  /** Base units, decimal, as a string — see the module note on `bigint`. */
  amount: string
  /** {@link shortAssetId} of `assetId`, so the client needs no id-formatting rule of its own. */
  shortId: string
  /** From the asset's immutable metadata, when the indexer has answered for it. */
  ticker?: string
  name?: string
  decimals?: number
}

export type ConsoleBalance = Omit<WalletBalance, 'assets' | 'availableAssets'> & {
  assets: ConsoleAsset[]
  availableAssets: ConsoleAsset[]
}

/**
 * Every `bigint` anywhere in `value`, as a decimal string.
 *
 * GENERIC RATHER THAN NAMING `assets`/`availableAssets`, which would be shorter and
 * would break again silently. The balance is "an object whose keys vary by SDK
 * version" — the console renders it key-by-key for that reason — so naming today's two
 * bigint-bearing fields means the next bigint the SDK adds takes the whole console
 * down again, as a 500 on every view, with nothing naming the new field.
 */
const jsonSafe = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString()
  // Left whole: recursing into one would flatten it to `{}`, and a date is already
  // something `JSON.stringify` knows how to encode.
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, jsonSafe(inner)]))
  }
  return value
}

/** What {@link describeAssets} needs from the wallet — `IReadonlyAssetManager`'s one read. */
export interface AssetDetailSource {
  getAssetDetails(assetId: string): Promise<AssetDetails>
}

/**
 * Asset metadata, at most once per asset per process.
 *
 * A PROCESS-LIFETIME CACHE IS CORRECT HERE, not merely cheap. The id is
 * content-addressed and the SDK documents the metadata it keys as immutable, so a
 * value once read cannot go stale — nothing invalidates this because nothing can.
 *
 * The cost it avoids is real: `getAssetDetails` is an uncached
 * `GET /v1/indexer/asset/{id}` (pinned SDK `dist/chunk-X3VEMUVV.js:1791`) and the SDK
 * retries a failed GET with backoff. `/api/wallet` and `/api/overview` are re-fetched
 * on every SSE `swaps` event, so an uncached lookup would turn a status page into
 * per-swap-event load on the indexer, and a slow indexer into a slow console.
 *
 * An asset whose metadata is absent caches as `{}`: absent is a final answer for an
 * immutable field, so re-asking could only cost round trips.
 */
const metadataCache = new Map<string, KnownMetadata>()
const inFlight = new Set<string>()

/** Test seam: module state, and one suite's fixtures must not label the next suite's ids. */
export const resetAssetMetadata = (): void => {
  metadataCache.clear()
  inFlight.clear()
}

/**
 * Fetch an asset's metadata for the NEXT read, never this one.
 *
 * The request path stays a pure cache read, so labelling adds no latency to a route
 * and a hung indexer cannot hang the console — the ids render, and the tickers appear
 * on the following load, which the console does on every SSE `swaps` event anyway.
 * Blocking instead would put a retrying HTTP call on the one page an operator opens
 * when something is already wrong.
 *
 * `inFlight` is what keeps that honest: without it, every request during the first
 * fetch starts another, so a page opened while the indexer is slow fans out.
 */
const warmMetadata = (assetId: string, source: AssetDetailSource): void => {
  if (metadataCache.has(assetId) || inFlight.has(assetId)) return
  inFlight.add(assetId)
  void source
    .getAssetDetails(assetId)
    .then((details) => {
      metadataCache.set(assetId, details.metadata ?? {})
    })
    // Swallowed deliberately. This is detached from a request that has already been
    // answered, so there is nothing to report a failure to, and an unhandled
    // rejection here would take the provider process down over a cosmetic label.
    .catch(() => {})
    .finally(() => {
      inFlight.delete(assetId)
    })
}

/**
 * Asset holdings for the console: always the id and amount, plus whatever labels are
 * already known.
 *
 * THE ID IS THE IDENTITY AND THE TICKER IS DECORATION, in that order and never the
 * other way round. Metadata is `Partial` in the SDK and set by whoever issued the
 * asset, so a ticker is neither guaranteed, unique, nor trustworthy — two assets may
 * both call themselves `USD`. Rendering a ticker as the identity would let an operator
 * confirm they hold an asset they do not hold.
 */
export const describeAssets = (assets: readonly Asset[] | undefined, source?: AssetDetailSource): ConsoleAsset[] =>
  (assets ?? []).map((asset) => {
    if (source) warmMetadata(asset.assetId, source)
    const metadata = metadataCache.get(asset.assetId)
    return {
      assetId: asset.assetId,
      amount: asset.amount.toString(),
      shortId: shortAssetId(asset.assetId),
      ticker: metadata?.ticker,
      name: metadata?.name,
      decimals: metadata?.decimals,
    }
  })

/**
 * The wallet balance, safe to hand to `c.json` and carrying labelled assets.
 *
 * Both status routes go through this so the overview and the wallet page cannot
 * disagree about what is held — the same reason `publishState.ts` is shared rather
 * than copied per route.
 */
export const consoleBalance = (balance: WalletBalance, source?: AssetDetailSource): ConsoleBalance => ({
  // Cast because the sweep is value-level: it cannot express "the same shape with
  // every bigint widened to string" in the type system, and every field the routes
  // actually read back off this is a number either way.
  ...(jsonSafe(balance) as Omit<ConsoleBalance, 'assets' | 'availableAssets'>),
  assets: describeAssets(balance.assets, source),
  availableAssets: describeAssets(balance.availableAssets, source),
})
