/**
 * Admission for `ethereum:<token>->arkade:BTC`.
 *
 * The mirror of the send leg, and two things follow from the roles being
 * exchanged. The CLIENT carries `evmTimeout` here — it locks first — so this
 * VALIDATES a deadline rather than choosing one, and the ordering inverts:
 *
 *     send:     evmTimeout     + margin <= refundLocktime
 *     receive:  refundLocktime + margin <= evmTimeout
 *
 * And the price runs the other way, because the client gives tokens and
 * receives sats. That conversion is `convertQuoteToBase`, whose reciprocal must
 * stay implicit — inverting the price into a decimal first would round before
 * the conversion instead of after it.
 */

import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { EvmReceiveSwapService, type EvmReceiveServiceDeps } from '@arkade-os/solver-corridors-evm/receive/evmOrchestrator.js'
import { EvmReceiveSwapStore } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { EVM_ORDER_MARGIN_SECONDS } from '@arkade-os/solver-core/core/evmSend.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'

const NOW = 1_800_000_000
const key = (fill: number) => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
/** 169 x 512s — encodable under BIP68, unlike a plain 24h. */
const DELAY = 169 * 512
const ARKADE_ADDRESS =
  'tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndahdrkx4r7p4nqycjr0v75mfkpy5ewqe4wc5hx6fjen75g2h4epz2h89jv9p'

/** 1 second per block, so a height delta reads as that many seconds. */
const CADENCE = { fastestSecondsPerBlock: 1, slowestSecondsPerBlock: 4 }
const CURRENT_BLOCK = 20_000_000
/** Far enough ahead that a safe refundLocktime exists. */
const TIMEOUT_BLOCK = CURRENT_BLOCK + 3 * EVM_ORDER_MARGIN_SECONDS

const served = (over: Record<string, unknown> = {}) => ({
  token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
  market: { token: { symbol: 'USDC', address: TOKEN, decimals: 6 }, priceFeed: 'http://feed', pricePath: '/btc/usdc' },
  limits: { minSats: 1_000, maxSats: 10_000_000 },
  fee: { bps: 100, flatSats: 0 },
  ...over,
})

const build = async (over: Partial<EvmReceiveServiceDeps> = {}) => {
  const store = await EvmReceiveSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  const deps = {
    store,
    evm: {} as never,
    broadcast: vi.fn(),
    fundArkade: vi.fn(),
    refundArkade: vi.fn(),
    arkadeLockupFunded: vi.fn(),
    arkadePreimage: vi.fn(),
    lockFor: vi.fn(),
    blockHeight: vi.fn().mockResolvedValue(CURRENT_BLOCK),
    arkade: {
      solverPubkey: key(1),
      serverPubkey: key(2),
      emulatorPubkey: key(3),
      solverRefundPkScript: '5120' + key(4),
      hrp: 'tark',
      delays: {
        unilateralClaimDelay: DELAY,
        unilateralRefundDelay: DELAY,
        unilateralRefundWithoutReceiverDelay: DELAY,
      },
    },
    markets: new Map([[TOKEN, served()]]),
    // 50_000 quote-units per whole BTC.
    fetchPrice: vi.fn().mockResolvedValue({ mantissa: 50_000n, scale: 0 }),
    evmClaimAddress: '0x' + '99'.repeat(20),
    chain: {
      contractAddress: '0x' + 'de'.repeat(20),
      chainId: 8453,
      minConfirmations: 12,
      minAgeSeconds: 780,
      cadence: CADENCE,
      quoteValiditySeconds: 60,
    },
    maxExposedSats: 100_000_000,
    admission: new AdmissionControl(),
    totalCommitted: vi.fn().mockResolvedValue(0),
    now: () => NOW,
    ...over,
  } as unknown as EvmReceiveServiceDeps
  return { store, deps, service: new EvmReceiveSwapService(deps) }
}

const request = (over: Record<string, unknown> = {}) => ({
  paymentHash: 'aa'.repeat(32),
  tokenAddress: TOKEN,
  // 50_000_000 base units of a 6-decimal token at 50_000 per BTC = 1 BTC.
  evmAmount: '50000000',
  evmTimeout: TIMEOUT_BLOCK,
  evmRefundAddress: '0x' + '11'.repeat(20),
  payoutAddress: ARKADE_ADDRESS,
  payoutPubkey: key(7),
  ...over,
})

