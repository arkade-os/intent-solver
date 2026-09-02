/**
 * The two invariants every corridor's state machine shares, asserted for the
 * EVM pair because they are the ones that cost money when wrong.
 *
 * Exposure too WIDE prices bids against float that is not committed. Too NARROW
 * lets the solver commit past its own cap. Non-terminal too narrow lets a live
 * swap fall out of the exposure accounting entirely.
 */

import { describe, it, expect } from 'vitest'
import {
  EVM_RECEIVE_EXPOSED,
  EVM_RECEIVE_NON_TERMINAL,
  EVM_SEND_EXPOSED,
  EVM_SEND_NON_TERMINAL,
  type EvmReceiveSwapState,
  type EvmSendSwapState,
} from '@arkade-os/solver-core/core/evmSwapState.js'

const TERMINAL_SEND: readonly EvmSendSwapState[] = ['claimed', 'refunded', 'refused', 'stuck']
const TERMINAL_RECEIVE: readonly EvmReceiveSwapState[] = ['claimed', 'refunded', 'refused', 'stuck']

describe('EVM swap states', () => {
  it('treats exposure as a SUBSET of non-terminal, never the other way round', () => {
    // A state that exposes money but is considered terminal would drop a live
    // commitment out of the cap the moment it mattered most.
    for (const state of EVM_SEND_EXPOSED) expect(EVM_SEND_NON_TERMINAL).toContain(state)
    for (const state of EVM_RECEIVE_EXPOSED) expect(EVM_RECEIVE_NON_TERMINAL).toContain(state)
  })

  it('does not count a quote as exposure, on either side', () => {
    // A quoted row has cost the solver nothing. Counting it would price bids
    // against money still in the float.
    expect(EVM_SEND_EXPOSED).not.toContain('quoted')
    expect(EVM_RECEIVE_EXPOSED).not.toContain('quoted')
  })

  it('exposes the send side from the moment the ERC20 lock is submitted', () => {
    // Not from when it confirms. A revert is not observable until mined, so the
    // tokens are at risk the moment the call goes out.
    expect(EVM_SEND_EXPOSED).toContain('locking_evm')
  })

  it('does not expose the receive side merely because the CLIENT has locked', () => {
    // `locked` is the client's ERC20 sitting in the contract — it costs the
    // solver nothing. Exposure starts when sats are committed against it.
    expect(EVM_RECEIVE_EXPOSED).not.toContain('locked')
    expect(EVM_RECEIVE_EXPOSED).not.toContain('awaiting_lock')
    expect(EVM_RECEIVE_EXPOSED).toContain('funding_arkade')
  })

  it('keeps stuck out of both, so one incident cannot starve the cap', () => {
    // Same call every other corridor makes: a stuck row is a pager, not a live
    // swap, and counting it would hold the cap down until a human cleared it.
    expect(EVM_SEND_NON_TERMINAL).not.toContain('stuck')
    expect(EVM_RECEIVE_NON_TERMINAL).not.toContain('stuck')
  })

  it('leaves no state both terminal and non-terminal', () => {
    for (const state of TERMINAL_SEND) expect(EVM_SEND_NON_TERMINAL).not.toContain(state)
    for (const state of TERMINAL_RECEIVE) expect(EVM_RECEIVE_NON_TERMINAL).not.toContain(state)
  })
})
