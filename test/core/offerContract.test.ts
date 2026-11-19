import { describe, expect, it } from 'vitest'
import {
  OFFER_CONTRACT_V1,
  OFFER_CONTRACT_V2,
  OFFER_CONTRACT_VERSION_LATEST,
  offerContractVersionOf,
} from '@arkade-os/solver-core/core/offerContract.js'

describe('offer contract versions', () => {
  it('labels an offer without an exit leaf as v1', () => {
    expect(offerContractVersionOf({})).toBe(OFFER_CONTRACT_V1)
  })

  it('labels an offer with an exit leaf as v2', () => {
    expect(offerContractVersionOf({ exitDelay: { type: 'seconds', value: 4096n } })).toBe(OFFER_CONTRACT_V2)
  })

  it('names v2 as the version a new offer should use', () => {
    expect(OFFER_CONTRACT_VERSION_LATEST).toBe(OFFER_CONTRACT_V2)
  })

  it('uses stable string identifiers rather than a numeric discriminator', () => {
    expect([OFFER_CONTRACT_V1, OFFER_CONTRACT_V2]).toEqual(['offer-v1', 'offer-v2'])
  })
})
