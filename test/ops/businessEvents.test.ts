import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  btcSwapSize,
  createBalanceSampler,
  createSwapOutcomeReporter,
  formatAmount,
  type BalanceReading,
  type SwapTerms,
} from '@arkade-os/solver-app/ops/businessEvents.js'

const LN_SEND = {
  live: ['quoted', 'funded', 'paying', 'paid', 'claiming'],
  exposed: ['paying', 'paid', 'claiming'],
  delivered: ['claimed'],
}

const LN_RECEIVE = {
  live: ['quoted', 'armed', 'funded', 'claimed', 'refunding'],
  exposed: ['funded', 'claimed', 'refunding'],
  delivered: ['settled'],
}

const reading = (over: Partial<BalanceReading> = {}): BalanceReading => ({
  arkade: { value: 1_000_000, at: 1_000 },
  lightning: { value: { availableSats: 2_000_000, incomingSats: 3_000_000 }, at: 1_000 },
  onchain: null,
  ...over,
})

const sampler = (over: Partial<BalanceReading> = {}) => ({
  current: () => reading(over),
})

const terms = (size = 'amount 10,000 sats', failureReason: string | null = null): SwapTerms => ({
  size,
  failureReason,
})

const reporter = (over: Record<string, unknown> = {}) => {
  const posted: string[] = []
  const report = createSwapOutcomeReporter({
    corridor: 'arkade:BTC->lightning:BTC',
    states: LN_SEND,
    balances: sampler(),
    lightningName: 'spark',
    terms: async () => terms(),
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
    expect(posted[0]).toContain('Swap fulfilled')
    expect(posted[0]).toContain('arkade:BTC->lightning:BTC')
    expect(posted[0]).toContain('swap-1')
  })

  it('does not page a refusal — never funded, nothing moved', async () => {
    const readTerms = vi.fn()
    const { report, posted } = reporter({ terms: readTerms })
    report({ id: 'swap-2', from: 'quoted', to: 'refused' })
    await settle()
    expect(posted).toEqual([])
    expect(readTerms).not.toHaveBeenCalled()
  })

  it('does not page a refund or an offer somebody else took', async () => {
    const refunded = reporter({ corridor: 'lightning:BTC->arkade:BTC', states: LN_RECEIVE })
    refunded.report({ id: 'swap-3', from: 'refunding', to: 'refunded' })
    const lost = reporter({
      corridor: 'arkade offer fill',
      states: { live: ['fillable', 'filling'], exposed: [], delivered: ['filled'] },
    })
    lost.report({ id: 'fill-1', from: 'fillable', to: 'lost' })
    await settle()
    expect(refunded.posted).toEqual([])
    expect(lost.posted).toEqual([])
  })

  it('pages a stuck swap with the amount, the payout, and both floats', async () => {
    const { report, posted } = reporter({
      corridor: 'lightning:BTC->arkade:BTC',
      balances: sampler({
        arkade: { value: 5_074_074, at: 1_960 },
        lightning: { value: { availableSats: 1_200_000, incomingSats: 800_000 }, at: 1_960 },
      }),
      terms: async () => terms(btcSwapSize(80_362, 80_000), 'could not settle the hold'),
    })
    report({ id: '29975e63-b613-44fe-a392-43d5025b1f11', from: 'funded', to: 'stuck' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toBe(
      [
        'Swap STUCK — lightning:BTC->arkade:BTC — 29975e63-b613-44fe-a392-43d5025b1f11',
        'amount 80,362 sats -> payout 80,000 sats',
        'reason: could not settle the hold',
        'Lightning (spark): 1,200,000 sats available, 800,000 sats incoming (40s old)',
        'Arkade: 5,074,074 sats available (40s old)',
      ].join('\n'),
    )
  })

  it('does not call the in-flight exposure a balance', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).not.toContain('committed')
    expect(posted[0]).not.toContain('change since')
  })

  it('names the Lightning rail, and the send leg omits a payout it does not record', async () => {
    const { report, posted } = reporter({ terms: async () => terms(btcSwapSize(71_945, null)) })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('amount 71,945 sats')
    expect(posted[0]).not.toContain('payout')
    expect(posted[0]).toContain('Lightning (spark): 2,000,000 sats available, 3,000,000 sats incoming')
    expect(posted[0]).toContain('Arkade: 1,000,000 sats available')
  })

  it('shows the onchain float on an onchain corridor, including a shared pool', async () => {
    const { report, posted } = reporter({
      corridor: 'arkade:BTC->onchain:BTC',
      balances: sampler({
        onchain: { value: { confirmedSats: 500_000, sharedWithLightning: true }, at: 1_000 },
      }),
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('Onchain: 500,000 sats confirmed, same pool as Lightning (spark)')
    expect(posted[0]).toContain('Arkade: 1,000,000 sats available')
    expect(posted[0]).not.toContain('sats incoming')
  })

  it('still pages a terminal state it has never heard of', async () => {
    const { report, posted } = reporter()
    report({ id: 'swap-9', from: 'funded', to: 'invented' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('ended in invented')
  })

  it('says how stale each float reading is', async () => {
    const { report, posted } = reporter({
      balances: sampler({
        arkade: { value: 1_000, at: 1_400 },
        lightning: { value: { availableSats: 2, incomingSats: 3 }, at: 1_400 },
      }),
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('600s old')
  })

  it('still announces when no balance has been sampled yet', async () => {
    const { report, posted } = reporter({ balances: { current: () => null } })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('unread')
  })

  it('names a float that failed to sample without dropping the other', async () => {
    const { report, posted } = reporter({
      balances: sampler({ lightning: null }),
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('Lightning (spark): unread')
    expect(posted[0]).toContain('Arkade: 1,000,000 sats available')
  })

  it('still announces when the swap row cannot be read', async () => {
    const errors: unknown[] = []
    const { report, posted } = reporter({
      terms: async () => {
        throw new Error('database is locked')
      },
      onError: (error: unknown) => errors.push(error),
    })
    report({ id: 'swap-1', from: 'paying', to: 'stuck' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toContain('Swap STUCK')
    expect(posted[0]).toContain('amount unread')
    expect(errors).toHaveLength(1)
  })

  it('leaves a fulfilled swap without a failure reason', async () => {
    const { report, posted } = reporter({
      terms: async () => terms('amount 5 sats', 'old failure that is not why this ended'),
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    await vi.waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).not.toContain('reason:')
  })

  // The money path calls this synchronously; nothing it does may surface there.
  it('never throws at the caller, even when the swap row is unreadable', () => {
    const { report } = reporter({
      terms: async () => {
        throw new Error('database is locked')
      },
    })
    expect(() => report({ id: 'swap-1', from: 'claiming', to: 'claimed' })).not.toThrow()
  })

  it('returns synchronously without reading the swap row', () => {
    let touched = false
    const { report } = reporter({
      terms: async () => {
        touched = true
        return terms()
      },
    })
    report({ id: 'swap-1', from: 'claiming', to: 'claimed' })
    expect(touched).toBe(false)
  })
})

describe('formatAmount', () => {
  it('groups a safe integer and leaves a larger one exact', () => {
    expect(formatAmount(1_000n, 'sats')).toBe('1,000 sats')
    expect(formatAmount(9007199254740993n, 'USDC')).toBe('9007199254740993 USDC')
  })
})

describe('createBalanceSampler', () => {
  it('has no reading before the first sample', () => {
    const s = createBalanceSampler({
      readArkadeAvailableSats: async () => 5,
      now: () => 10,
    })
    expect(s.current()).toBeNull()
  })

  it('caches the reading so the event path never touches the wallet', async () => {
    const readArkadeAvailableSats = vi.fn().mockResolvedValue(900)
    const readLightning = vi.fn().mockResolvedValue({ availableSats: 10, incomingSats: 20 })
    const s = createBalanceSampler({
      readArkadeAvailableSats,
      readLightning,
      readOnchain: async () => ({ confirmedSats: 30, sharedWithLightning: false }),
      now: () => 10,
    })
    await s.sample()
    expect(s.current()).toEqual({
      arkade: { value: 900, at: 10 },
      lightning: { value: { availableSats: 10, incomingSats: 20 }, at: 10 },
      onchain: { value: { confirmedSats: 30, sharedWithLightning: false }, at: 10 },
    })
    s.current()
    s.current()
    expect(readArkadeAvailableSats).toHaveBeenCalledTimes(1)
    expect(readLightning).toHaveBeenCalledTimes(1)
  })

  // A sampler that threw would kill whatever timer drives it. One side failing
  // must not blank the side that answered.
  it('keeps the previous reading when a sample fails, and does not throw', async () => {
    let failLightning = false
    const s = createBalanceSampler({
      readArkadeAvailableSats: async () => 900,
      readLightning: async () => {
        if (failLightning) throw new Error('node down')
        return { availableSats: 10, incomingSats: 20 }
      },
      now: () => 10,
    })
    await s.sample()
    failLightning = true
    await expect(s.sample()).resolves.toBeUndefined()
    expect(s.current()).toMatchObject({
      arkade: { value: 900 },
      lightning: { value: { availableSats: 10, incomingSats: 20 } },
    })
  })

  it('shares one wallet read between overlapping samples', async () => {
    let release!: (sats: number) => void
    const readArkadeAvailableSats = vi.fn(() => new Promise<number>((resolve) => (release = resolve)))
    const s = createBalanceSampler({ readArkadeAvailableSats, now: () => 10 })
    const first = s.sample()
    const second = s.sample()
    expect(readArkadeAvailableSats).toHaveBeenCalledTimes(1)
    release(7)
    await Promise.all([first, second])
    expect(s.current()).toMatchObject({ arkade: { value: 7 } })
    const third = s.sample()
    expect(readArkadeAvailableSats).toHaveBeenCalledTimes(2)
    release(8)
    await third
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
    expect(cliSource).toMatch(/void services\.sampleBalances\(\)\.catch\(/)
    expect(cliSource).not.toMatch(/await services\.sampleBalances\(\)/)
  })
})
