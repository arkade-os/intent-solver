import { describe, expect, it, vi } from 'vitest'
import {
  AssetRfqSwapStore,
  carrierTermsFromJson,
  carrierTermsToJson,
  type AssetRfqCarrierTerms,
} from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import {
  decodeCarrierAttempt,
  detachJsonObject,
  encodeCarrierAttempt,
  type CarrierAttempt,
} from '@arkade-os/solver-corridors/db/carrierAttempt.js'

const recycle: AssetRfqCarrierTerms = {
  mode: 'recycle',
  quoteId: 'q-1',
  physicalSats: 330n,
  loanSats: 329n,
  receiptSats: 1n,
  serviceFareSats: 0n,
  pricedSats: 1n,
  expiresAt: 5_000,
}
const purchase: AssetRfqCarrierTerms = {
  mode: 'purchase',
  physicalSats: 330n,
  loanSats: 0n,
  receiptSats: 0n,
  serviceFareSats: 5n,
  pricedSats: 335n,
  expiresAt: 5_000,
}
const receiver: AssetRfqCarrierTerms = {
  mode: 'recycle_receiver',
  quoteId: 'q-2',
  physicalSats: 330n,
  loanSats: 330n,
  receiptSats: 0n,
  serviceFareSats: 0n,
  pricedSats: 0n,
  expiresAt: 5_000,
  taxiUrl: 'https://taxi.example.com',
  taxiKey: '11'.repeat(32),
}
const record = (id: string, carrierTerms?: AssetRfqCarrierTerms) => ({
  id,
  rfqId: id,
  pair: 'arkade:BTC->arkade:BTC',
  fromAssetId: null,
  fromAmount: 20n,
  toAssetId: null,
  toAmount: 10n,
  makerPkScript: `5120${'aa'.repeat(32)}`,
  makerPublicKey: 'bb'.repeat(32),
  offerPkScript: `5120${id.charCodeAt(0).toString(16).padStart(64, '0')}`,
  offerAddress: 'ark1qoffer',
  solverPubkey: 'ee'.repeat(32),
  validUntil: 2_000,
  ...(carrierTerms ? { carrierTerms } : {}),
})
const filling = async (store: AssetRfqSwapStore, id: string, carrierTerms?: AssetRfqCarrierTerms) => {
  await store.insertQuote(record(id, carrierTerms))
  await store.transition(id, 'quoted', 'funded', { deposit_txid: 'ff'.repeat(32), deposit_vout: 0 })
  await store.transition(id, 'funded', 'filling')
}
const attempt = async (store: AssetRfqSwapStore, id: string) => (await store.readCarrierAttempt(id))!

describe('asset RFQ carrier terms', () => {
  it('round-trips each mode and refuses terms that do not add up', () => {
    for (const terms of [recycle, purchase, receiver])
      expect(carrierTermsFromJson(carrierTermsToJson(terms))).toEqual(terms)
    const json = carrierTermsToJson(recycle)
    expect(() => carrierTermsFromJson({ ...json, taxi_url: 'https://x' })).toThrow("unknown key 'taxi_url'")
    expect(() => carrierTermsFromJson({ ...json, loan_sats: '328' })).toThrow('does not sum')
    expect(() => carrierTermsFromJson({ ...json, priced_sats: '2' })).toThrow('receipt plus the service fare')
    expect(() => carrierTermsFromJson({ ...carrierTermsToJson(receiver), service_fare_sats: '1' })).toThrow(
      'service_fare_sats must be zero',
    )
    expect(() => carrierTermsFromJson({ ...carrierTermsToJson(purchase), quote_id: 'q' })).toThrow(
      "unknown key 'quote_id'",
    )
  })

  it('refuses invalid terms before writing the row', async () => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    await expect(store.insertQuote(record('x', { ...recycle, loanSats: 1n }))).rejects.toThrow('does not sum')
    expect(await store.findById('x')).toBeUndefined()
    await store.close()
  })
})

