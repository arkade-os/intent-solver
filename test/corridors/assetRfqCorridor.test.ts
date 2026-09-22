/**
 * `arkade:<X>->arkade:<Y>` as a registered corridor.
 *
 * The contract has eleven required members and the host knows nothing else
 * about a corridor, so what is checked here is that this one really answers all
 * of them — and that the capabilities it does NOT declare are genuinely absent
 * rather than half-present. An absent capability is a documented degradation;
 * a declared one that cannot work is an operator pressing a button at the worst
 * possible moment.
 */

import { describe, it, expect } from 'vitest'
import { createCorridorSet } from '@arkade-os/solver-core/core/corridor.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { AssetRfqSwapService } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  assetRfqCorridor,
  assetRfqDescriptor,
  assetRfqEnvStem,
  assetRfqReader,
} from '@arkade-os/solver-corridors/corridors/assetRfq.js'

const ASSET_A = `${'aa'.repeat(32)}0100`
const PK_SCRIPT = `5120${'c'.repeat(64)}`
const XONLY = 'b'.repeat(64)
const RFQ_ID = 'a'.repeat(64)

const MARKET = {
  base: null,
  quote: ASSET_A,
  symbol: 'USDA',
  baseDecimals: 8,
  quoteDecimals: 6,
  feeBps: 50,
  sellBase: { min: 1n, max: 10n ** 24n },
  buyBase: { min: 1n, max: 10n ** 24n },
  feedUrl: 'https://feed.example/btc',
  pricePath: 'price',
  carrierSats: 0n,
}

const BUY = assetRfqDescriptor(MARKET, 'sell_base')
const SELL = assetRfqDescriptor(MARKET, 'buy_base')

const harness = async (markets: (typeof MARKET)[] = [MARKET], options: { carrier?: boolean } = {}) => {
  let clock = 1_000
  let sequence = 0
  const store = await AssetRfqSwapStore.open(':memory:', () => clock)
  const service = new AssetRfqSwapService({
    store,
    markets,
    solverPubkey: 'e'.repeat(64),
    quoteValiditySeconds: 30,
    dustSats: 330n,
    now: () => clock,
    fetchPrice: async () => ({ mantissa: 100_000n, scale: 0 }),
    deriveOffer: (terms) => ({
      pkScript: `5120${terms.makerPublicKey}`,
      address: `ark1q${terms.makerPublicKey.slice(0, 8)}`,
    }),
    depositAt: async () => null,
    balance: async () =>
      new Map([
        [ASSET_A, 10n ** 18n],
        [null, 10n ** 12n],
      ]),
    settle: async () => 'fa'.repeat(32),
    newId: () => `swap-${++sequence}`,
    // Off by default, so the absent-adapter refusal is what the base harness
    // exercises rather than a stubbed success.
    ...(options.carrier === true
      ? {
          receiveCarrierQuotes: {
            resolve: async () => ({
              quoteId: 'q-1',
              makerPkScript: PK_SCRIPT,
              makerPublicKey: XONLY,
              assetId: ASSET_A,
              physicalSats: 330n,
              loanSats: 329n,
              receiptSats: 1n,
              serviceFareSats: 0n,
              expiresAt: 5_000,
            }),
          },
        }
      : {}),
  })
  return { store, service, corridor: assetRfqCorridor(BUY, service, store), tick: (n: number) => (clock = n) }
}

const rfqRequest = (over: Record<string, unknown> = {}) => ({
  v: 1,
  type: 'rfq_request',
  rfq_id: RFQ_ID,
  pair: BUY.pair,
  amount_side: 'from',
  amount: '100000000',
  profile: { maker_pk_script: PK_SCRIPT, maker_public_key: XONLY },
  ...over,
})