describe('the happy path', () => {
  it('admits a swap and prices the tokens back into sats', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      // 50_000_000 base units of a 6-decimal token is 50 whole tokens; at
      // 50_000 tokens per BTC that is 0.001 BTC, i.e. 100_000 sats.
      expect(outcome.swap.amountSats).toBe(100_000)
      // 1% fee comes off what the solver pays out.
      expect(outcome.swap.payoutSats).toBe(99_000)
      expect(outcome.swap.evmAmount).toBe('50000000')
    }
  })

  it('orders the deadlines the INVERSE of the send leg', async () => {
    // receive: refundLocktime + margin <= evmTimeout. Getting this backwards is
    // the solver paying for tokens the client can then refund.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      const evmTimeoutSeconds = NOW + (TIMEOUT_BLOCK - CURRENT_BLOCK) * CADENCE.fastestSecondsPerBlock
      expect(outcome.swap.refundLocktime + EVM_ORDER_MARGIN_SECONDS).toBeLessThanOrEqual(evmTimeoutSeconds)
    }
  })

  it('keeps the client’s own evmTimeout rather than substituting one', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) expect(outcome.swap.evmTimeout).toBe(TIMEOUT_BLOCK)
  })

  it('gives the covenant the exchanged roles', async () => {
    // The CLIENT claims here, so the client is the receiver; the SOLVER funded,
    // so it takes the covenant's `client` role and its own refund destination.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.payoutPubkey).toBe(key(7))
      expect(outcome.swap.clientRefundPubkey).toBe(key(1))
      expect(outcome.swap.refundPkScript).toBe('5120' + key(4))
      expect(outcome.swap.lockupAddress.startsWith('tark1')).toBe(true)
    }
  })

  it('binds the CLIENT into the script, not merely into the row', async () => {
    // The fields above are copied straight from the request, so they say
    // nothing about which key the covenant actually commits to — swapping the
    // script's `receiver` for the solver's key leaves every one of them
    // unchanged. Deriving the script twice with different payout keys and
    // requiring different pkScripts is what pins it.
    const a = await build()
    const b = await build()
    const one = await a.service.quote(request({ payoutPubkey: key(7) }))
    const two = await b.service.quote(request({ payoutPubkey: key(9) }))
    expect(one.accepted && two.accepted).toBe(true)
    if (one.accepted && two.accepted) expect(one.swap.pkScript).not.toBe(two.swap.pkScript)
  })

  it('rounds the sats payout DOWN when the conversion leaves a remainder', async () => {
    // The happy-path amount divides exactly, so it cannot tell the directions
    // apart. 50_000_001 base units is 50.000001 tokens, which at 50_000 per BTC
    // is 100_000.002 sats — floor 100_000, ceil 100_001. The solver PAYS this,
    // so the remainder must stay with the solver.
    const { service } = await build()
    const outcome = await service.quote(request({ evmAmount: '50000001' }))
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) expect(outcome.swap.amountSats).toBe(100_000)
  })

  it('claims the tokens to the solver’s own address', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.evmClaimAddress).toBe('0x' + '99'.repeat(20))
      expect(outcome.swap.evmRefundAddress).toBe('0x' + '11'.repeat(20))
    }
  })
})

describe('refusals', () => {
  it('refuses a token this deployment does not serve', async () => {
    const { service } = await build()
    expect(await service.quote(request({ tokenAddress: '0x' + 'ff'.repeat(20) }))).toEqual({
      accepted: false,
      reason: 'unsupported_token',
    })
  })

  it.each([
    ['a non-Arkade address', 'bc1qsomething'],
    ['gibberish', 'nope'],
    ['an empty string', ''],
  ])('refuses %s as the payout destination', async (_why, payoutAddress) => {
    const { service } = await build()
    expect(await service.quote(request({ payoutAddress }))).toEqual({
      accepted: false,
      reason: 'invalid_payout_address',
    })
  })

  it.each([
    ['a fraction', '1.5'],
    ['exponent form', '1e18'],
    ['a negative', '-1'],
    ['zero', '0'],
    ['a leading zero', '0100'],
    ['not a number', 'lots'],
  ])('refuses %s as the locked amount', async (_why, evmAmount) => {
    // The client's own figure. Unparsed, a non-decimal reaches BigInt and throws
    // OUT of the quote instead of being refused.
    const { service } = await build()
    expect(await service.quote(request({ evmAmount }))).toEqual({
      accepted: false,
      reason: 'invalid_evm_amount',
    })
  })

  it('refuses a sats value outside the corridor bounds', async () => {
    const { service } = await build()
    // 500 base units -> 0.0005 whole tokens -> 1 sat, under the 1_000 floor.
    expect(await service.quote(request({ evmAmount: '500' }))).toEqual({
      accepted: false,
      reason: 'amount_out_of_range',
    })
  })

  it('refuses when the fee eats the swap', async () => {
    const { service } = await build({
      markets: new Map([[TOKEN, served({ fee: { bps: 0, flatSats: 200_000 } })]]),
    } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
  })

  it('refuses a duplicate payment hash, here and in another corridor', async () => {
    const { service } = await build()
    expect((await service.quote(request())).accepted).toBe(true)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })

    const peer = { findLiveByPaymentHash: vi.fn().mockResolvedValue({ id: 'x' }) }
    const other = await build({ peerStores: [peer] } as never)
    expect(await other.service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('measures capacity against the PAYOUT, which is what the solver risks', async () => {
    // The headroom is chosen to sit BETWEEN the two figures: 99_500 fits the
    // 99_000 payout and not the 100_000 the client locked. A cap read against
    // the client's lock would refuse a swap the solver can comfortably fund,
    // and the two are only 1% apart, so a looser fixture cannot tell them apart.
    const headroom = 99_500
    const { service } = await build({
      admission: new AdmissionControl(),
      totalCommitted: vi.fn().mockResolvedValue(100_000_000 - headroom),
    } as never)
    expect((await service.quote(request())).accepted).toBe(true)
  })

  it('still refuses once the payout itself exceeds the headroom', async () => {
    const { service } = await build({ totalCommitted: vi.fn().mockResolvedValue(100_000_000 - 98_000) } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'provider_at_capacity' })
  })

  it('refuses rather than guessing when the price feed is down', async () => {
    const { service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('down')) } as never)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'price_unavailable' })
  })

  it('refuses a client deadline too close to be ordered against', async () => {
    // The client proposed a timeout that leaves no room for the solver's own
    // recourse. Named rather than collapsed, so an operator can see which rule.
    const { service } = await build()
    const outcome = await service.quote(request({ evmTimeout: CURRENT_BLOCK + 10 }))
    expect(outcome.accepted).toBe(false)
    if (!outcome.accepted) expect(outcome.reason).not.toBe('price_unavailable')
  })

  it('refuses a deadline already behind the chain', async () => {
    const { service } = await build()
    const outcome = await service.quote(request({ evmTimeout: CURRENT_BLOCK - 1_000 }))
    expect(outcome.accepted).toBe(false)
  })

  it('writes NOTHING when it refuses', async () => {
    const { store, service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('down')) } as never)
    expect((await service.quote(request())).accepted).toBe(false)
    expect(await store.findLiveByPaymentHash('aa'.repeat(32))).toBeFalsy()
  })
})

