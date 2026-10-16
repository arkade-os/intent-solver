/**
 * The explorer bases `/api/overview` hands the console, which joins
 * `/tx/:id` or `/address/:id` onto them (admin/static/app.js `explorerLink`).
 */

import { describe, it, expect } from 'vitest'
import { NETWORKS, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'

const ALL = Object.keys(NETWORKS) as SwapNetwork[]

describe('the explorer table', () => {
  it('covers EVERY network, so adding one cannot silently ship without links', () => {
    for (const network of ALL) {
      expect(NETWORKS[network].explorers.arkade, network).toBeTruthy()
      expect(NETWORKS[network].explorers.onchain, network).toBeTruthy()
    }
  })

  it('never points a test network at a mainnet explorer, or the reverse', () => {
    // The costly confusion: a regtest txid looked up on mainnet reads as "not
    // found", and a mainnet one looked up on a test explorer reads the same.
    // Both look like "the transaction does not exist".
    expect(NETWORKS.bitcoin.explorers.arkade).not.toMatch(/mutinynet|signet|localhost/)
    expect(NETWORKS.bitcoin.explorers.onchain).not.toMatch(/mutinynet|signet|localhost/)
    for (const network of ALL.filter((n) => n !== 'bitcoin')) {
      expect(NETWORKS[network].explorers.arkade, network).toMatch(/mutinynet|signet|localhost/)
      expect(NETWORKS[network].explorers.onchain, network).toMatch(/mutinynet|signet|localhost/)
    }
  })

  it('carries no trailing slash, so joining a path cannot double it', () => {
    for (const network of ALL) {
      expect(NETWORKS[network].explorers.arkade, network).not.toMatch(/\/$/)
      expect(NETWORKS[network].explorers.onchain, network).not.toMatch(/\/$/)
    }
  })

  it('is a different host from the arkade explorer on every network', () => {
    for (const network of ALL) {
      expect(NETWORKS[network].explorers.onchain, network).not.toBe(NETWORKS[network].explorers.arkade)
    }
  })
})