describe('the descriptor', () => {
  it('names the directional pair each way round', () => {
    expect(BUY.pair).toBe(`arkade:BTC->arkade:${ASSET_A}`)
    expect(SELL.pair).toBe(`arkade:${ASSET_A}->arkade:BTC`)
  })

  /**
   * An env stem must be a legal shell identifier, which a 68-hex asset id is
   * not usable as. The symbol is operator-facing config for exactly this.
   */
  it('derives a usable env stem per direction', () => {
    expect(assetRfqEnvStem(MARKET, 'sell_base')).toBe('ASSET_USDA_BUY')
    expect(assetRfqEnvStem(MARKET, 'buy_base')).toBe('ASSET_USDA_SELL')
    expect(BUY.envStem).toMatch(/^[A-Z][A-Z0-9_]*$/)
  })

  it('funds its payout from the Arkade float in both directions', () => {
    // Both legs are on Arkade, whether the payout is sats or an asset.
    expect(BUY.payoutRail).toBe('arkade')
    expect(SELL.payoutRail).toBe('arkade')
  })

  it('declares only filled as delivery', () => {
    // `refused` covers a declined quote AND a lapsed one; neither delivered
    // anything, and neither left the solver out of pocket.
    expect(BUY.states.delivered).toEqual(['filled'])
  })

  it('declares filling as the only exposed state', () => {
    // Before it nothing is submitted; after it the fill has landed. `fulfill`
    // pays and collects in one transaction, so there is no other window.
    expect(BUY.states.exposed).toEqual(['filling'])
  })

  it('registers both directions without colliding', async () => {
    // Both directions of one market are two distinct corridors, so neither the
    // pair nor the env stem may collide — `createCorridorSet` refuses either at
    // composition time, which is where a collision must surface.
    const { store, service } = await harness()
    const set = createCorridorSet([assetRfqCorridor(BUY, service, store), assetRfqCorridor(SELL, service, store)])
    expect(set.size).toBe(2)
    expect(set.get(SELL.pair)?.descriptor.envStem).toBe('ASSET_USDA_SELL')
    await store.close()
  })
})

describe('the eleven required members', () => {
  it('answers every one of them', async () => {
    const { corridor } = await harness()
    for (const member of [
      'descriptor',
      'quote',
      'statusFor',
      'tick',
      'tickAll',
      'park',
      'findRecoverable',
      'committedSats',
      'page',
      'detail',
      'close',
    ]) {
      expect(corridor, `missing ${member}`).toHaveProperty(member)
    }
  })

  /**
   * Absence is the contract here, not an oversight. § 7.2's `cancel` is a
   * 2-of-2 of the FUNDER and the Arkade Service — this solver holds neither
   * key, so any refund button would be one that cannot work.
   */
  it('declares no refund or claim capability, because it holds no such key', async () => {
    const { corridor } = await harness()
    expect(corridor.refundSweep).toBeUndefined()
    expect(corridor.refundNow).toBeUndefined()
    expect(corridor.claimNow).toBeUndefined()
  })

  /**
   * `liveLockups` reports ARKADE LOCKUPS OF OURS for renewal and recovery. This
   * corridor funds none — the covenant holding money is the client's own offer
   * deposit — so absence means "none of mine", which is true.
   */
  it('reports no lockups of its own, because it funds none', async () => {
    const { corridor } = await harness()
    expect(corridor.liveLockups).toBeUndefined()
    expect(corridor.lockupFor).toBeUndefined()
  })
})