/**
 * THE #105 RACE on the receive leg, where the sats at stake are the SOLVER's
 * own — it funds this side out of its own capital, so the cap is what bounds
 * how much of it can be committed at once.
 *
 * Run concurrently on purpose: a read-then-check passes this test's sequential
 * cousin and fails only when two quotes overlap, which is the whole defect.
 */
describe('the exposure cap under concurrency', () => {
  it('admits only one of two quotes that do not both fit', async () => {
    const { service } = await build({
      maxExposedSats: 150_000,
      totalCommitted: vi.fn().mockResolvedValue(0),
    } as never)

    const [a, b] = await Promise.all([
      service.quote(request({ paymentHash: 'a1'.repeat(32) })),
      service.quote(request({ paymentHash: 'b2'.repeat(32) })),
    ])

    expect([a, b].filter((o) => o.accepted)).toHaveLength(1)
    const refused = [a, b].find((o) => !o.accepted)
    expect((refused as { reason: string }).reason).toBe('provider_at_capacity')
  })

  it('hands the headroom back once the row is durable', async () => {
    // A leaked claim would refuse the third while the database reads empty.
    const { service } = await build({
      maxExposedSats: 250_000,
      totalCommitted: vi.fn().mockResolvedValue(0),
    } as never)
    const results = []
    for (const hash of ['c3', 'd4', 'e5']) {
      results.push(await service.quote(request({ paymentHash: hash.repeat(32) })))
    }
    expect(results.map((r) => r.accepted)).toEqual([true, true, true])
  })
})

describe('quote admission control', () => {
  it('meters quote creation per requester key', async () => {
    const { service } = await build()
    const ask = (i: number, requesterKey?: string) =>
      service.quote({
        ...request(),
        paymentHash: i.toString(16).padStart(2, '0').repeat(32),
        ...(requesterKey === undefined ? {} : { requesterKey }),
      })

    for (let i = 0; i < 5; i++) expect((await ask(i, 'one-client')).accepted).toBe(true)
    expect(await ask(5, 'one-client')).toEqual({ accepted: false, reason: 'rate_limited' })
    expect((await ask(6, 'another-client')).accepted).toBe(true)
    expect((await ask(7)).accepted).toBe(true)
  })

  it('enforces the token-unit inventory bound at quote time', async () => {
    // The fixture locks 50_000_000 base units; bound it below and above.
    const narrow = await build({
      markets: new Map([[TOKEN, served({ tokenLimits: { minUnits: 100n, maxUnits: 1_000n } })]]),
    } as never)
    expect(await narrow.service.quote(request())).toEqual({ accepted: false, reason: 'amount_out_of_range' })

    const wide = await build({
      markets: new Map([[TOKEN, served({ tokenLimits: { minUnits: 100n, maxUnits: 100_000_000n } })]]),
    } as never)
    expect((await wide.service.quote(request())).accepted).toBe(true)
  })

  it('refuses a client deadline past the serving horizon, by name', async () => {
    // CADENCE.fastest is 1s, so a height 24h+2s out converts to a seconds
    // deadline past EVM_MAX_CLIENT_TIMEOUT_SECONDS.
    const { service } = await build()
    const outcome = await service.quote(request({ evmTimeout: CURRENT_BLOCK + 24 * 3600 + 2 }))
    expect(outcome).toEqual({ accepted: false, reason: 'evm_timeout_too_far_out' })
  })
})
