import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { ASSET_SWAP_V2, ASSET_SWAP_V3, offerContract } from '@arkade-os/swap/protocol'
import { corridorSetFromDeps } from '@arkade-os/solver-app/ops/corridorSet.js'
import { offerFromTerms, offerScriptFrom } from '@arkade-os/solver-arkade/arkade/offerTerms.js'
import { quotedOfferSettleFor } from '@arkade-os/solver-arkade/arkade/quotedOfferSettle.js'
import type { fulfillOffer } from '@arkade-os/solver-arkade/arkade/offerFulfill.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type { CorridorRfqOutcome as RfqOutcome } from '@arkade-os/solver-core/core/corridor.js'

const publicKey = (n: number) => schnorr.getPublicKey(new Uint8Array(32).fill(n))
const ASSET = 'aa'.repeat(32) + '0100'
const MAKER = hex.encode(publicKey(3))
const MAKER_SCRIPT = '5120' + MAKER
const PAIR = `arkade:BTC->arkade:${ASSET}`
const derivation = {
  serverPubkey: publicKey(2),
  emulatorPubkey: publicKey(4),
  hrp: 'tark',
  exitDelay: { type: 'blocks' as const, value: 10n },
}
const market = {
  base: null,
  quote: ASSET,
  symbol: 'USDA',
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 0,
  sellBase: { min: 1n, max: 10n ** 24n },
  buyBase: { min: 1n, max: 10n ** 24n },
  feedUrl: 'https://feed.example',
  pricePath: 'price',
  carrierSats: 0n,
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(supported?: readonly string[], beforePrice: () => Promise<void> = async () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'solver-version-'))
  const path = join(directory, 'swaps.sqlite')
  let store = await AssetRfqSwapStore.open(path, () => 1_000)
  let id = 0
  const service = new AssetRfqSwapService({
    store,
    markets: [market],
    solverPubkey: 'ee'.repeat(32),
    quoteValiditySeconds: 30,
    dustSats: 0n,
    now: () => 1_000,
    newId: () => `swap-${++id}`,
    fetchPrice: async () => {
      await beforePrice()
      return { mantissa: 100_000n, scale: 0 }
    },
    deriveOffer: offerScriptFrom(derivation),
    depositAt: async () => null,
    balance: async () => new Map([[ASSET, 10n ** 18n]]),
    settle: async () => 'ff'.repeat(32),
  })
  const corridors = corridorSetFromDeps({
    store: null as never,
    onchainStore: null as never,
    assetRfqStore: store,
    assetRfqService: service,
    assetRfqMarkets: [market],
    ...(supported === undefined ? {} : { rfqContractVersions: new Set(supported) }),
  })
  cleanups.push(async () => {
    await store.close()
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('solver-version-')) {
      throw new Error('unexpected version fixture directory')
    }
    rmSync(directory, { recursive: true })
  })
  return {
    store: () => store,
    reopen: async () => {
      await store.close()
      store = await AssetRfqSwapStore.open(path, () => 1_000)
      return store
    },
    quote: (rfqId: string, versions?: readonly string[]) =>
      corridors.get(PAIR)!.quote({
        v: 1,
        type: 'rfq_request',
        rfq_id: rfqId,
        pair: PAIR,
        amount: '100000',
        amount_side: 'from',
        profile: { maker_pk_script: MAKER_SCRIPT, maker_public_key: MAKER },
        ...(versions === undefined ? {} : { contract_versions: versions }),
      }),
  }
}

async function assertQuote(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  result: RfqOutcome,
  version: typeof ASSET_SWAP_V2 | typeof ASSET_SWAP_V3,
  negotiated = true,
) {
  expect(result.kind).toBe('quote')
  if (result.kind !== 'quote') throw new Error(JSON.stringify(result))
  const row = await f.store().findByRfqId(id)
  if (!row) throw new Error('quote was not persisted')
  const expected = offerContract(
    offerFromTerms(
      {
        wantAmount: row.toAmount,
        wantAssetId: row.toAssetId,
        offerAssetId: row.fromAssetId,
        makerPkScript: row.makerPkScript,
        makerPublicKey: row.makerPublicKey,
      },
      derivation.emulatorPubkey,
      derivation.exitDelay,
    ),
    derivation.serverPubkey,
    version,
  )
  expect(result.payload.contract_version).toBe(negotiated ? version : undefined)
  expect(result.payload.profile).toMatchObject({
    offer_pk_script: hex.encode(expected.pkScript),
    offer_address: expected.address('tark', derivation.serverPubkey).encode(),
  })
  expect(row.offerPkScript).toBe(hex.encode(expected.pkScript))
  return row
}