describe('an asset RFQ carrier attempt', () => {
  it('walks from prepared to settled, and a stale expectation loses every compare-and-swap', async () => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    await filling(store, 'a', recycle)
    expect(await store.prepareCarrierAttempt('a', { quote: 'q-1' })).toBe(true)
    expect(await store.prepareCarrierAttempt('a', { quote: 'q-1' })).toBe(false)
    const prepared = await attempt(store, 'a')
    expect(prepared).toEqual({ phase: 'prepared', snapshot: { quote: 'q-1' } })
    expect(await store.bindCarrierAttempt('a', prepared, { graph: 'g' })).toBe(true)
    expect(await store.bindCarrierAttempt('a', prepared, { graph: 'h' })).toBe(false)
    expect(await store.markCarrierAttemptSubmitting('a', await attempt(store, 'a'))).toBe(true)
    expect(await store.settleCarrierAttempt('a', await attempt(store, 'a'), 'ab'.repeat(32))).toBe(true)
    const unresolved = await store.listUnresolvedCarrierAttempts()
    expect(unresolved.map(({ row, attempt }) => [row.id, attempt.phase])).toEqual([['a', 'settled']])
    await store.transition('a', 'filling', 'filled', { fill_txid: 'ab'.repeat(32) })
    expect(await store.listUnresolvedCarrierAttempts()).toEqual([])
    await store.close()
  })

  it('refuses a never-submitted or cancelled attempt together with its parent', async () => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    await filling(store, 'b', recycle)
    await filling(store, 'c', recycle)
    store.onTransition = vi.fn()
    await store.prepareCarrierAttempt('b', {})
    expect(await store.refuseNeverSubmittedCarrierAttempt('b', await attempt(store, 'b'), 'quote expired')).toBe(true)
    expect(await store.get('b')).toMatchObject({ state: 'refused', failureReason: 'quote expired' })
    expect((await attempt(store, 'b')).phase).toBe('not_submitted')
    await store.prepareCarrierAttempt('c', {})
    await store.bindCarrierAttempt('c', await attempt(store, 'c'), { graph: 'g' })
    await store.markCarrierAttemptSubmitting('c', await attempt(store, 'c'))
    const sent = await attempt(store, 'c')
    await expect(
      store.cancelCarrierAttempt('c', sent, { ...sent, phase: 'cancelling', binding: { graph: 'other' } }),
    ).rejects.toThrow('only extend it')
    const cancelling: CarrierAttempt = { ...sent, phase: 'cancelling', binding: { ...sent.binding, conflict: 'k' } }
    expect(await store.cancelCarrierAttempt('c', sent, cancelling)).toBe(true)
    expect(await store.refuseCancelledCarrierAttempt('c', await attempt(store, 'c'), 'conflict landed')).toBe(true)
    expect(await store.get('c')).toMatchObject({ state: 'refused', failureReason: 'conflict landed' })
    expect(await store.listUnresolvedCarrierAttempts()).toEqual([])
    expect(vi.mocked(store.onTransition!).mock.calls).toEqual([
      [{ id: 'b', from: 'filling', to: 'refused' }],
      [{ id: 'c', from: 'filling', to: 'refused' }],
    ])
    await store.close()
  })

  it('refuses an unattempted fill only on a recycle row, and never one with an attempt', async () => {
    const store = await AssetRfqSwapStore.open(':memory:', () => 1_000)
    await filling(store, 'd', recycle)
    await filling(store, 'e', purchase)
    await filling(store, 'f', recycle)
    await expect(store.prepareCarrierAttempt('e', {})).rejects.toThrow('not quoted as a recycle')
    expect(await store.refuseUnattemptedCarrierFill('e', 'no attempt')).toBe(false)
    await store.prepareCarrierAttempt('f', {})
    expect(await store.refuseUnattemptedCarrierFill('f', 'no attempt')).toBe(false)
    expect(await store.refuseUnattemptedCarrierFill('d', 'no attempt')).toBe(true)
    expect(await store.get('d')).toMatchObject({ state: 'refused', failureReason: 'no attempt' })
    await store.close()
  })

  it('decodes only the envelope this build wrote', () => {
    const quoted: CarrierAttempt = { phase: 'quoted', snapshot: { b: 1, a: [true, null] }, binding: { q: 'x' } }
    const encoded = encodeCarrierAttempt(quoted)
    expect(encoded).toBe('{"v":1,"phase":"quoted","snapshot":{"a":[true,null],"b":1},"binding":{"q":"x"}}')
    expect(decodeCarrierAttempt(encoded)).toEqual(quoted)
    expect(() => decodeCarrierAttempt('{"v":2,"phase":"prepared","snapshot":{}}')).toThrow('version')
    expect(() => decodeCarrierAttempt('{"v":1,"phase":"quoted","snapshot":{}}')).toThrow('no quote binding')
    expect(() =>
      encodeCarrierAttempt({ phase: 'settled', snapshot: {}, binding: {}, fillTxid: 'AB'.repeat(32) }),
    ).toThrow('not canonical')
    expect(() => detachJsonObject({ amount: 1n }, 'snapshot')).toThrow('bigint')
    expect(() => detachJsonObject({ at: new Date() }, 'snapshot')).toThrow('live instance')
    expect(() => detachJsonObject({ n: 2 ** 53 }, 'snapshot')).toThrow('exactly representable')
  })
})
