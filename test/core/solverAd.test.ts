import { describe, it, expect } from 'vitest'
import { buildSolverAd } from '@arkade-os/solver-core/core/solverAd.js'
import { cardDigest } from '@arkade-os/solver-core/core/registryCard.js'

const inputs = {
  pairs: [
    {
      pair: 'arkade:BTC->lightning:BTC',
      min: 1000,
      max: 100_000,
      feeBpsIndicative: 30,
      feeFlatIndicative: 50,
      quoteValiditySeconds: 900,
    },
  ],
  relays: ['wss://relay.example'],
}

describe('buildSolverAd', () => {
  it('emits the shape docs/rfq-protocol.md §3 specifies', () => {
    const ad = buildSolverAd(inputs)
    expect(ad.v).toBe(1)
    expect(ad.type).toBe('solver_ad')
    expect(ad.pairs[0]).toEqual({
      pair: 'arkade:BTC->lightning:BTC',
      min: 1000,
      max: 100_000,
      fee_bps_indicative: 30,
      fee_flat_indicative: 50,
      quote_validity_s_typical: 900,
    })
    expect(ad.relays).toEqual(['wss://relay.example'])
  })

  // "MAY be omitted, which means zero" — emitting an explicit 0 would be a
  // different document with the same meaning, and the digest would differ.
  it('omits fee_flat_indicative when it is zero', () => {
    const ad = buildSolverAd({ ...inputs, pairs: [{ ...inputs.pairs[0]!, feeFlatIndicative: 0 }] })
    expect('fee_flat_indicative' in ad.pairs[0]!).toBe(false)
  })

  it('digests identically for identical inputs, and differently when a fee changes', () => {
    const a = cardDigest(buildSolverAd(inputs))
    const b = cardDigest(buildSolverAd(inputs))
    const c = cardDigest(buildSolverAd({ ...inputs, pairs: [{ ...inputs.pairs[0]!, feeBpsIndicative: 31 }] }))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })
})