describe('quote — the corridor RFQ arm', () => {
  it('meters requester quotes through the registered asset corridor', async () => {
    const { corridor, store } = await harness()
    const request = (n: number) =>
      rfqRequest({
        rfq_id: n.toString(16).padStart(64, '0'),
        profile: { maker_pk_script: PK_SCRIPT, maker_public_key: n.toString(16).padStart(64, '0') },
      })
    try {
      for (let i = 1; i <= 5; i++)
        expect((await corridor.quote(request(i), { requesterKey: 'client' })).kind).toBe('quote')
      expect((await corridor.quote(request(6), { requesterKey: 'client' })).payload.reason).toBe('rate_limited')
      expect((await corridor.quote(request(1), { requesterKey: 'client' })).payload.reason).toBe('quote_conflict')
      expect((await corridor.quote(request(6), { requesterKey: 'other-client' })).kind).toBe('quote')
    } finally {
      await store.close()
    }
  })

  it('answers a well-formed request with a quote', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(rfqRequest())
    expect(outcome.kind).toBe('quote')
    expect(outcome.payload).toMatchObject({ type: 'rfq_quote', from_amount: '100000000', to_amount: '99500000000' })
  })

  // Two markets, the served one SECOND: with only one, any service-wide read coincides with the right answer.
  it('publishes the carrier the priced market charged, and the amounts to match', async () => {
    const other = { ...MARKET, symbol: 'USDB', quote: `${'ab'.repeat(32)}0100`, carrierSats: 0n }
    const free = await harness([other, MARKET])
    const priced = await harness([other, { ...MARKET, carrierSats: 330n }])
    const without = await free.corridor.quote(rfqRequest())
    const with_ = await priced.corridor.quote(rfqRequest())
    expect(without.payload).not.toHaveProperty('carrier_sats')
    expect(with_.payload).toMatchObject({ carrier_sats: '330' })
    expect(BigInt((with_.payload as { to_amount: string }).to_amount)).toBeLessThan(
      BigInt((without.payload as { to_amount: string }).to_amount),
    )
    await free.store.close()
    await priced.store.close()
  })

  it('refuses a malformed payload as unsupported_payload', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote({ v: 1, type: 'rfq_request' })
    expect(outcome.kind).toBe('invalid')
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_payload' })
  })

  /**
   * A pair that reached the wrong corridor is refused rather than served. § 2
   * compares pairs byte for byte and forbids normalising, so an upper-case
   * asset id is a different pair even though it names the same asset.
   */
  it('refuses a pair belonging to another corridor', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(rfqRequest({ pair: SELL.pair }))
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_pair' })
  })

  it('refuses an upper-case spelling of its own pair rather than normalising it', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(rfqRequest({ pair: BUY.pair.toUpperCase() }))
    expect(outcome.payload).toMatchObject({ reason: 'unsupported_pair' })
  })

  /**
   * Every reason this corridor can emit must land inside § 10's closed set —
   * the host re-checks it on the way out, but a corridor leaking an internal
   * string would be relying on that backstop.
   */
  it('emits only closed-set refusal reasons', async () => {
    const { corridor } = await harness()
    const closed = [
      'unsupported_pair',
      'unsupported_payload',
      'amount_out_of_range',
      'exposure_cap',
      'invoice_expired',
      'quote_conflict',
      'pricing_unavailable',
      'rate_limited',
    ]
    const outcomes = [
      await corridor.quote(rfqRequest({ amount_side: 'to', amount: '100000000000000000000' })),
      await corridor.quote({ v: 1, type: 'rfq_request' }),
      await corridor.quote(rfqRequest({ pair: SELL.pair })),
      await corridor.quote(rfqRequest({ rfq_id: 'c'.repeat(64), amount: '100000000000000000000' })),
    ]
    // Every one of them must actually BE a refusal — an assertion that passed
    // because the corridor happily quoted would prove nothing.
    expect(outcomes.map((o) => o.kind)).not.toContain('quote')
    for (const outcome of outcomes) {
      expect(closed).toContain((outcome.payload as { reason: string }).reason)
    }
  })
})

describe('statusFor — the host fall-through', () => {
  it('answers for its own negotiation', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    expect(await corridor.statusFor(RFQ_ID)).toMatchObject({ type: 'rfq_status', state: 'quoted' })
  })

  /**
   * Null, never a refusal: a refusal would end the host's fall-through and hide
   * a live swap belonging to the corridor after this one.
   */
  it('answers null for an id it does not hold', async () => {
    const { corridor } = await harness()
    expect(await corridor.statusFor('0'.repeat(64))).toBeNull()
  })

  /**
   * One store backs every asset market, so an rfq id alone does not make a row
   * this corridor's. Without the pair filter, the BTC->asset corridor would
   * answer for an asset->BTC negotiation and the console would file it under
   * the wrong pair.
   */
  it('does not answer for a negotiation on the other direction of its market', async () => {
    const { store, service } = await harness()
    const sell = assetRfqCorridor(SELL, service, store)
    await service.quote({
      rfqId: RFQ_ID,
      pair: BUY.pair,
      amount: 100_000_000n,
      amountSide: 'from',
      makerPkScript: PK_SCRIPT,
      makerPublicKey: XONLY,
    })
    expect(await sell.statusFor(RFQ_ID)).toBeNull()
  })
})

describe('park — the one lever that stops the sweep', () => {
  it('parks a live negotiation and reports where it landed', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    expect(await corridor.park('swap-1', 'operator halted the market')).toEqual({ state: 'refused' })
  })

  it('refuses a terminal row rather than reporting success', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    await corridor.park('swap-1', 'halted')
    await expect(corridor.park('swap-1', 'again')).rejects.toThrow(/already refused/)
  })

  it('demands a reason, because a parked row with no explanation is a mystery later', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    await expect(corridor.park('swap-1', '   ')).rejects.toThrow(/reason is required/)
  })
})

