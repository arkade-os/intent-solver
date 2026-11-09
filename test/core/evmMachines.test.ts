import { describe, it, expect } from 'vitest'
import {
  EvmReceiveMachine,
  EvmSendMachine,
  EVM_RECEIVE_EXPOSED,
  EVM_RECEIVE_NON_TERMINAL,
  EVM_SEND_EXPOSED,
  EVM_SEND_NON_TERMINAL,
} from '@arkade-os/solver-core/core/evmSwapState.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { EvmReceiveSwapStore } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

// Copied from `Edges` in spec/tla/EvmSend.tla and EvmReceive.tla; a change here is a change there.
const SEND_EDGES = {
  quoted: ['locking_evm', 'claiming', 'refused', 'stuck'],
  funded: ['locking_evm', 'claiming', 'refused', 'stuck'],
  locking_evm: ['awaiting_claim', 'claiming', 'refunding_evm', 'stuck'],
  awaiting_claim: ['claiming', 'refunding_evm', 'stuck'],
  claiming: ['claimed', 'stuck'],
  claimed: [],
  refunding_evm: ['claiming', 'refunded', 'stuck'],
  refunded: [],
  refused: [],
  stuck: [],
}

const RECEIVE_EDGES = {
  quoted: ['funding_arkade', 'claiming', 'refused', 'stuck'],
  awaiting_lock: ['funding_arkade', 'claiming', 'refused', 'stuck'],
  locked: ['funding_arkade', 'claiming', 'refused', 'stuck'],
  funding_arkade: ['awaiting_claim', 'claiming', 'stuck'],
  awaiting_claim: ['claiming', 'refunding_arkade', 'stuck'],
  claiming: ['claimed', 'stuck'],
  claimed: [],
  refunding_arkade: ['claiming', 'refunded', 'stuck'],
  refunded: [],
  refused: [],
  stuck: [],
}

const sorted = (edges: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(Object.entries(edges).map(([from, to]) => [from, [...to].sort()]))

describe('EVM state machines', () => {
  it('carry exactly the edges the TLA+ models check', () => {
    expect(sorted(EvmSendMachine.edges)).toEqual(sorted(SEND_EDGES))
    expect(sorted(EvmReceiveMachine.edges)).toEqual(sorted(RECEIVE_EDGES))
  })

  it('reach stuck from every live state, which operator park relies on', () => {
    for (const machine of [EvmSendMachine, EvmReceiveMachine] as const) {
      for (const state of machine.live) expect(machine.edges[state as never]).toContain('stuck')
    }
  })

  it('are the single source of the live and exposed lists', () => {
    expect(EVM_SEND_NON_TERMINAL).toEqual(EvmSendMachine.live)
    expect(EVM_SEND_EXPOSED).toEqual(EvmSendMachine.exposed)
    expect(EVM_RECEIVE_NON_TERMINAL).toEqual(EvmReceiveMachine.live)
    expect(EVM_RECEIVE_EXPOSED).toEqual(EvmReceiveMachine.exposed)
    expect(EvmSendMachine.terminal).toEqual(['claimed', 'refunded', 'refused', 'stuck'])
    expect(EvmReceiveMachine.terminal).toEqual(['claimed', 'refunded', 'refused', 'stuck'])
  })
})

describe('EVM stores enforce the machine', () => {
  const quote = {
    id: 'swap-1',
    rfqId: 'rfq-1',
    paymentHash: 'aa'.repeat(32),
    amountSats: 50_000,
    payoutSats: 50_000,
    evmAmount: '1000000',
    tokenAddress: '0x' + '11'.repeat(20),
    evmContractAddress: '0x' + '22'.repeat(20),
    evmChainId: 31337,
    evmTimeout: 1_000,
    validUntil: 2_000,
    minConfirmations: 1,
    minAgeSeconds: 0,
    evmClaimAddress: '0x' + '33'.repeat(20),
    evmRefundAddress: '0x' + '44'.repeat(20),
    refundLocktime: 3_000,
    providerPubkey: '02' + '55'.repeat(32),
    serverPubkey: '02' + '66'.repeat(32),
    claimDelay: 10,
    refundDelay: 20,
    refundWithoutReceiverDelay: 30,
    pkScript: '5120' + '77'.repeat(32),
    lockupAddress: 'tark1lockup',
    refundPkScript: '5120' + '88'.repeat(32),
    emulatorPubkey: '02' + '99'.repeat(32),
    clientRefundPubkey: '02' + 'aa'.repeat(32),
    receiverPkScript: '5120' + 'bb'.repeat(32),
    nonInteractiveParameters: true,
    payoutPubkey: '02' + 'cc'.repeat(32),
  }

  it('refuses an edge the send machine lacks, before touching the row', async () => {
    const store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => 1)
    await store.insertQuote(quote as never)
    await expect(store.transition('swap-1', 'quoted', 'claimed')).rejects.toThrow(
      /illegal transition quoted -> claimed/,
    )
    expect((await store.get('swap-1')).state).toBe('quoted')
  })

  it('refuses leaving a terminal receive state', async () => {
    const store = await EvmReceiveSwapStore.open(betterSqliteDriver(':memory:'), () => 1)
    await store.insertQuote(quote as never)
    await store.transition('swap-1', 'quoted', 'refused')
    await expect(store.transition('swap-1', 'refused', 'stuck')).rejects.toThrow(/illegal transition refused -> stuck/)
  })
})
