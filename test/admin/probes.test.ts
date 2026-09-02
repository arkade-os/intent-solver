import { describe, it, expect } from 'vitest'
import { probeBackends } from '@arkade-os/solver-app/admin/probes.js'

const servicesWith = (
  onchain: Partial<{
    estimateFeeRate: () => Promise<number>
    getBalance: () => Promise<{ confirmedSats: number; unconfirmedSats: number }>
  }>,
) =>
  ({
    config: { lnBackend: 'lnd', arkade: { arkServerUrl: 'http://ark' }, emulatorUrl: 'http://emu' },
    ln: { getBalance: async () => ({ availableSats: 1, incomingSats: 0 }) },
    arkade: { wallet: { getAddress: async () => 'tark1x' } },
    emulatorPubkey: 'ab'.repeat(16),
    onchain: {
      estimateFeeRate: async () => 7,
      getBalance: async () => ({ confirmedSats: 250_000, unconfirmedSats: 10_000 }),
      ...onchain,
    },
  }) as never

describe('the onchain probe', () => {
  it('reports the wallet balance beside the fee rate', async () => {
    const backends = await probeBackends(servicesWith({}))
    const onchain = backends.find((b) => b.name === 'onchain')
    expect(onchain?.ok).toBe(true)
    expect(onchain?.detail).toContain('250000 sat confirmed')
    expect(onchain?.detail).toContain('10000 sat unconfirmed')
    expect(onchain?.detail).toContain('7 sat/vB')
  })

  // A corridor that cannot see its own funds is not healthy. Reporting the fee
  // rate alone would render a green row for a backend that cannot fund anything.
  it('fails the probe when the balance cannot be read', async () => {
    const backends = await probeBackends(
      servicesWith({
        getBalance: async () => {
          throw new Error('wallet locked')
        },
      }),
    )
    const onchain = backends.find((b) => b.name === 'onchain')
    expect(onchain?.ok).toBe(false)
    expect(onchain?.error).toContain('wallet locked')
  })
})
