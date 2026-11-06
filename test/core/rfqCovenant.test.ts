import { describe, expect, it } from 'vitest'
import {
  RFQ_ASSET_SWAP_V2,
  RFQ_COVENANT_VERSIONS,
  RFQ_EVM_RECEIVE_V1,
  RFQ_EVM_SEND_V1,
  RFQ_LIGHTNING_RECEIVE_V2,
  RFQ_LIGHTNING_SEND_V2,
  RFQ_ONCHAIN_SEND_V2,
  rfqCovenantEnabled,
} from '@arkade-os/solver-core/core/rfqCovenant.js'

describe('RFQ covenant versions', () => {
  it('ships one supported version for every built-in RFQ method', () => {
    expect(RFQ_COVENANT_VERSIONS).toEqual([
      RFQ_LIGHTNING_SEND_V2,
      RFQ_LIGHTNING_RECEIVE_V2,
      RFQ_ONCHAIN_SEND_V2,
      RFQ_ASSET_SWAP_V2,
      RFQ_EVM_SEND_V1,
      RFQ_EVM_RECEIVE_V1,
    ])
  })

  it('uses stable string identifiers that can be names or content hashes', () => {
    expect(RFQ_COVENANT_VERSIONS.every((version) => typeof version === 'string' && version.length > 0)).toBe(true)
    expect(RFQ_COVENANT_VERSIONS).toEqual([
      'lightning-send-v2',
      'lightning-receive-v2',
      'onchain-send-v2',
      'asset-swap-v2',
      'evm-send-v1',
      'evm-receive-v1',
    ])
  })

  it('serves the build defaults while unset, and only the operator list once set', () => {
    expect(rfqCovenantEnabled(null, RFQ_ASSET_SWAP_V2)).toBe(true)
    expect(rfqCovenantEnabled(null, 'custom-v1')).toBe(false)
    expect(rfqCovenantEnabled(['custom-v1'], RFQ_ASSET_SWAP_V2)).toBe(false)
  })
})
