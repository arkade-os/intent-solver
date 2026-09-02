/**
 * Admission for `arkade:BTC->ethereum:<token>`.
 *
 * Two things here are unlike every other corridor's quote. The deadlines are
 * derived the opposite way round (@see core/evmSend.ts), and the payout is in a
 * DIFFERENT ASSET — so a price is fetched rather than a fee merely subtracted,
 * and the rounding direction is a money decision rather than a detail.
 *
 * Everything the row keeps is snapshotted at quote time. A later step that
 * re-read configuration would derive a different swap key or a different script
 * the moment an operator changed anything, and neither failure is visible until
 * the money is already locked.
 */

import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { EvmSendSwapService, type EvmSendServiceDeps } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const NOW = 1_800_000_000
const key = (fill: number) => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
/** 169 x 512s — just over 24h, and encodable. */
const DELAY = 169 * 512

/** A real Arkade address, so the refund destination decodes rather than being faked. */
const ARKADE_ADDRESS =
  'tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndahdrkx4r7p4nqycjr0v75mfkpy5ewqe4wc5hx6fjen75g2h4epz2h89jv9p'

const market = (over: Record<string, unknown> = {}) => ({
  token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
  market: { token: { symbol: 'USDC', address: TOKEN, decimals: 6 }, priceFeed: 'http://feed', pricePath: '/btc/usdc' },
  limits: { minSats: 1_000, maxSats: 1_000_000 },
  fee: { bps: 100, flatSats: 0 },
  ...over,
})

const build = async (over: Partial<EvmSendServiceDeps> = {}) => {
  const store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  const deps = {
    store,
    evm: {} as never,
    broadcast: vi.fn(),
    arkadeLockupFunded: vi.fn(),
    claimArkade: vi.fn(),
    lockFor: vi.fn(),
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    arkade: {
      providerPubkey: key(1),
      serverPubkey: key(2),
      emulatorPubkey: key(3),
      receiverPkScript: '5120' + key(4),
      hrp: 'tark',
      // BIP68-encodable: 512-second units, so a plain 24h (86400) is refused by
      // the covenant — 169 units, 86528s, is the next value up and is what
      // `deriveUnilateralDelays` would actually produce.
      delays: {
        unilateralClaimDelay: DELAY,
        unilateralRefundDelay: DELAY,
        unilateralRefundWithoutReceiverDelay: DELAY,
      },
    },
    solverEvmAddress: new Uint8Array(20).fill(0x42),
    maxExposedSats: 100_000_000,
    admission: new AdmissionControl(),
    totalCommitted: vi.fn().mockResolvedValue(0),
    markets: new Map([[TOKEN, market()]]),
    // 50,000 quote-units per whole BTC — a round number so the arithmetic below
    // is checkable by eye.
    fetchPrice: vi.fn().mockResolvedValue({ mantissa: 50_000n, scale: 0 }),
    chain: {
      contractAddress: '0x' + 'de'.repeat(20),
      chainId: 8453,
      minConfirmations: 12,
      minAgeSeconds: 780,
      cadence: { fastestSecondsPerBlock: 12, slowestSecondsPerBlock: 15 },
      quoteValiditySeconds: 60,
    },
    now: () => NOW,
    ...over,
  } as unknown as EvmSendServiceDeps
  return { store, deps, service: new EvmSendSwapService(deps) }
}

const request = (over: Record<string, unknown> = {}) => ({
  paymentHash: 'aa'.repeat(32),
  tokenAddress: TOKEN,
  amountSats: 100_000,
  evmClaimAddress: '0x' + '11'.repeat(20),
  refundAddress: ARKADE_ADDRESS,
  clientRefundPubkey: key(7),
  payoutPubkey: key(8),
  ...over,
})

