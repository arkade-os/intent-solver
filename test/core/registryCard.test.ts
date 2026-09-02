import { describe, expect, it } from 'vitest'
import { FREE } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  buildSolverCard,
  canonicalCardJson,
  cardDigest,
  signSolverCard,
  verifyCardSig,
  type SolverCardInputs,
} from '@arkade-os/solver-core/core/registryCard.js'

// BIP340 test vector 1 — the same key the registry's own fixtures sign with,
// so a cross-repo canonicalization skew shows up as a verification failure
// here rather than in registry CI.
const SECRET = hexToBytes('B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF'.toLowerCase())
const PUBKEY = 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659'

const sign = (digest: Uint8Array): Promise<Uint8Array> => Promise.resolve(schnorr.sign(digest, SECRET))

const inputs = (over: Partial<SolverCardInputs> = {}): SolverCardInputs => ({
  name: 'test-solver',
  discoveryPubkey: PUBKEY,
  relays: ['wss://relay.example.com'],
  corridors: {
    'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: FREE },
  },
  ...over,
})

describe('buildSolverCard', () => {
  it('publishes rendezvous under the v0 transport map, never the retired top-level relays', () => {
    // The registry schema is additionalProperties:false and dropped the
    // top-level `relays` in favour of `transports.nostr.relays`, so a card
    // still carrying the old field is rejected outright rather than merged.
    const card = buildSolverCard(inputs())
    expect(card.transports).toEqual({ nostr: { relays: ['wss://relay.example.com'] } })
    // Mirrors the schema's additionalProperties:false — an unknown key here is
    // a rejected listing, so the whole key set is pinned, not just `relays`.
    expect(Object.keys(card).sort()).toEqual(['discovery_pubkey', 'markets', 'name', 'transports', 'version'])
  })

  it('emits the send-leg corridor market: quote side enabled, base side disabled', () => {
    const card = buildSolverCard(inputs())
    expect(card.version).toBe(0)
    expect(card.markets).toHaveLength(1)
    const market = card.markets[0]!
    expect(market.pair).toBe('BTC/lightning:BTC')
    expect(market.quote_corridor).toBe('lightning')
    // Base corridor stays the unmarked arkade default.
    expect('base_corridor' in market).toBe(false)
    // Same-asset market: the registry REJECTS feed fields, not just ignores them.
    expect('price_feed' in market).toBe(false)
    expect('price_feed_schema' in market).toBe(false)
    expect('price_decimals' in market).toBe(false)
    // Receive leg is not built: the maker cannot receive the arkade side.
    expect(market.min_base_amount).toBe('0')
    expect(market.max_base_amount).toBe('0')
    // The maker receives Lightning within the service's live limits.
    expect(market.min_quote_amount).toBe('1000')
    expect(market.max_quote_amount).toBe('50000')
  })

  it('dedupes relays and enforces the wss scheme and the registry bound', () => {
    const card = buildSolverCard(inputs({ relays: ['wss://a.example', 'wss://a.example', 'wss://b.example'] }))
    expect(card.transports).toEqual({ nostr: { relays: ['wss://a.example', 'wss://b.example'] } })
    expect(() => buildSolverCard(inputs({ relays: [] }))).toThrow(/at least one wss/)
    expect(() => buildSolverCard(inputs({ relays: ['https://a.example'] }))).toThrow(/wss/)
    expect(() =>
      buildSolverCard(inputs({ relays: Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`) })),
    ).toThrow(/at most 8/)
  })

  it('rejects a name the registry filename rule would reject', () => {
    expect(() => buildSolverCard(inputs({ name: 'Bad Name' }))).toThrow(/name/)
    expect(() => buildSolverCard(inputs({ name: '' }))).toThrow(/name/)
  })

  it('does not publish an emulator pubkey — that is a property of the network, not of a solver', () => {
    // The co-signer key is the same for everyone on a network, so the SDK
    // pins it per network and a per-solver copy could only ever disagree with
    // the others. The registry schema declares `emulator_pubkey` optional and
    // never requires it, so dropping it still validates.
    const card = buildSolverCard(inputs())
    expect('emulator_pubkey' in card).toBe(false)
    // It must not survive into the signed bytes either: the digest is taken
    // over the canonical JSON, so a stray field would change what is signed.
    expect(canonicalCardJson(card)).not.toContain('emulator_pubkey')
  })

  it('publishes a byte-identical card for a Lightning-send-only deployment', () => {
    // COMPATIBILITY. That configuration is what the card hardcoded before this
    // change, so an operator who has already filed a card must not be asked to
    // re-file an equivalent one. If this drifts, every published card churns.
    const card = buildSolverCard(inputs())
    expect(card.markets).toHaveLength(1)
    expect(card.markets[0]).toMatchObject({
      pair: 'BTC/lightning:BTC',
      quote_corridor: 'lightning',
      min_base_amount: '0',
      max_base_amount: '0',
      min_quote_amount: '1000',
      max_quote_amount: '50000',
    })
  })

  it('advertises the onchain market when that is what is served', () => {
    // The bug: a deployment serving onchain published a card describing
    // Lightning. Discovery is the one claim nobody can check against the
    // config, so it has to come from it.
    const card = buildSolverCard(
      inputs({
        corridors: { 'arkade:BTC->onchain:BTC': { limits: { minSats: 20_000, maxSats: 400_000 }, fee: FREE } },
      }),
    )
    expect(card.markets).toHaveLength(1)
    expect(card.markets[0]).toMatchObject({
      pair: 'BTC/onchain:BTC',
      quote_corridor: 'onchain',
      min_quote_amount: '20000',
      max_quote_amount: '400000',
    })
  })

  it('carries each direction`s own bounds on its own side', () => {
    // Bounds describe what the maker RECEIVES, so the arkade-receiving corridor
    // sets the BASE side and the arkade-sending one sets the QUOTE side. Getting
    // this backwards advertises each direction's limits as the other's.
    const card = buildSolverCard(
      inputs({
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50_000 }, fee: FREE },
          'lightning:BTC->arkade:BTC': { limits: { minSats: 3000, maxSats: 90_000 }, fee: FREE },
        },
      }),
    )
    expect(card.markets[0]).toMatchObject({
      min_quote_amount: '1000',
      max_quote_amount: '50000',
      min_base_amount: '3000',
      max_base_amount: '90000',
    })
  })

  it('publishes both markets when both are served, in a stable order', () => {
    const card = buildSolverCard(
      inputs({
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50_000 }, fee: FREE },
          'onchain:BTC->arkade:BTC': { limits: { minSats: 5000, maxSats: 60_000 }, fee: FREE },
        },
      }),
    )
    expect(card.markets.map((m) => m.pair)).toEqual(['BTC/lightning:BTC', 'BTC/onchain:BTC'])
    // The onchain market is served one way only, so its quote side is disabled
    // rather than the market being dropped.
    expect(card.markets[1]).toMatchObject({ min_base_amount: '5000', min_quote_amount: '0', max_quote_amount: '0' })
  })

  it('gives each market its OWN fees, not another corridor`s', () => {
    // The bug this test exists for: the card took a single fee from the
    // Lightning corridors and stamped it on every market. An onchain corridor
    // typically carries a flat charge for miner fees that Lightning does not,
    // so the onchain market advertised no flat fee, the taker got a quote that
    // included one, and the card described a swap nobody was offered.
    const card = buildSolverCard(
      inputs({
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50_000 }, fee: { bps: 10, flatSats: 0 } },
          'arkade:BTC->onchain:BTC': { limits: { minSats: 20_000, maxSats: 400_000 }, fee: { bps: 25, flatSats: 900 } },
        },
      }),
    )
    const [lightning, onchain] = card.markets
    expect(lightning).toMatchObject({ pair: 'BTC/lightning:BTC', fee_bps: 10 })
    expect(lightning).not.toHaveProperty('fee_flat')
    expect(onchain).toMatchObject({ pair: 'BTC/onchain:BTC', fee_bps: 25, fee_flat: '900' })
  })

  it('takes the higher of a market`s two directions, since one entry stands for both', () => {
    // Overstating is the safe direction: a taker who was quoted less than the
    // card said is not harmed, one quoted more was misled.
    const card = buildSolverCard(
      inputs({
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50_000 }, fee: { bps: 10, flatSats: 0 } },
          'lightning:BTC->arkade:BTC': { limits: { minSats: 1000, maxSats: 50_000 }, fee: { bps: 40, flatSats: 7 } },
        },
      }),
    )
    expect(card.markets[0]).toMatchObject({ fee_bps: 40, fee_flat: '7' })
  })

  it('refuses to publish a card for a deployment serving nothing', () => {
    // Silence beats a card claiming markets that will refuse every request.
    expect(() => buildSolverCard(inputs({ corridors: {} }))).toThrow(/no corridor is enabled/)
  })

  it('rejects limits and fees the schema amount rules would reject', () => {
    const withLimits = (limits: { minSats: number; maxSats: number }) =>
      inputs({ corridors: { 'arkade:BTC->lightning:BTC': { limits, fee: FREE } } })
    expect(() => buildSolverCard(withLimits({ minSats: 0, maxSats: 5 }))).toThrow(/minSats/)
    expect(() => buildSolverCard(withLimits({ minSats: 1.5, maxSats: 5 }))).toThrow(/minSats/)
    expect(() => buildSolverCard(withLimits({ minSats: 5000, maxSats: 1000 }))).toThrow(/must be <= maxSats/)
    expect(() =>
      buildSolverCard(
        inputs({
          corridors: {
            'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: { bps: -1, flatSats: 0 } },
          },
        }),
      ),
    ).toThrow(/fee_bps/)
    expect(() =>
      buildSolverCard(
        inputs({
          corridors: {
            'arkade:BTC->lightning:BTC': {
              limits: { minSats: 1000, maxSats: 50000 },
              fee: { bps: 10001, flatSats: 0 },
            },
          },
        }),
      ),
    ).toThrow(/fee_bps/)
    expect(() =>
      buildSolverCard(
        inputs({
          corridors: {
            'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: { bps: 0, flatSats: -1 } },
          },
        }),
      ),
    ).toThrow(/fee_flat/)
    expect(() =>
      buildSolverCard(
        inputs({
          corridors: {
            'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: { bps: 0, flatSats: 1.5 } },
          },
        }),
      ),
    ).toThrow(/fee_flat/)
  })

  it('publishes the flat fee as a decimal string, the registry amount convention', () => {
    // A string, unlike the bid's integer — the card follows the registry's
    // amount rules, and quote-asset units rather than the bid's from leg.
    const card = buildSolverCard(
      inputs({
        corridors: {
          'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: { bps: 0, flatSats: 50 } },
        },
      }),
    )
    expect(card.markets[0]!.fee_flat).toBe('50')
  })

  it('omits fee_flat when the corridor charges none', () => {
    // Optional in the schema with absent meaning zero, so a deployment that
    // sets no flat fee publishes the card it published before the field
    // existed — and one that predates the registry schema change still
    // validates, since additionalProperties is false there.
    expect(
      'fee_flat' in
        buildSolverCard(
          inputs({
            corridors: {
              'arkade:BTC->lightning:BTC': { limits: { minSats: 1000, maxSats: 50000 }, fee: { bps: 0, flatSats: 0 } },
            },
          }),
        ).markets[0]!,
    ).toBe(false)
  })
})

