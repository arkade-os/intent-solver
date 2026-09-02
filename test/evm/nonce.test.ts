import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { createNonceSource, type NonceReader } from '@arkade-os/solver-rails-evm/evm/nonce.js'

const ADDR = hex.decode('1111111111111111111111111111111111111111')
const OTHER = hex.decode('2222222222222222222222222222222222222222')

/** A chain whose two counters can be set independently, as a real node's are. */
const chain = (initial: { latest?: bigint; pending?: bigint } = {}) => {
  const state = { latest: initial.latest ?? 0n, pending: initial.pending ?? initial.latest ?? 0n }
  const reads: ('latest' | 'pending')[] = []
  const read: NonceReader = async (_address, block) => {
    reads.push(block)
    return state[block]
  }
  return { state, reads, read }
}

describe('createNonceSource', () => {
  it('asks the chain for `pending`, not `latest`', async () => {
    // `latest` counts only mined transactions, so back-to-back sends would
    // reuse a nonce and the second would replace the first.
    const c = chain({ latest: 5n, pending: 7n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(7n)
    expect(c.reads).toEqual(['pending'])
  })

  it('hands out consecutive nonces without waiting for the chain to catch up', async () => {
    // The core case: a tick that funds a lock and claims another swap issues
    // two transactions before either is mined.
    const c = chain({ pending: 3n })
    const source = createNonceSource(c.read)
    expect([await source.next(ADDR), await source.next(ADDR), await source.next(ADDR)]).toEqual([3n, 4n, 5n])
  })

  /**
   * The failure this module exists for.
   *
   * A node that has forgotten our pending transactions — restarted, evicted the
   * mempool, or simply a different endpoint behind the same URL — reports a
   * LOWER pending count. Trusting it reissues nonces we have already broadcast,
   * and each reissue is a replacement of a transaction the solver believes it
   * sent.
   */
  it('never goes backwards when the chain forgets what we broadcast', async () => {
    const c = chain({ pending: 10n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(10n)
    expect(await source.next(ADDR)).toBe(11n)

    c.state.pending = 10n // the mempool lost them
    expect(await source.next(ADDR)).toBe(12n)
  })

  it('moves forward when the chain knows more than we do', async () => {
    // The mark is a floor, not a substitute. Another process spending from the
    // same key, or our own transactions being mined, must be respected.
    const c = chain({ pending: 4n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(4n)

    c.state.pending = 20n
    expect(await source.next(ADDR)).toBe(20n)
    expect(await source.next(ADDR)).toBe(21n)
  })

  it('tracks addresses independently', async () => {
    const c = chain({ pending: 1n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(1n)
    expect(await source.next(ADDR)).toBe(2n)
    // A second address starts from the chain, not from the first's mark.
    expect(await source.next(OTHER)).toBe(1n)
  })
})

describe('address validation', () => {
  it('refuses a mis-shaped address at the point of use', async () => {
    // Downstream the signer would catch it, but by then the error points at
    // signing rather than at the caller that passed the wrong slice.
    const source = createNonceSource(chain().read)
    await expect(source.next(new Uint8Array(19))).rejects.toThrow(/must be 20 bytes, got 19/)
    await expect(source.next(new Uint8Array(0))).rejects.toThrow(/must be 20 bytes, got 0/)
    expect(() => source.release(new Uint8Array(32), 1n)).toThrow(/must be 20 bytes, got 32/)
  })
})

describe('release', () => {
  it('returns the top nonce so a never-broadcast transaction leaves no gap', async () => {
    // A signature rejected locally, or a transport error before submission.
    // Without this the nonce is burnt and every later transaction from the
    // address queues behind a gap that will never be filled.
    const c = chain({ pending: 8n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(8n)
    source.release(ADDR, 8n)
    expect(await source.next(ADDR)).toBe(8n)
  })

  it('ignores a release that is not the top, which would create a gap', async () => {
    // Returning 8 while 9 is outstanding would hand 8 out again AND leave 9
    // issued — two transactions racing for one slot.
    const c = chain({ pending: 8n })
    const source = createNonceSource(c.read)
    await source.next(ADDR) // 8
    await source.next(ADDR) // 9
    source.release(ADDR, 8n)
    expect(await source.next(ADDR)).toBe(10n)
  })

  it('lets the chain overtake a released slot rather than reissuing it', async () => {
    // The interaction the two rules have to agree on: release rewinds the mark,
    // but the mark is only ever a FLOOR. If the chain has moved past the
    // released slot in the meantime — someone else spent from the key, or our
    // own sends were mined — the chain wins and the released nonce is simply
    // gone. Reissuing it would collide with whatever already occupies it.
    const c = chain({ pending: 8n })
    const source = createNonceSource(c.read)
    expect(await source.next(ADDR)).toBe(8n)
    c.state.pending = 15n
    source.release(ADDR, 8n)
    expect(await source.next(ADDR)).toBe(15n)
  })

  it('ignores a release for an address it has never issued for', async () => {
    const c = chain({ pending: 2n })
    const source = createNonceSource(c.read)
    source.release(ADDR, 99n)
    expect(await source.next(ADDR)).toBe(2n)
  })
})