describe('the happy path', () => {
  it('admits a swap and writes a row', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.amountSats).toBe(100_000)
      // 1% fee: the client gives 100_000, the payout is priced off 99_000.
      expect(outcome.swap.payoutSats).toBe(99_000)
    }
  })

  it('prices the payout in the token, from the NET amount', async () => {
    // 99_000 sats at 50_000 quote-units per BTC, into a 6-decimal token:
    // 99_000 * 50_000 * 10^6 / 10^8 = 49_500_000 base units.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) expect(outcome.swap.evmAmount).toBe('49500000')
  })

  it('rounds the payout DOWN, so a sub-unit remainder stays with the solver', async () => {
    // A price that does not divide evenly. Rounding up would give away a base
    // unit on every swap, in the same direction, forever.
    const { service } = await build({
      fetchPrice: vi.fn().mockResolvedValue({ mantissa: 500001n, scale: 1 }),
    } as never)
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      // 99_000 * 500001 * 10^6 / (10^1 * 10^8) = 49_500_099.0 -> floor
      expect(BigInt(outcome.swap.evmAmount)).toBe(49_500_099n)
    }
  })

  it('snapshots the chain facts rather than leaving them to be re-read', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.evmChainId).toBe(8453)
      expect(outcome.swap.minConfirmations).toBe(12)
      expect(outcome.swap.minAgeSeconds).toBe(780)
      expect(outcome.swap.tokenAddress).toBe(TOKEN)
      // The quote window: one validity interval from the quote, NOT the refund
      // locktime hours out (rfq-protocol.md §5).
      expect(outcome.swap.validUntil).toBe(NOW + 60)
    }
  })

  it('derives a lockup address and a pkScript that agree', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.pkScript).toMatch(/^5120[0-9a-f]{64}$/)
      expect(outcome.swap.lockupAddress.startsWith('tark1')).toBe(true)
    }
  })

  it('stores the EVM timeout as a block height, floored on the slowest cadence', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      // The seconds horizon is max(unilateralClaimDelay, 30 min) = DELAY here;
      // blocksForDuration floors it on the SLOWEST cadence and adds the tip the
      // mocked backend reports (20_000_000).
      expect(outcome.swap.evmTimeout).toBe(20_000_000 + Math.floor(DELAY / 15))
      // A height in the future, or the refund is already live the moment the
      // lock lands. The seconds ordering this derives from is unit-tested
      // against evaluateEvmSendAcceptance in test/core/evmSend.test.ts.
      expect(outcome.swap.evmTimeout).toBeGreaterThan(20_000_000)
    }
  })
})

