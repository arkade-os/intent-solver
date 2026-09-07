/**
 * Admission for `arkade:<asset>->ethereum:<token>`.
 *
 * The corridor with no BTC leg on either side. Two things follow, and both are
 * what this file is for: the pair is served only because an OPERATOR declared
 * it — nothing composes an asset/BTC rate with a BTC/token one — and the size
 * bounds are the only bounds there are, because `MAX_EXPOSED_SATS` has no sats
 * here to count.
 */

import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  AssetEvmSendSwapService,
  type AssetEvmSendServiceDeps,
} from '@arkade-os/solver-corridors-evm/send/assetEvmOrchestrator.js'
import { AssetEvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/assetEvmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

const NOW = 1_800_000_000
const key = (fill: number) => hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(fill)))
const ASSET = '11'.repeat(32) + '0000'
const OTHER_ASSET = '22'.repeat(32) + '0000'
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
/** 169 x 512s — just over 24h, and BIP68-encodable, so the covenant accepts it. */
const DELAY = 169 * 512

const ARKADE_ADDRESS =
  'tark1qr340xg400jtxat9hdd0ungyu6s05zjtdf85uj9smyzxshf98ndahdrkx4r7p4nqycjr0v75mfkpy5ewqe4wc5hx6fjen75g2h4epz2h89jv9p'

const corridorOf = (assetId: string) => `arkade:${assetId}->ethereum:${TOKEN}`

const market = (over: Record<string, unknown> = {}) => ({
  corridor: corridorOf(ASSET),
  asset: { ticker: 'USDA', assetId: ASSET, decimals: 8 },
  token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
  assetLimits: { minUnits: 1_000n, maxUnits: 10_000_000n },
  priceFeed: 'http://feed',
  pricePath: '/usda/usdc',
  fee: { bps: 100, flatSats: 0 },
  enabled: true,
  ...over,
})

const build = async (over: Record<string, unknown> = {}) => {
  const store = await AssetEvmSendSwapStore.open(betterSqliteDriver(':memory:'), () => NOW)
  const deps = {
    store,
    evm: {} as never,
    broadcast: vi.fn(),
    arkadeLockupFunded: vi.fn(),
    claimArkade: vi.fn(),
    lockFor: vi.fn(),
    blockHeight: vi.fn().mockResolvedValue(20_000_000),
    solverEvmAddress: new Uint8Array(20).fill(0x42),
    arkade: {
      providerPubkey: key(1),
      serverPubkey: key(2),
      emulatorPubkey: key(3),
      receiverPkScript: '5120' + key(4),
      hrp: 'tark',
      delays: {
        unilateralClaimDelay: DELAY,
        unilateralRefundDelay: DELAY,
        unilateralRefundWithoutReceiverDelay: DELAY,
      },
    },
    markets: new Map([[corridorOf(ASSET), market()]]),
    // One token per WHOLE asset unit — a rate the arithmetic below is checkable by eye at.
    fetchPrice: vi.fn().mockResolvedValue({ mantissa: 1n, scale: 0 }),
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
  } as unknown as AssetEvmSendServiceDeps
  return { store, deps, service: new AssetEvmSendSwapService(deps) }
}

const request = (over: Record<string, unknown> = {}) => ({
  paymentHash: 'aa'.repeat(32),
  assetId: ASSET,
  tokenAddress: TOKEN,
  assetUnits: 1_000_000n,
  evmClaimAddress: '0x' + '11'.repeat(20),
  refundAddress: ARKADE_ADDRESS,
  clientRefundPubkey: key(7),
  ...over,
})

