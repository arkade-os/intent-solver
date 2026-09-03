/**
 * The two facts a live-priced corridor has to be able to state.
 *
 * ONE: a deployment that set none of the new knobs quotes exactly what it
 * quoted before. Not "the suite still passes" — asserted as an equality
 * against `fixedFeePricing`, through the REAL orchestrators, on both amount
 * sides, because the `amount_side: 'to'` path rounds up and an inverse-shaped
 * near-copy of it drifts by a sat.
 *
 * TWO: with a cap configured, a moving fee rate moves a quoted number. A knob
 * that parses, reads back correctly and changes no quote is the failure this
 * whole change exists to avoid, and it is invisible to every test that only
 * inspects config.
 *
 * Quotes go through `OnchainSendSwapService` and `OnchainReceiveSwapService`
 * themselves rather than through `PricingStrategy` in isolation: what an
 * operator sees is `payout_sats` on a row, and the strategy is only wired
 * correctly if that is the number that moves.
 */

import { describe, it, expect } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { fixedFeePricing } from '@arkade-os/solver-core/core/pricing.js'
import type { Fee } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { OnchainSendSwapService } from '@arkade-os/solver-corridors/send/onchainOrchestrator.js'
import { OnchainReceiveSwapService } from '@arkade-os/solver-corridors/receive/onchainOrchestrator.js'
import { OnchainSendSwapStore } from '@arkade-os/solver-corridors/db/onchainSwaps.js'
import { OnchainReceiveSwapStore } from '@arkade-os/solver-corridors/db/onchainReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { OnchainSigner } from '@arkade-os/solver-rails/onchain/refund.js'
import { onchainCorridorPricing, onchainFeeRateSampler } from '@arkade-os/solver-app/ops/onchainPricing.js'
import { createServicesBody } from '../support/createServicesBody.js'

const keyBytes = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))

const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(9)))
const solverPriv = new Uint8Array(32).fill(7)
const providerPubkey = hex.encode(schnorr.getPublicKey(solverPriv))
const clientRefundPubkey = hex.encode(keyBytes(10))
const clientPayoutPubkey = hex.encode(keyBytes(4))
const onchainPubkey = hex.encode(new Uint8Array(32).fill(3))
const p2trScript = (fill: number): Uint8Array => Uint8Array.from([0x51, 0x20, ...keyBytes(fill)])

/** Never used — no test here signs or broadcasts, only quotes. */
const signer: OnchainSigner = { sign: async (tx) => tx }

/** A real, decodable Arkade address; content is irrelevant beyond decoding to a P2TR pkScript. */
const ARKADE_ADDRESS = new CovenantSwapScript({
  receiver: keyBytes(4),
  server: keyBytes(5),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 512,
  client: keyBytes(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: {
    emulatorPubkey: keyBytes(6),
    receiverPkScript: p2trScript(13),
    senderPkScript: p2trScript(4),
  },
})
  .address('tark', keyBytes(5))
  .encode()

// A realistic unix timestamp: refundLocktime is a BIP65 absolute locktime and
// anything below LOCKTIME_THRESHOLD is rejected as a block height.
const clock = () => 1_800_000_000

const arkadeCommon = {
  providerPubkey,
  serverPubkey: hex.encode(keyBytes(5)),
  emulatorPubkey: hex.encode(keyBytes(6)),
  receiverPkScript: hex.encode(p2trScript(8)),
  delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 },
  hrp: 'tark',
  findLockups: async () => [],
  lockupProvablySpent: async () => false,
  claim: async () => 'claim-txid',
  refund: async () => 'refund-txid',
}

/** What a quote is asked to price, held constant so only the pricing varies. */
const GIVE_SATS = 50_000
const FEE: Fee = { bps: 25, flatSats: 300 }
/** Distinct from any real corridor's, so a number that came from the wrong side is visible. */
const VSIZE = 200