describe('canonical form and signature', () => {
  it('serializes with sig removed, keys recursively sorted, no whitespace', () => {
    const json = canonicalCardJson({ b: 1, sig: 'ff', a: { z: [{ y: 2, x: 3 }], w: 4 } })
    expect(json).toBe('{"a":{"w":4,"z":[{"x":3,"y":2}]},"b":1}')
  })

  it('round-trips sign → verify, and verification pins the exact content', async () => {
    const card = await signSolverCard(buildSolverCard(inputs()), sign)
    expect(card.sig).toMatch(/^[0-9a-f]{128}$/)
    expect(verifyCardSig(card)).toBe(true)
    // Any content change breaks the signature…
    expect(verifyCardSig({ ...card, name: 'other-name' })).toBe(false)
    // …and the sig itself is excluded from the signed bytes, so re-signing is
    // possible without a fixpoint: digests with and without sig are equal.
    expect(bytesToHex(cardDigest(card))).toBe(bytesToHex(cardDigest({ ...card, sig: undefined })))
  })

  it('refuses to emit a card whose pubkey does not match the signing key', async () => {
    const otherPubkey = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()))
    const card = buildSolverCard(inputs({ discoveryPubkey: otherPubkey }))
    await expect(signSolverCard(card, sign)).rejects.toThrow(/does not verify/)
  })
})