describe('the happy path', () => {
  it('charges the spread in the asset`s own units, rounded against the client', async () => {
    // The remainder stays with the solver; rounding the fee down means eating it
    // on every swap, and at a small give that remainder is most of the fee.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.assetUnits).toBe('1000000')
      expect(outcome.swap.payoutUnits).toBe('990000')
    }
  })

  it('prices the payout in the token, from the NET units and BOTH precisions', async () => {
    // 990_000 units at 8 decimals is 0.0099 whole; at 1 token per whole unit,
    // into a 6-decimal token: 990_000 * 10^6 / 10^8 = 9_900.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) expect(outcome.swap.evmAmount).toBe('9900')
  })

  it('rounds the payout DOWN, so a sub-unit remainder stays with the solver', async () => {
    const { service } = await build({ fetchPrice: vi.fn().mockResolvedValue({ mantissa: 10_001n, scale: 4 }) })
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    // 990_000 * 10_001 * 10^6 / (10^4 * 10^8) = 9_900.99 -> floor
    if (outcome.accepted) expect(BigInt(outcome.swap.evmAmount)).toBe(9_900n)
  })

  it('snapshots the market and chain facts rather than leaving them to be re-read', async () => {
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.assetId).toBe(ASSET)
      expect(outcome.swap.assetDecimals).toBe(8)
      expect(outcome.swap.tokenAddress).toBe(TOKEN)
      expect(outcome.swap.evmChainId).toBe(8453)
      expect(outcome.swap.minConfirmations).toBe(12)
      expect(outcome.swap.minAgeSeconds).toBe(780)
      expect(outcome.swap.validUntil).toBe(NOW + 60)
      expect(outcome.swap.evmTimeout).toBe(20_000_000 + Math.floor(DELAY / 15))
      expect(outcome.swap.pkScript).toMatch(/^5120[0-9a-f]{64}$/)
      expect(outcome.swap.lockupAddress.startsWith('tark1')).toBe(true)
    }
  })

  it('is the SOLVER`s address the ERC20 refund is keyed to, never the client`s', async () => {
    // `encodeRefund` takes the refunder from `msg.sender`, so a row holding the
    // client's would lock under a key the solver cannot address — and would let
    // the client take the tokens back the moment the timeout matured.
    const { service } = await build()
    const outcome = await service.quote(request())
    expect(outcome.accepted).toBe(true)
    if (outcome.accepted) {
      expect(outcome.swap.evmRefundAddress).toBe('42'.repeat(20))
      expect(outcome.swap.evmClaimAddress).toBe('0x' + '11'.repeat(20))
    }
  })

  it('binds the asset id into the covenant, so two assets are two lockups', async () => {
    // TWO INSTANCES ON ONE PAYMENT HASH, so the asset id is the only input that
    // differs. Varying the hash as well would move the pkScript whether or not
    // the id ever reached the script — and an id that never reaches it builds
    // the BTC covenant, whose address the funded row cannot reconstruct.
    const only = (assetId: string, ticker: string) =>
      build({
        markets: new Map([
          [corridorOf(assetId), market({ corridor: corridorOf(assetId), asset: { ticker, assetId, decimals: 8 } })],
        ]),
      })
    const a = await (await only(ASSET, 'USDA')).service.quote(request())
    const b = await (await only(OTHER_ASSET, 'USDB')).service.quote(request({ assetId: OTHER_ASSET }))
    expect([a.accepted, b.accepted]).toEqual([true, true])
    if (a.accepted && b.accepted) {
      expect(a.swap.paymentHash).toBe(b.swap.paymentHash)
      expect(a.swap.pkScript).not.toBe(b.swap.pkScript)
    }
  })
})

describe('the operator declares the pair, or it is not served', () => {
  it('refuses a pair nobody declared, rather than composing a rate for it', async () => {
    const { service, deps } = await build()
    expect(await service.quote(request({ assetId: OTHER_ASSET }))).toEqual({
      accepted: false,
      reason: 'unsupported_pair',
    })
    expect(deps.fetchPrice, 'a pair nobody declared still cost a feed round trip').not.toHaveBeenCalled()
  })

  it('refuses a declared pair the operator switched off', async () => {
    const { service } = await build({ markets: new Map([[corridorOf(ASSET), market({ enabled: false })]]) })
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'unsupported_pair' })
  })

  it('matches the token case-insensitively, since a 0x address is not case-bearing', async () => {
    const { service } = await build()
    const outcome = await service.quote(request({ tokenAddress: TOKEN.toUpperCase().replace('0X', '0x') }))
    expect(outcome.accepted).toBe(true)
  })
})