describe('asset RFQ program negotiation', () => {
  it.each([ASSET_SWAP_V2, ASSET_SWAP_V3] as const)('echoes and records the exact %s program', async (version) => {
    const f = await fixture()
    const id = '1'.repeat(64)
    await assertQuote(f, id, await f.quote(id, [version]), version)
  })

  it('keeps versionless requests on V2 without a negotiation echo', async () => {
    const f = await fixture()
    const id = '2'.repeat(64)
    await assertQuote(f, id, await f.quote(id), ASSET_SWAP_V2, false)
  })

  it('honours configured V2 and refuses an unauthorized versionless baseline', async () => {
    const v2 = await fixture([ASSET_SWAP_V2])
    const id = '3'.repeat(64)
    await assertQuote(v2, id, await v2.quote(id, [ASSET_SWAP_V3, ASSET_SWAP_V2]), ASSET_SWAP_V2)
    const v3 = await fixture([ASSET_SWAP_V3])
    expect((await v3.quote('4'.repeat(64))).kind).toBe('refused')
    expect(await v3.store().findByRfqId('4'.repeat(64))).toBeNull()
  })

  it('captures concurrent quote versions before deferred pricing and caller mutation', async () => {
    let release!: () => void
    const blocked = new Promise<void>((done) => {
      release = done
    })
    const price = vi.fn(() => blocked)
    const f = await fixture(undefined, price)
    const versions = [ASSET_SWAP_V3]
    const first = f.quote('5'.repeat(64), versions)
    await vi.waitFor(() => expect(price).toHaveBeenCalledOnce())
    const second = f.quote('6'.repeat(64), [ASSET_SWAP_V2])
    versions[0] = ASSET_SWAP_V2
    release()
    await assertQuote(f, '5'.repeat(64), await first, ASSET_SWAP_V3)
    await assertQuote(f, '6'.repeat(64), await second, ASSET_SWAP_V2)
  })

  it.each([ASSET_SWAP_V2, ASSET_SWAP_V3] as const)(
    'keeps the original %s row through retry and SQLite reopen',
    async (version) => {
      const f = await fixture()
      const id = '7'.repeat(64)
      const row = await assertQuote(f, id, await f.quote(id, [version]), version)
      const retry = await f.quote(id, [version === ASSET_SWAP_V2 ? ASSET_SWAP_V3 : ASSET_SWAP_V2])
      expect(retry.kind).toBe('refused')
      expect(await f.store().findByRfqId(id)).toEqual(row)
      const txid = 'dd'.repeat(32)
      await f.store().transition(row.id, 'quoted', 'funded', { deposit_txid: txid, deposit_vout: 0 })
      const reopened = await f.reopen()
      const persisted = await reopened.findByRfqId(id)
      if (!persisted) throw new Error('persisted quote missing')
      expect(persisted.offerPkScript).toBe(row.offerPkScript)
      const fulfill = vi.fn<typeof fulfillOffer>(async () => 'ff'.repeat(32))
      const settle = quotedOfferSettleFor({
        ctx: {} as never,
        emulatorUrl: 'https://emulator.example',
        derivation,
        fulfill,
        outpointsAt: async () => [{ txid, vout: 0, sats: row.fromAmount, assets: [] }],
      })
      await settle(persisted)
      expect(fulfill.mock.calls[0]![2].swapPkScript).toEqual(hex.decode(row.offerPkScript))
      expect(fulfill.mock.calls[0]![4]).toEqual({ kind: 'rfq', id: row.id })
    },
  )
})
