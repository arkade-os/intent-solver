import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createBalanceSampler, createSwapOutcomeReporter } from '@arkade-os/solver-app/ops/businessEvents.js'

const LN_SEND = {
  live: ['quoted', 'funded', 'paying', 'paid', 'claiming'],
  exposed: ['paying', 'paid', 'claiming'],
  delivered: ['claimed'],
}

const sampler = (availableSats = 1_000_000, committedSats = 0, at = 1_000) => ({
  current: () => ({ availableSats, committedSats, at }),
})

const memoryBalanceStore = (initial: number | null = null) => {
  let last = initial
  return {
    getLastAnnouncedBalance: async () => last,
    setLastAnnouncedBalance: async (sats: number) => void (last = sats),
  }
}

const reporter = (over: Record<string, unknown> = {}) => {
  const posted: string[] = []
  const report = createSwapOutcomeReporter({
    corridor: 'arkade:BTC->lightning:BTC',
    states: LN_SEND,
    balances: sampler(),
    store: memoryBalanceStore(),
    post: (text: string) => posted.push(text),
    now: () => 2_000,
    ...over,
  })
  return { report, posted }
}

// The reporter defers through `queueMicrotask`, so an EMPTY assertion must drain
// first: `vi.waitFor` on an already-true assertion returns at t=0 and proves nothing.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('createSwapOutcomeReporter', () => {
  it('says NOTHING about a transition that is still in flight', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-1', from: 'quoted', to: 'funded' })
    report({ id: 'swap-1', from: 'funded', to: 'paying' })
    await settle()
    expect(posted).toEqual([])
  })

  // Proves the drain above is real: the same shape WITH a terminal state posts.
  it('and the same assertion catches a post that should not have happened', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await settle()
    expect(posted).toHaveLength(1)
  })

  it('announces a fulfilled swap with the corridor and the id', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('fulfilled')
    expect(posted[0]).toContain('arkade:BTC->lightning:BTC')
    expect(posted[0]).toContain('swap-1')
  })

  it('announces a failure, naming the state it landed in', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-2', from: 'paying', to: 'stuck' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatch(/failed/i)
    expect(posted[0]).toContain('stuck')
  })

  it('carries the balances', async () => {
    const { report, posted } = reporter({ balances: sampler(2_500_000, 40_000) })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('2,500,000')
    expect(posted[0]).toContain('40,000')
  })

  it('reports n/a on the FIRST event, not a misleading +0%', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('n/a')
    expect(posted[0]).not.toContain('+0.00%')
  })

  it('reports the change against the previously ANNOUNCED balance', async () => {
    const store = memoryBalanceStore(1_000_000)
    const { report, posted } = reporter({ balances: sampler(1_100_000), store })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('+10.00%')
  })

  it('persists the new balance so the NEXT event compares against it', async () => {
    const store = memoryBalanceStore(1_000_000)
    const { report } = reporter({ balances: sampler(1_100_000), store })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(async () => expect(await store.getLastAnnouncedBalance()).toBe(1_100_000))
  })

  it('says how stale the balance reading is', async () => {
    const { report, posted } = reporter({ balances: sampler(1_000, 0, 1_400), now: () => 2_000 })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('600s')
  })

  it('still announces when no balance has been sampled yet', async () => {
    const { report, posted } = reporter({ balances: { current: () => null } })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('unread')
  })

  // The money path calls this synchronously; nothing it does may surface there.
  it('never throws at the caller, even when the store is broken', () => {
    const { report } = reporter({
      store: {
        getLastAnnouncedBalance: async () => {
          throw new Error('database is locked')
        },
        setLastAnnouncedBalance: async () => {},
      },
    })
    expect(() => report({ id: 'swap-1', from: 'claiming', to: 'claimed' })).not.toThrow()
  })

  it('returns synchronously without awaiting the store', () => {
    let touched = false
    const { report } = reporter({
      store: {
        getLastAnnouncedBalance: async () => {
          touched = true
          return null
        },
        setLastAnnouncedBalance: async () => {},
      },
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    expect(touched).toBe(false)
  })
})

describe('createBalanceSampler', () => {
  it('has no reading before the first sample', () => {
    const s = createBalanceSampler({
      readAvailableSats: async () => 5,
      readCommittedSats: async () => 1,
      now: () => 10,
    })
    expect(s.current()).toBeNull()
  })

  it('caches the reading so the event path never touches the wallet', async () => {
    const readAvailableSats = vi.fn().mockResolvedValue(900)
    const s = createBalanceSampler({ readAvailableSats, readCommittedSats: async () => 100, now: () => 10 })
    await s.sample()
    expect(s.current()).toEqual({ availableSats: 900, committedSats: 100, at: 10 })
    s.current()
    s.current()
    expect(readAvailableSats).toHaveBeenCalledTimes(1)
  })

  // A sampler that threw would kill whatever timer drives it.
  it('keeps the previous reading when a sample fails, and does not throw', async () => {
    let fail = false
    const s = createBalanceSampler({
      readAvailableSats: async () => {
        if (fail) throw new Error('indexer down')
        return 900
      },
      readCommittedSats: async () => 100,
      now: () => 10,
    })
    await s.sample()
    fail = true
    await expect(s.sample()).resolves.toBeUndefined()
    expect(s.current()).toMatchObject({ availableSats: 900 })
  })
})

// A sampler nobody drives reports `unread` forever, and that is invisible at run
// time. It shipped that way in review here, as did the asset stores' wiring.
describe('the balance sampler is DRIVEN on the shipped daemon', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
  const servicesSource = read('../../packages/solver-app/src/ops/services.ts')
  const cliSource = read('../../packages/solver-app/src/cli.ts')

  it('services exposes sampleBalances only when a sink is configured', () => {
    expect(servicesSource).toMatch(
      /sampleBalances: notifySinks\.length > 0 \? \(\) => balances\.sample\(\) : undefined/,
    )
  })

  it('the watch loop calls it on its own cadence', () => {
    expect(cliSource).toMatch(/services\.sampleBalances && Date\.now\(\) - lastBalanceSample > BALANCE_SAMPLE_MS/)
    expect(cliSource).toMatch(/await services\.sampleBalances\(\)/)
  })
})