const sendQuote = async (
  pricing: ConstructorParameters<typeof OnchainSendSwapService>[0]['pricing'],
  amountSide: 'from' | 'to',
): Promise<number> => {
  const store = await OnchainSendSwapStore.open(betterSqliteDriver(':memory:'), clock)
  const service = new OnchainSendSwapService({
    store,
    onchain: new FakeOnchainBackend(5, 0),
    arkade: { ...arkadeCommon, findLockups: async () => [] },
    limits: { minSats: 1_000, maxSats: 1_000_000 },
    fee: FEE,
    pricing,
    maxExposedSats: 1_000_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    network: 'regtest',
    signer,
    refundDestinationScript: p2trScript(9),
    now: clock,
  })
  const outcome = await service.quote({
    paymentHash,
    amountSats: GIVE_SATS,
    amountSide,
    payoutPubkey: onchainPubkey,
    refundAddress: ARKADE_ADDRESS,
    clientRefundPubkey,
  })
  if (!outcome.accepted) throw new Error(`send quote refused: ${outcome.reason}`)
  return amountSide === 'to' ? outcome.swap.amountSats : outcome.swap.payoutSats
}

const receiveQuote = async (
  pricing: ConstructorParameters<typeof OnchainReceiveSwapService>[0]['pricing'],
  amountSide: 'from' | 'to',
): Promise<number> => {
  const store = await OnchainReceiveSwapStore.open(betterSqliteDriver(':memory:'), clock)
  const service = new OnchainReceiveSwapService({
    store,
    onchain: new FakeOnchainBackend(5, 0),
    arkade: {
      ...arkadeCommon,
      findLockupOutpoints: async () => [],
      findClaimPreimage: async () => null,
      fund: async () => 'arkade-fund-txid',
      refund: async () => 'arkade-refund-txid',
    },
    limits: { minSats: 1_000, maxSats: 1_000_000 },
    fee: FEE,
    pricing,
    maxExposedSats: 1_000_000,
    totalCommitted: () => store.committedSats(),
    admission: new AdmissionControl(),
    network: 'regtest',
    signer,
    claimDestinationScript: p2trScript(12),
    now: clock,
  })
  const outcome = await service.quote({
    paymentHash,
    amountSats: GIVE_SATS,
    amountSide,
    refundPubkey: onchainPubkey,
    payoutAddress: ARKADE_ADDRESS,
    payoutPubkey: clientPayoutPubkey,
    claimPacket: 'ZmFrZS1zZWFsZWQtcGFja2V0',
  })
  if (!outcome.accepted) throw new Error(`receive quote refused: ${outcome.reason}`)
  return amountSide === 'to' ? outcome.swap.amountSats : outcome.swap.payoutSats
}

/** Both corridors, under one name, so every property below is asserted on each. */
const CORRIDORS = [
  { name: 'arkade:BTC->onchain:BTC', quote: sendQuote },
  { name: 'onchain:BTC->arkade:BTC', quote: receiveQuote },
] as const

const SIDES = ['from', 'to'] as const

const NO_BOUNDS = {
  'arkade:BTC->lightning:BTC': null,
  'lightning:BTC->arkade:BTC': null,
  'arkade:BTC->onchain:BTC': null,
  'onchain:BTC->arkade:BTC': null,
} as const