describe('refusals', () => {
  it.each([
    ['a non-Arkade address', 'bc1qsomethingelse'],
    ['gibberish', 'not-an-address'],
    ['an empty string', ''],
  ])('refuses %s as the refund destination', async (_why, refundAddress) => {
    const { service } = await build()
    expect(await service.quote(request({ refundAddress }))).toEqual({
      accepted: false,
      reason: 'invalid_refund_address',
    })
  })

  it.each([
    ['below the floor', 999n],
    ['above the ceiling', 10_000_001n],
  ])('refuses a give %s of the per-swap bounds', async (_why, assetUnits) => {
    const { service } = await build()
    expect(await service.quote(request({ assetUnits }))).toEqual({ accepted: false, reason: 'amount_out_of_range' })
  })

  it('refuses when the spread eats the give, by its own name', async () => {
    // Not folded into `amount_out_of_range`: the give WAS inside the range, it
    // simply cannot be priced, and the two want different things from an operator.
    const { service } = await build({
      markets: new Map([[corridorOf(ASSET), market({ fee: { bps: 10_000, flatSats: 0 } })]]),
    })
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'fee_consumes_swap' })
  })

  it('refuses a payment hash already live in this corridor, without paying for a price first', async () => {
    const { service, deps } = await build()
    expect((await service.quote(request())).accepted).toBe(true)
    expect(deps.fetchPrice).toHaveBeenCalledTimes(1)
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
    expect(deps.fetchPrice).toHaveBeenCalledTimes(1)
  })

  it('refuses a payment hash live in ANOTHER corridor', async () => {
    // Two corridors settling one preimage is the client taking both sides.
    const peer = { findLiveByPaymentHash: vi.fn().mockResolvedValue({ id: 'other' }) }
    const { service } = await build({ peerStores: [peer] })
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'duplicate_swap' })
  })

  it('refuses rather than guessing when the price feed is down', async () => {
    // No last-known-good on purpose: a stale rate is how a solver is arbitraged.
    const { service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('feed down')) })
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'price_unavailable' })
  })

  it('refuses a payout that rounds away to nothing', async () => {
    const { service } = await build({ fetchPrice: vi.fn().mockResolvedValue({ mantissa: 1n, scale: 20 }) })
    expect(await service.quote(request())).toEqual({ accepted: false, reason: 'payout_below_dust' })
  })

  it('enforces the token-unit bound the asset bound cannot express', async () => {
    // The give is inside `assetLimits` either way; what changes is how much of
    // the token float the fill drains once the rate has run away.
    const narrow = await build({
      markets: new Map([[corridorOf(ASSET), market({ tokenLimits: { minUnits: 1n, maxUnits: 1_000n } })]]),
    })
    expect(await narrow.service.quote(request())).toEqual({ accepted: false, reason: 'amount_out_of_range' })

    const wide = await build({
      markets: new Map([[corridorOf(ASSET), market({ tokenLimits: { minUnits: 1n, maxUnits: 1_000_000n } })]]),
    })
    expect((await wide.service.quote(request())).accepted).toBe(true)
  })

  it('meters quote creation per requester key, and never meters operator-local callers', async () => {
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

  it('writes NOTHING when it refuses', async () => {
    // A refusal that left a row behind would make the next identical request a
    // duplicate, so one bad quote would poison the hash for good.
    const { store, service } = await build({ fetchPrice: vi.fn().mockRejectedValue(new Error('down')) })
    expect((await service.quote(request())).accepted).toBe(false)
    expect(await store.findLiveByPaymentHash('aa'.repeat(32))).toBeNull()
  })
})

/**
 * THE ONLY HOUSE-LEVEL BOUND THIS CORRIDOR HAS, since `committedSats()` answers
 * zero and `AdmissionControl` serialises a `number` a bigint will not fit. Read
 * and compared, with no claim taken; the last test is what that costs.
 */
describe('the aggregate ceiling, in the asset`s own units', () => {
  const bounded = (assetId: string, ticker: string) =>
    market({
      corridor: corridorOf(assetId),
      asset: { ticker, assetId, decimals: 8 },
      assetLimits: { minUnits: 1_000n, maxUnits: 1_000_000n },
      maxExposedUnits: 1_500_000n,
    })

  const capped = () =>
    build({
      markets: new Map([
        [corridorOf(ASSET), bounded(ASSET, 'USDA')],
        [corridorOf(OTHER_ASSET), bounded(OTHER_ASSET, 'USDB')],
      ]),
    })

  it('refuses the quote that would put the pair over the ceiling', async () => {
    const { service } = await capped()
    expect((await service.quote(request())).accepted).toBe(true)
    expect(await service.quote(request({ paymentHash: 'bb'.repeat(32) }))).toEqual({
      accepted: false,
      reason: 'provider_at_capacity',
    })
  })

  it('counts only the pair`s own asset, so one market never bounds another', async () => {
    const { service } = await capped()
    const other = await service.quote(request({ assetId: OTHER_ASSET, paymentHash: 'cc'.repeat(32) }))
    expect(other.accepted).toBe(true)
    expect((await service.quote(request())).accepted).toBe(true)
  })

  it('does not read the aggregate at all when the operator set none', async () => {
    // The read is skipped rather than compared against infinity: unset means the
    // per-swap bounds are the only ceiling, and saying so costs a query.
    const { store, service } = await build()
    const committed = vi.spyOn(store, 'committedAssetUnits')
    expect((await service.quote(request())).accepted).toBe(true)
    expect(committed).not.toHaveBeenCalled()
  })

  it('admits BOTH of two concurrent quotes the ceiling fits only one of', async () => {
    // THE STATED RESIDUAL RACE, pinned rather than assumed: neither row is
    // durable when the other reads the total. The overshoot is N x the per-swap
    // ceiling for N quotes in flight, not the ceiling itself.
    const { store, service } = await capped()
    const [first, second] = await Promise.all([
      service.quote(request({ paymentHash: 'a1'.repeat(32) })),
      service.quote(request({ paymentHash: 'b2'.repeat(32) })),
    ])
    expect([first.accepted, second.accepted]).toEqual([true, true])
    expect((await store.committedAssetUnits()).get(ASSET)).toBe(2_000_000n)
  })
})
