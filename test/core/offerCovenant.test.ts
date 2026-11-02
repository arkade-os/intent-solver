import { describe, expect, it } from 'vitest'
import {
  OFFER_COVENANT_V1,
  OFFER_COVENANT_V2,
  OFFER_COVENANT_VERSION_LATEST,
  offerCovenantVersionOf,
} from '@arkade-os/solver-core/core/offerCovenant.js'

describe('offer covenant versions', () => {
  it('labels an offer without an exit leaf as v1', () => {
    expect(offerCovenantVersionOf({})).toBe(OFFER_COVENANT_V1)
  })

  it('labels an offer with an exit leaf as v2', () => {
    expect(offerCovenantVersionOf({ exitDelay: { type: 'seconds', value: 4096n } })).toBe(OFFER_COVENANT_V2)
  })

  it('names v2 as the version a new offer should use', () => {
    expect(OFFER_COVENANT_VERSION_LATEST).toBe(OFFER_COVENANT_V2)
  })

  it('uses stable string identifiers rather than a numeric discriminator', () => {
    expect([OFFER_COVENANT_V1, OFFER_COVENANT_V2]).toEqual(['offer-v1', 'offer-v2'])
  })
})