describe('with nothing configured, quoted amounts are the ones the corridor always quoted', () => {
  it.each(CORRIDORS)('$name prices identically to fixedFeePricing when handed no strategy', async ({ quote }) => {
    for (const side of SIDES) {
      expect(await quote(undefined, side)).toBe(await quote(fixedFeePricing(FEE), side))
    }
  })

  it.each(CORRIDORS)('$name gets no strategy at all when its bounds are null', async ({ quote }) => {
    // The link only reachable through `createServices`: an absent
    // `<STEM>_FEE_CAP_SATS` becomes `undefined`, which is what makes the
    // orchestrator fall back rather than route the default through a second
    // implementation of the same arithmetic.
    const pricing = onchainCorridorPricing({
      bounds: null,
      base: FEE,
      feeRate: () => 3,
      vsize: VSIZE,
    })
    expect(pricing).toBeUndefined()
    for (const side of SIDES) expect(await quote(pricing, side)).toBe(await quote(undefined, side))
  })

  it('samples nothing when no corridor asked, so an unconfigured deployment makes no fee-rate calls', () => {
    let calls = 0
    const sampler = onchainFeeRateSampler({
      bounds: NO_BOUNDS,
      estimateFeeRate: async () => {
        calls++
        return 3
      },
      refreshAfterMs: 1_000,
      staleAfterMs: 10_000,
      now: () => 0,
    })
    expect(sampler).toBeNull()
    expect(calls).toBe(0)
  })
})

describe('with a cap configured, a moving fee rate moves the quote', () => {
  const priced = (feeRate: number, minSats = 0) =>
    onchainCorridorPricing({
      bounds: { capSats: 100_000, minSats },
      base: FEE,
      feeRate: () => feeRate,
      vsize: VSIZE,
    })

  it.each(CORRIDORS)('$name charges the rate it read, times the vbytes it broadcasts', async ({ quote }) => {
    // Pinned against the FIXED pricing of the flat that rate implies, on both
    // sides, rather than against a difference: the exact-out path solves the
    // give up through the spread, so a flat that rose by 3600 moves that
    // number by 3600/(1 - bps) and an assertion on the delta alone would be
    // asserting the arithmetic of the test rather than of the corridor.
    for (const side of SIDES) {
      for (const rate of [2, 20]) {
        expect(await quote(priced(rate), side)).toBe(
          await quote(fixedFeePricing({ bps: FEE.bps, flatSats: rate * VSIZE }), side),
        )
      }
      // And the two rates really do produce different numbers — a strategy
      // that ignored its `feeRate` would satisfy neither equality above, but
      // one that ignored `vsize` could satisfy both at a rate of 1.
      expect(await quote(priced(2), side)).not.toBe(await quote(priced(20), side))
    }
  })

  it.each(CORRIDORS)('$name replaces the configured flat rather than adding to it', async ({ quote }) => {
    // `Fee.flatSats` already means "the fixed cost this corridor pays", so a
    // live estimate on top would charge it twice. At a rate whose cost equals
    // the configured flat, the quote must be the fixed-priced one exactly.
    const atTheFlat = priced(FEE.flatSats / VSIZE)
    expect(await quote(atTheFlat, 'from')).toBe(await quote(fixedFeePricing(FEE), 'from'))
  })

  it.each(CORRIDORS)('$name never charges above the cap, whatever the source says', async ({ quote }) => {
    const capped = onchainCorridorPricing({
      bounds: { capSats: 500, minSats: 0 },
      base: FEE,
      // A source returning a spike, or the wrong units.
      feeRate: () => 100_000,
      vsize: VSIZE,
    })
    const atTheCap = await quote(fixedFeePricing({ bps: FEE.bps, flatSats: 500 }), 'from')
    expect(await quote(capped, 'from')).toBe(atTheCap)
  })

  it.each(CORRIDORS)('$name never charges below the floor on a quiet chain', async ({ quote }) => {
    // 1 sat/vB x 200 vbytes = 200, under a 900-sat floor. Float, refund risk
    // and attention do not fall to zero because fees did.
    const atTheFloor = await quote(fixedFeePricing({ bps: FEE.bps, flatSats: 900 }), 'from')
    expect(await quote(priced(1, 900), 'from')).toBe(atTheFloor)
  })

  it.each(CORRIDORS)('$name falls back to the configured flat when the rate is unknown', async ({ quote }) => {
    // What a stale sample reads as. Never zero — quoting no execution cost is
    // how the solver ends up paying it.
    const unknown = onchainCorridorPricing({
      bounds: { capSats: 100_000, minSats: 0 },
      base: FEE,
      feeRate: () => null,
      vsize: VSIZE,
    })
    for (const side of SIDES) expect(await quote(unknown, side)).toBe(await quote(fixedFeePricing(FEE), side))
  })
})

