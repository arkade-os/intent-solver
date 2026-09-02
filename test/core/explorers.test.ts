/**
 * The explorer links the console renders.
 *
 * A wrong base or a wrong path shape is not a broken pixel — it sends an
 * operator mid-incident to a page about someone else's transaction, or to
 * nothing at all, at the moment they are deciding whether to refund or claim.
 * So the bases are pinned per network and the path shapes are pinned against
 * the explorers that actually serve them.
 */

import { describe, it, expect } from 'vitest'
import { NETWORKS, type SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import { arkadeAddressUrl, arkadeTxUrl, onchainTxUrl } from '@arkade-os/solver-core/core/explorers.js'

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
})

describe('arkade explorer urls', () => {
  // Path shapes read off ArkLabsHQ/arkade-explorer `src/App.tsx`:
  //   <Route path="/tx/:txid" />   <Route path="/address/:address" />
  it('builds a transaction url the Arkade explorer actually routes', () => {
    expect(arkadeTxUrl('bitcoin', 'abc123')).toBe('https://arkade.space/tx/abc123')
    expect(arkadeTxUrl('signet', 'abc123')).toBe('https://explorer.signet.arkade.sh/tx/abc123')
  })

  it('builds an address url the Arkade explorer actually routes', () => {
    expect(arkadeAddressUrl('mutinynet', 'tark1qexample')).toBe(
      'https://explorer.mutinynet.arkade.sh/address/tark1qexample',
    )
  })

  it('sends regtest to the local explorer rather than a public one', () => {
    // A regtest lockup exists on nobody else's node; a public explorer would
    // answer "not found" and read as lost funds.
    expect(arkadeTxUrl('regtest', 'abc123')).toBe('http://localhost:7080/tx/abc123')
  })
})

describe('onchain explorer urls', () => {
  it('sends an L1 txid to the mempool instance, not the Arkade one', () => {
    // An Arkade explorer cannot show a Bitcoin L1 transaction at all, so the
    // onchain corridors need their own base or their links are dead.
    expect(onchainTxUrl('bitcoin', 'deadbeef')).toBe('https://mempool.arkade.sh/tx/deadbeef')
    expect(onchainTxUrl('signet', 'deadbeef')).toBe('https://mempool.signet.arkade.sh/tx/deadbeef')
    expect(onchainTxUrl('regtest', 'deadbeef')).toBe('http://localhost:3000/tx/deadbeef')
  })

  it('is a different host from the arkade explorer on every network', () => {
    for (const network of ALL) {
      expect(NETWORKS[network].explorers.onchain, network).not.toBe(NETWORKS[network].explorers.arkade)
    }
  })
})

describe('url building', () => {
  it('refuses an empty identifier rather than linking to the explorer root', () => {
    // A bare base URL looks like a working link and lands on the home page,
    // which is worse than no link at all when someone is chasing a txid.
    expect(arkadeTxUrl('bitcoin', '')).toBeNull()
    expect(arkadeAddressUrl('bitcoin', '   ')).toBeNull()
    expect(onchainTxUrl('bitcoin', '')).toBeNull()
  })

  it('encodes the identifier, so nothing in it can escape the path', () => {
    expect(arkadeTxUrl('bitcoin', 'a/../b')).toBe('https://arkade.space/tx/a%2F..%2Fb')
  })
})
