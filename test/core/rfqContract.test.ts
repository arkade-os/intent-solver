import { describe, expect, it } from 'vitest'
import * as rfqContract from '@arkade-os/solver-core/core/rfqContract.js'
import {
  RFQ_ASSET_SWAP_V2,
  RFQ_ASSET_SWAP_DIRECTED,
  RFQ_ASSET_SWAP_DIRECTED_NONCE,
  RFQ_CONTRACT_VERSIONS,
  RFQ_EVM_RECEIVE_V1,
  RFQ_EVM_SEND_V1,
  RFQ_LIGHTNING_RECEIVE_V2,
  RFQ_LIGHTNING_SEND_V2,
  RFQ_ONCHAIN_SEND_V2,
  rfqContractEnabled,
} from '@arkade-os/solver-core/core/rfqContract.js'

describe('RFQ contract versions', () => {
  it('serves both directed asset swap contracts and the other built-in methods', () => {
    expect(RFQ_CONTRACT_VERSIONS).toEqual([
      RFQ_LIGHTNING_SEND_V2,
      RFQ_LIGHTNING_RECEIVE_V2,
      RFQ_ONCHAIN_SEND_V2,
      RFQ_ASSET_SWAP_DIRECTED_NONCE,
      RFQ_ASSET_SWAP_DIRECTED,
      RFQ_EVM_SEND_V1,
      RFQ_EVM_RECEIVE_V1,
    ])
  })

  it('uses stable string identifiers that can be names or content hashes', () => {
    expect(RFQ_CONTRACT_VERSIONS.every((version) => typeof version === 'string' && version.length > 0)).toBe(true)
    expect(RFQ_CONTRACT_VERSIONS).toEqual([
      'lightning-send-v2',
      'lightning-receive-v2',
      'onchain-send-v2',
      'asset-swap-directed-nonce',
      'asset-swap-directed',
      'evm-send-v1',
      'evm-receive-v1',
    ])
  })

  it('still names v2, which offer swaps and old RFQ rows use, and no longer v3', () => {
    expect(RFQ_ASSET_SWAP_V2).toBe('asset-swap-v2')
    expect(Object.keys(rfqContract)).not.toContain('RFQ_ASSET_SWAP_V3')
  })

  it('serves the build defaults while unset, and only the operator list once set', () => {
    expect(rfqContractEnabled(null, RFQ_ASSET_SWAP_DIRECTED)).toBe(true)
    expect(rfqContractEnabled(null, RFQ_ASSET_SWAP_V2)).toBe(false)
    expect(rfqContractEnabled(null, 'custom-v1')).toBe(false)
    expect(rfqContractEnabled(['custom-v1'], RFQ_ASSET_SWAP_DIRECTED)).toBe(false)
  })
})