describe('the sampler behind it', () => {
  it('serves the last landed reading without blocking, and stops serving a stale one', async () => {
    let clockMs = 0
    let rate = 4
    const sampler = onchainFeeRateSampler({
      bounds: { ...NO_BOUNDS, 'onchain:BTC->arkade:BTC': { capSats: 1_000, minSats: 0 } },
      estimateFeeRate: async () => rate,
      refreshAfterMs: 1_000,
      staleAfterMs: 10_000,
      now: () => clockMs,
    })
    if (sampler === null) throw new Error('a configured corridor must get a sampler')
    /** Let the in-flight fetch and its `.then` chain settle. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
    // Null until the first fetch lands — the read is what starts it.
    expect(sampler()).toBeNull()
    await settle()
    expect(sampler()).toBe(4)
    // Past the refresh age the OLD value is still served while the new fetch
    // runs, which is what keeps a quote off the network.
    rate = 9
    clockMs = 2_000
    expect(sampler()).toBe(4)
    await settle()
    expect(sampler()).toBe(9)
    // Past the staleness age it stops being served at all, and pricing falls
    // back to the configured flat rather than quoting off an old number.
    clockMs = 2_000 + 10_001
    expect(sampler()).toBeNull()
  })
})

describe('createServices wires both onchain corridors and neither Lightning one', () => {
  const body = createServicesBody()

  /** The `pricing:` property as passed to each service, with the corridor it names. */
  const pricingLines = (): string[] => body.split('\n').filter((line) => line.includes('pricing: onchainPricingFor('))

  it('passes a pricing strategy to exactly the two onchain corridors', () => {
    expect(pricingLines()).toHaveLength(2)
    expect(body).toContain("onchainPricingFor(\n          'arkade:BTC->onchain:BTC',")
    expect(body).toContain("onchainPricingFor(\n          'onchain:BTC->arkade:BTC',")
  })

  it('sizes each direction off the transaction that direction broadcasts', () => {
    // The send leg funds and the taker claims; the receive leg claims what the
    // client funded. Swapping these bills each corridor for the other's
    // transaction — and would still typecheck, still pass every other test
    // here, and quietly misprice both directions.
    const send = body.indexOf("'arkade:BTC->onchain:BTC',\n          fundingTxVsize(")
    const receive = body.indexOf("'onchain:BTC->arkade:BTC',\n          claimSpendVsize(")
    expect({ send: send !== -1, receive: receive !== -1 }).toEqual({ send: true, receive: true })
  })

  it('keeps each direction on its own destination script', () => {
    // The two are hoisted out of their constructor calls so the fee sizing can
    // read them, which makes confusing one for the other a one-token typo that
    // still compiles and still runs — both are addresses from the same wallet.
    // They are deliberately separate so the two flows stay separable in that
    // wallet's history, and so each corridor is sized off the output it pays.
    expect(body).toContain('claimDestinationScript: onchainClaimDestinationScript!')
    expect(body).toContain('refundDestinationScript: onchainRefundDestinationScript!')
    expect(body).toContain('destinationScript: onchainClaimDestinationScript!')
    expect(body).toContain('changeScript: onchainRefundDestinationScript!')
  })

  it('leaves the Lightning corridors alone', () => {
    // Their backend cannot yet answer what a payment will cost, so a strategy
    // here would be one built on a number nothing supplies.
    const lightning = body.slice(body.indexOf('new SendSwapService('), body.indexOf('new OnchainSendSwapService('))
    expect(lightning).not.toContain('pricing:')
  })
})