describe('refusals', () => {
  it('refuses a token this deployment does not serve', async () => {
    // Never falls through to a default: a quote priced off somebody else's feed
    // is worse than no quote.
    const { service } = await build()
    const outcome = await service.quote(request({ tokenAddress: '0x' + 'ff'.repeat(20) }))
    expect(outcome).toEqual({ accepted: false, reason: 'unsupported_token' })
  })

  it('matches the token case-insensitively, since a 0x address is not case-bearing', async () => {
    const { service } = await build()
    const outcome = await service.quote(request({ tokenAddress: TOKEN.toUpperCase().replace('0X', '0x') }))
    expect(outcome.accepted).toBe(true)
  })

  it.each([
    ['a non-Arkade address', 'bc1qsomethingelse'],
    ['gibberish', 'not-an-address'],
    ['an empty string', ''],
  ])('refuses %s as the refund destination', async (_why, refundAddress) => {
    const { service } = await build()
    const outcome = await service.quote(request({ refundAddress }))
    expect(outcome).toEqual({ accepted: false, reason: 'invalid_refund_address' })
  })

  it('refuses an amount outside the corridor bounds', async () => {
    const { service } = await build()
    expect(await service.quote(request({ amountSats: 999 }))).toEqual({
      accepted: false,
      reason: 'amount_out_of_range',
    })
    expect(await service.quote(request({ amountSats: 1_000_001 }))).toEqual({
      accepted: false,
      reason: 'amount_out_of_range',
    })
  })

  it('refuses when the fee eats the swap, by its own name', async () => {
    // Not folded into `amount_out_of_range`: the amount WAS inside the range, it
    // simply cannot be priced. The two want different things from an operator.
    const { service } = await build({
      markets: new Map([[TOKEN, market({ fee: { bps: 0, flatSats: 200_000 } })]]),
    } as never)
    const outcome = await service.quote(request())
    expect(outcome).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
  })

  it('refuses a payment hash already live in this corridor', async () => {
    const { service } = await build()
    expect((await service.quote(request())).accepted).toBe(true)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses the duplicate WITHOUT paying for a price first', async () => {
    // The row's UNIQUE constraint would catch a duplicate anyway, through the
    // insert's error path — so the explicit check is not what makes the ANSWER
    // right, and a mutation removing it survives on the outcome alone. What it
    // buys is the cost: a duplicate must not spend a network round trip on a
    // feed before being told no. That is the property worth pinning.
    const fetchPrice = vi.fn().mockResolvedValue({ mantissa: 50_000n, scale: 0 })
    const { service } = await build({ fetchPrice } as never)
    expect((await service.quote(request())).accepted).toBe(true)
    expect(fetchPrice).toHaveBeenCalledTimes(1)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
    expect(fetchPrice).toHaveBeenCalledTimes(1)
  })

  it('refuses a payment hash live in ANOTHER corridor', async () => {
    // A hash spoken for anywhere is spoken for here: two corridors settling the
    // same preimage is the client taking both sides.
    const peer = { findLiveByPaymentHash: vi.fn().mockResolvedValue({ id: 'other' }) }
    const { service } = await build({ peerStores: [peer] } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses when the house is at capacity, counting EVERY corridor', async () => {
    const { service } = await build({ totalCommitted: vi.fn().mockResolvedValue(99_950_000) } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'provider_at_capacity' })
  })

  it('refuses rather than guessing when the price feed is down', async () => {
    // No last-known-good on purpose: a stale rate is how a solver is arbitraged.
    const { service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('feed down')) } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'price_unavailable' })
  })

  it('refuses a payout that rounds away to nothing', async () => {
    // A price so low the net amount buys less than one base unit. Locking tokens
    // for a payout of zero is not a swap.
    const { service } = await build({ fetchPrice: vi.fn().mockResolvedValue({ mantissa: 1n, scale: 20 }) } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'payout_below_dust' })
  })

  it('writes NOTHING when it refuses', async () => {
    // A refusal that left a row behind would make the next identical request a
    // duplicate, so one bad quote would poison the hash for good.
    const { store, service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('down')) } as never)
    expect((await service.quote(request())).accepted).toBe(false)
    expect(await store.findLiveByPaymentHash('aa'.repeat(32))).toBeFalsy()
  })
})

/**
 * THE REFUND ADDRESS IS THE SOLVER'S, and the row stored the client's.
 *
 * `encodeRefund`'s signature is five arguments — `refund(bytes32,uint256,
 * address,address,uint256)` — with no `refundAddress` among them: the contract
 * takes the refunder from `msg.sender`. So the key the solver's own refund
 * computes carries the SOLVER's address, while a row holding the client's would
 * have locked under a different key entirely.
 *
 * Two ways that loses the money, not one. The solver's refund reverts against a
 * key that names no lock; and the client, being the stored `refundAddress`,
 * can call `refund` itself the moment the timeout matures and take the tokens.
 * Every send swap that expired without a preimage was a total loss.
 */
describe('the EVM refund address', () => {
  it('is the solver`s own address, never the client`s', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.swap.evmRefundAddress).toBe('42'.repeat(20))
    expect(outcome.swap.evmRefundAddress).not.toBe(outcome.swap.evmClaimAddress)
  })

  it('still records the client as the claimant', async () => {
    // The mirror half: fixing the refund address must not disturb who claims.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) return
    expect(outcome.swap.evmClaimAddress).toBe('0x' + '11'.repeat(20))
  })
})

/**
 * THE #105 RACE, on this corridor.
 *
 * A swap is invisible to `totalCommitted()` until its row lands, so a plain
 * read-then-check lets two concurrent quotes both see the same headroom and
 * both take it. `AdmissionControl.reserve` does the comparison and the claim in
 * one serialised step, so the second caller sees the first one's claim.
 *
 * Asserted by RUNNING two quotes concurrently rather than by grepping
 * `createServices` for an `admission,` line — the wiring test can only see that
 * the control was passed, never that it is consulted before the insert.
 */