describe('the read half', () => {
  it('pages its own rows and no other corridor rows', async () => {
    const { store, service, corridor } = await harness()
    await corridor.quote(rfqRequest())
    const sell = assetRfqReader(SELL, store)
    expect((await corridor.page({})).swaps).toHaveLength(1)
    expect((await sell.page({})).swaps).toHaveLength(0)
    expect(service).toBeDefined()
  })

  it('renders a row for the console under its own pair', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    const detail = await corridor.detail('swap-1')
    expect(detail?.swap).toMatchObject({ corridor: BUY.pair, state: 'quoted', phase: 'open' })
  })

  /**
   * `payoutSats` is SATS by contract. On this direction the payout is an ASSET,
   * so a number there would be 10^18 units of a stablecoin labelled as sats.
   */
  it('reports no payout sats when the payout leg is an asset', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    expect((await corridor.detail('swap-1'))?.swap).toMatchObject({ payoutSats: null })
  })

  it('answers null on an id it does not hold', async () => {
    const { corridor } = await harness()
    expect(await corridor.detail('nope')).toBeNull()
  })

  it('offers the sweep the client offer script, the only contract holding money', async () => {
    const { corridor } = await harness()
    await corridor.quote(rfqRequest())
    expect(await corridor.findRecoverable()).toEqual([{ id: 'swap-1', pkScript: `5120${XONLY}` }])
  })
})

/** `profile.carrier` through the corridor: schema, orchestrator and refusal
 * mapping. An internal reason the closed set cannot name must reach a client as
 * `unsupported_payload` rather than leaking a non-spec string. */
describe('profile.carrier through the corridor', () => {
  const carrierRequest = (carrier: unknown) =>
    rfqRequest({ profile: { maker_pk_script: PK_SCRIPT, maker_public_key: XONLY, carrier } })

  it('echoes the full pinned purchase terms, a zero loan included', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(carrierRequest({ mode: 'purchase' }))
    expect(outcome.kind).toBe('quote')
    if (outcome.kind !== 'quote') throw new Error('expected a quote')
    expect((outcome.payload as { profile: Record<string, unknown> }).profile.carrier).toEqual({
      mode: 'purchase',
      physical_sats: '330',
      loan_sats: '0',
      receipt_sats: '0',
      service_fare_sats: '0',
      priced_sats: '330',
      expires_at: 1_030,
    })
  })

  it('echoes the full pinned recycle terms, the split included', async () => {
    const { corridor } = await harness(undefined, { carrier: true })
    const outcome = await corridor.quote(carrierRequest({ mode: 'recycle', quote_id: 'q-1' }))
    expect(outcome.kind).toBe('quote')
    if (outcome.kind !== 'quote') throw new Error('expected a quote')
    expect((outcome.payload as { profile: Record<string, unknown> }).profile.carrier).toEqual({
      mode: 'recycle',
      quote_id: 'q-1',
      physical_sats: '330',
      loan_sats: '329',
      receipt_sats: '1',
      service_fare_sats: '0',
      priced_sats: '1',
      expires_at: 5_000,
    })
  })

  it('answers an unknown mode with unsupported_payload', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(carrierRequest({ mode: 'fronted' }))
    expect(outcome).toMatchObject({ kind: 'invalid', payload: { reason: 'unsupported_payload' } })
  })

  it('answers a recycle with no adapter as a refusal the closed set can name', async () => {
    const { corridor } = await harness()
    const outcome = await corridor.quote(carrierRequest({ mode: 'recycle', quote_id: 'q-1' }))
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'pricing_unavailable' } })
  })

  it('answers a mode on a BTC payout as unsupported_payload', async () => {
    const { service, store } = await harness()
    const outcome = await assetRfqCorridor(SELL, service, store).quote(
      rfqRequest({
        pair: SELL.pair,
        amount: '1000000',
        profile: { maker_pk_script: PK_SCRIPT, maker_public_key: XONLY, carrier: { mode: 'purchase' } },
      }),
    )
    expect(outcome).toMatchObject({ kind: 'refused', payload: { reason: 'unsupported_payload' } })
  })
})
