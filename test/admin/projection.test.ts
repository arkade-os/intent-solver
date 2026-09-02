import { describe, it, expect } from 'vitest'
import {
  phaseOf,
  projectSend,
  projectReceive,
  projectOnchainSend,
  projectOnchainReceive,
} from '../../src/admin/projection.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import type { SendSwapRow } from '@arkade-os/solver-corridors/db/swaps.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import type { OnchainSendSwapRow } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import type { OnchainReceiveSwapRow } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'

describe('phaseOf — the claimed collision', () => {
  it('reads claimed as done on both SEND corridors, where it is terminal', () => {
    expect(phaseOf('arkade:BTC->lightning:BTC', 'claimed')).toBe('done')
    expect(phaseOf('arkade:BTC->onchain:BTC', 'claimed')).toBe('done')
  })

  it('reads the SAME word as still-exposed on both RECEIVE corridors', () => {
    expect(phaseOf('lightning:BTC->arkade:BTC', 'claimed')).toBe('exposed')
    expect(phaseOf('onchain:BTC->arkade:BTC', 'claimed')).toBe('exposed')
  })
})

describe('phaseOf — the rest of the vocabulary', () => {
  it('classifies quoted as open on every corridor', () => {
    for (const corridor of CORRIDORS) expect(phaseOf(corridor, 'quoted')).toBe('open')
  })

  it('classifies stuck and refused as failed on every corridor', () => {
    for (const corridor of CORRIDORS) {
      expect(phaseOf(corridor, 'stuck')).toBe('failed')
      expect(phaseOf(corridor, 'refused')).toBe('failed')
    }
  })

  it('classifies a recovered refund as failed, not done — the swap did not deliver', () => {
    expect(phaseOf('lightning:BTC->arkade:BTC', 'refunded')).toBe('failed')
    expect(phaseOf('arkade:BTC->onchain:BTC', 'refunded')).toBe('failed')
    expect(phaseOf('onchain:BTC->arkade:BTC', 'refunded')).toBe('failed')
  })

  it('classifies the mid-flight exposed states as exposed', () => {
    expect(phaseOf('arkade:BTC->lightning:BTC', 'paying')).toBe('exposed')
    expect(phaseOf('arkade:BTC->lightning:BTC', 'paid')).toBe('exposed')
    expect(phaseOf('lightning:BTC->arkade:BTC', 'funded')).toBe('exposed')
    expect(phaseOf('arkade:BTC->onchain:BTC', 'funding_onchain')).toBe('exposed')
    expect(phaseOf('onchain:BTC->arkade:BTC', 'funding_arkade')).toBe('exposed')
  })

  it('classifies settled as done on the two corridors that have it', () => {
    expect(phaseOf('lightning:BTC->arkade:BTC', 'settled')).toBe('done')
    expect(phaseOf('onchain:BTC->arkade:BTC', 'settled')).toBe('done')
  })

  it('falls to failed on an unknown state rather than silently calling it done', () => {
    expect(phaseOf('arkade:BTC->lightning:BTC', 'not_a_real_state')).toBe('failed')
  })
})

describe('projection', () => {
  it('carries the corridor-native state word through verbatim', () => {
    const row = {
      id: 'a',
      state: 'claimed',
      createdAt: 10,
      updatedAt: 20,
      paymentHash: 'aa',
      amountSats: 1_000,
      failureReason: null,
    } as SendSwapRow
    expect(projectSend(row)).toMatchObject({
      id: 'a',
      corridor: 'arkade:BTC->lightning:BTC',
      state: 'claimed',
      phase: 'done',
      amountSats: 1_000,
      payoutSats: null,
    })
  })

  it('projects the same word to a different phase on the receive leg', () => {
    const row = {
      id: 'b',
      state: 'claimed',
      createdAt: 10,
      updatedAt: 20,
      paymentHash: 'bb',
      amountSats: 1_000,
      payoutSats: 990,
      failureReason: null,
    } as ReceiveSwapRow
    expect(projectReceive(row)).toMatchObject({ state: 'claimed', phase: 'exposed', payoutSats: 990 })
  })

  it('projects both onchain corridors', () => {
    const send = {
      id: 'c',
      state: 'funding_onchain',
      createdAt: 1,
      updatedAt: 2,
      paymentHash: 'cc',
      amountSats: 5_000,
      payoutSats: 4_900,
      failureReason: null,
    } as OnchainSendSwapRow
    const receive = {
      id: 'd',
      state: 'settled',
      createdAt: 1,
      updatedAt: 2,
      paymentHash: 'dd',
      amountSats: 5_000,
      payoutSats: 4_900,
      failureReason: null,
    } as OnchainReceiveSwapRow
    expect(projectOnchainSend(send)).toMatchObject({ corridor: 'arkade:BTC->onchain:BTC', phase: 'exposed' })
    expect(projectOnchainReceive(receive)).toMatchObject({ corridor: 'onchain:BTC->arkade:BTC', phase: 'done' })
  })

  it('presents a refunded refusal as refunded on both send corridors', () => {
    const send = {
      id: 'f',
      state: 'refused',
      refundOutcome: 'pushed',
      createdAt: 1,
      updatedAt: 2,
      paymentHash: 'ff',
      amountSats: 1_000,
      failureReason: 'lockup timeout',
    } as SendSwapRow
    expect(projectSend(send)).toMatchObject({ state: 'refunded', phase: 'failed' })
    const onchainSend = { ...send, payoutSats: 990 } as unknown as OnchainSendSwapRow
    expect(projectOnchainSend(onchainSend)).toMatchObject({ state: 'refunded', phase: 'failed' })
  })

  it('keeps a refunded STUCK row spelled stuck — the operator still has to look', () => {
    const row = {
      id: 'g',
      state: 'stuck',
      refundOutcome: 'pushed',
      createdAt: 1,
      updatedAt: 2,
      paymentHash: 'gg',
      amountSats: 1_000,
      failureReason: 'lightning payment failed terminally',
    } as SendSwapRow
    expect(projectSend(row)).toMatchObject({ state: 'stuck', phase: 'failed' })
  })

  it('surfaces a failure reason when the row carries one', () => {
    const row = {
      id: 'e',
      state: 'stuck',
      createdAt: 1,
      updatedAt: 2,
      paymentHash: 'ee',
      amountSats: 1_000,
      failureReason: 'claim deadline passed',
    } as SendSwapRow
    expect(projectSend(row)).toMatchObject({ phase: 'failed', failureReason: 'claim deadline passed' })
  })
})