describe('the exposure cap under concurrency', () => {
  it('admits only one of two quotes that do not both fit', async () => {
    // Room for one 100_000-sat swap, not two. `totalCommitted` stays at 0
    // throughout, which is exactly the window the race lives in: neither row is
    // durable yet, so nothing but the reservation can tell the two apart.
    const { service } = await build({
      maxExposedSats: 150_000,
      totalCommitted: vi.fn().mockResolvedValue(0),
    } as never)

    const [a, b] = await Promise.all([
      service.quote(request({ paymentHash: 'a1'.repeat(32) })),
      service.quote(request({ paymentHash: 'b2'.repeat(32) })),
    ])

    const accepted = [a, b].filter((o) => o.accepted)
    const refused = [a, b].filter((o) => !o.accepted)
    expect(accepted).toHaveLength(1)
    expect(refused).toHaveLength(1)
    expect((refused[0] as { reason: string }).reason).toBe('provider_at_capacity')
  })

  it('admits both when the cap has room for both', async () => {
    // The mirror half: the reservation must not refuse a quote that fits.
    const { service } = await build({
      maxExposedSats: 100_000_000,
      totalCommitted: vi.fn().mockResolvedValue(0),
    } as never)

    const [a, b] = await Promise.all([
      service.quote(request({ paymentHash: 'c3'.repeat(32) })),
      service.quote(request({ paymentHash: 'd4'.repeat(32) })),
    ])
    expect([a.accepted, b.accepted]).toEqual([true, true])
  })

  it('hands the headroom back, so a settled quote does not shrink the cap forever', async () => {
    // The reservation is a claim on headroom until the ROW makes the swap
    // visible to `totalCommitted()`. Never releasing leaks it: `reserved` only
    // grows, and after enough quotes the corridor refuses everything while the
    // database says it is nearly empty.
    //
    // `totalCommitted` is pinned at 0 so the ONLY thing that could refuse the
    // third quote is a leaked claim from the first two.
    const { service } = await build({
      maxExposedSats: 250_000,
      totalCommitted: vi.fn().mockResolvedValue(0),
    } as never)

    const first = await service.quote(request({ paymentHash: 'e5'.repeat(32) }))
    const second = await service.quote(request({ paymentHash: 'f6'.repeat(32) }))
    const third = await service.quote(request({ paymentHash: '07'.repeat(32) }))
    expect([first.accepted, second.accepted, third.accepted]).toEqual([true, true, true])
  })
})

describe('quote admission control', () => {
  it('meters quote creation per requester key, and never meters operator-local callers', async () => {
    const { service } = await build()
    const ask = (i: number, requesterKey?: string) =>
      service.quote({
        ...request(),
        paymentHash: i.toString(16).padStart(2, '0').repeat(32),
        ...(requesterKey === undefined ? {} : { requesterKey }),
      })

    // QUOTE_RATE_LIMIT takes per window; the sixth quote on one key is refused.
    for (let i = 0; i < 5; i++) expect((await ask(i, 'one-client')).accepted).toBe(true)
    expect(await ask(5, 'one-client')).toEqual({ accepted: false, reason: 'rate_limited' })

    // Metering is per key: another identity is not spent by the first one's quota.
    expect((await ask(6, 'another-client')).accepted).toBe(true)
    // And an absent key — the operator-local path — is never metered.
    expect((await ask(7)).accepted).toBe(true)
  })

  it('enforces the token-unit inventory bound at quote time', async () => {
    // 100_000 sats at the fixture price pays 49_500_000 units. The sats bound
    // alone reads this as fine; the inventory bound is the knob that still
    // refuses when the quote is really a drain on the token float.
    const narrow = await build({
      markets: new Map([[TOKEN, { ...market(), tokenLimits: { minUnits: 1n, maxUnits: 100_000n } }]]),
    } as never)
    expect(await narrow.service.quote(request())).toEqual({ accepted: false, reason: 'amount_out_of_range' })

    const wide = await build({
      markets: new Map([[TOKEN, { ...market(), tokenLimits: { minUnits: 1n, maxUnits: 100_000_000n } }]]),
    } as never)
    expect((await wide.service.quote(request())).accepted).toBe(true)
  })
})
