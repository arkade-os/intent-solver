import { describe, it, expect } from 'vitest'
import { AssetRfqMachine } from '@arkade-os/solver-corridors/machines/assetRfq.js'
import { NON_TERMINAL, EXPOSED } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'

describe('AssetRfqMachine', () => {
  it('declares the lifecycle the store enforced before it existed', () => {
    expect(AssetRfqMachine.edges).toEqual({
      quoted: ['funded', 'refused'],
      funded: ['filling', 'refused'],
      filling: ['filled', 'stuck'],
      filled: [],
      refused: [],
      stuck: [],
    })
    expect(AssetRfqMachine.live).toEqual(['quoted', 'funded', 'filling'])
    expect(AssetRfqMachine.exposed).toEqual(['filling'])
  })

  it('names the states the SQL used to spell out', () => {
    expect(AssetRfqMachine.where('holdsOfferScript')).toEqual(['quoted', 'funded', 'filling', 'filled'])
    expect(AssetRfqMachine.where('outgoing')).toEqual(['filling'])
  })

  it('is the single lifecycle source the store reads from', () => {
    expect(NON_TERMINAL).toEqual(AssetRfqMachine.live)
    expect(EXPOSED).toEqual(AssetRfqMachine.exposed)
  })
})
