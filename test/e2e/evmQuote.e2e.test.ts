/**
 * E2E — admitting an EVM send swap against the live stack.
 *
 * Everything else that tests `quote()` injects its dependencies: a fake price,
 * a fixture key set, an in-memory row. That proves the arithmetic and the
 * refusals, and it cannot prove the two things that only a running stack
 * settles:
 *
 * 1. THE COVENANT DERIVES. `quote` builds a `CovenantSwapScript` from the
 *    solver's real keys, the real Arkade server key and the real emulator key,
 *    then encodes an address from it. A field in the wrong place still produces
 *    a well-formed address in a unit test, because nothing checks it against a
 *    server. Here the keys are the ones arkd and the emulator actually
 *    published.
 * 2. THE PRICE IS REAL. The rate comes from the same `pricefeed` service the Go
 *    solver reads — the URL and pointer `solver-init` registers — rather than a
 *    mock. If that feed changes shape, this fails here rather than at the first
 *    live quote.
 *
 * PREREQUISITES: the arkade regtest stack (for the wallet and emulator) and its
 * `pricefeed` service on 8088. Skipped, not failed, when either is absent.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { EvmSendSwapService } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { EvmSendSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { openArkade, type E2eArkade } from './support/stack.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'

const FEED_URL = process.env.PRICEFEED_E2E_URL ?? 'http://localhost:8088/btc-asset'
/** The pointer `solver-init` registers with the Go solver for this feed. */
const PRICE_PATH = '/btc/asset'
/** A stand-in ERC20. Zero decimals so the feed's whole-unit rate reads directly. */
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

let arkade: E2eArkade
let service: EvmSendSwapService
let available = false

beforeAll(async () => {
  try {
    const feed = await fetch(FEED_URL, { signal: AbortSignal.timeout(2_000) })
    if (!feed.ok) return
    arkade = await openArkade()
  } catch {
    return
  }
  const ops = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  const store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'))
  service = new EvmSendSwapService({
    store,
    evm: {} as never,
    broadcast: (() => {
      throw new Error('a quote must not broadcast')
    }) as never,
    arkadeLockupFunded: async () => false,
    claimArkade: async () => {
      throw new Error('a quote must not claim')
    },
    lockFor: (() => {
      throw new Error('a quote must not build a lock')
    }) as never,
    blockHeight: async () => 20_000_000,
    arkade: ops,
    // Wide, so a shared regtest wallet's other rows never refuse this.
    solverEvmAddress: new Uint8Array(20).fill(0x42),
    maxExposedSats: 1_000_000_000,
    admission: new AdmissionControl(),
    totalCommitted: async () => 0,
    markets: new Map([
      [
        TOKEN,
        {
          token: { symbol: 'RGT', address: TOKEN, decimals: 0 },
          market: { token: { symbol: 'RGT', address: TOKEN, decimals: 0 }, priceFeed: FEED_URL, pricePath: PRICE_PATH },
          limits: { minSats: 1_000, maxSats: 10_000_000 },
          fee: { bps: 100, flatSats: 0 },
        },
      ],
    ]),
    fetchPrice: createPriceFeed(),
    chain: {
      contractAddress: '0x' + 'de'.repeat(20),
      chainId: 8453,
      minConfirmations: 12,
      minAgeSeconds: 780,
      cadence: { fastestSecondsPerBlock: 12, slowestSecondsPerBlock: 15 },
      quoteValiditySeconds: 60,
    },
  })
  available = true
}, 180_000)

const itOnStack: typeof it = ((name: string, fn: any, timeout?: number) =>
  it(
    name,
    async (ctx: any) => {
      if (!available) return ctx.skip()
      await fn(ctx)
    },
    timeout,
  )) as never

const request = (over: Record<string, unknown> = {}) => ({
  paymentHash: hex.encode(crypto.getRandomValues(new Uint8Array(32))),
  tokenAddress: TOKEN,
  amountSats: 100_000,
  evmClaimAddress: '0x' + '11'.repeat(20),
  refundAddress: '',
  clientRefundPubkey: '',
  payoutPubkey: '',
  ...over,
})

describe('admitting an EVM send swap on the live stack', () => {
  itOnStack(
    'derives a covenant address from the real server and emulator keys',
    async () => {
      // The solver's own address stands in for a client's here: what matters is
      // that it decodes on this network and that the script built from the real
      // key set encodes to a usable address.
      const mine = await arkade.ctx.wallet.getAddress()
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await service.quote(
        request({ refundAddress: mine, clientRefundPubkey: clientKey, payoutPubkey: clientKey }),
      )
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (outcome.accepted) {
        expect(outcome.swap.lockupAddress.startsWith(`${arkade.ctx.hrp}1`)).toBe(true)
        expect(outcome.swap.pkScript).toMatch(/^5120[0-9a-f]{64}$/)
        // The keys the row snapshotted are the ones the live services published,
        // not fixtures.
        expect(outcome.swap.serverPubkey).toBe(hex.encode(arkade.ctx.wallet.arkServerPublicKey))
        expect(outcome.swap.emulatorPubkey).toBe(arkade.emulator.pubkey)
      }
    },
    120_000,
  )

  itOnStack(
    'prices the payout from the feed the Go solver reads',
    async () => {
      // The regtest feed answers 100_000_000 asset per BTC, i.e. 1 unit per sat.
      // A 100_000 sat give less the 1% fee is 99_000 sats, so 99_000 units.
      const mine = await arkade.ctx.wallet.getAddress()
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await service.quote(
        request({ refundAddress: mine, clientRefundPubkey: clientKey, payoutPubkey: clientKey }),
      )
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (outcome.accepted) {
        expect(outcome.swap.payoutSats).toBe(99_000)
        expect(outcome.swap.evmAmount).toBe('99000')
      }
    },
    120_000,
  )

  itOnStack(
    'orders the two deadlines against the operator’s OWN exit delay',
    async () => {
      // The unit tests pin this against a fixture delay. Here it is whatever
      // arkd reports, which is the number that actually binds in production —
      // and on a server whose delay is below the minimum claim window the quote
      // would be refused rather than silently unsafe.
      const mine = await arkade.ctx.wallet.getAddress()
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await service.quote(
        request({ refundAddress: mine, clientRefundPubkey: clientKey, payoutPubkey: clientKey }),
      )
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (outcome.accepted) {
        expect(outcome.swap.evmTimeout).toBeLessThan(outcome.swap.refundLocktime)
        expect(outcome.swap.refundLocktime).toBeGreaterThan(Math.floor(Date.now() / 1000))
      }
    },
    120_000,
  )

  itOnStack(
    'refuses a refund address from the wrong network',
    async () => {
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const outcome = await service.quote(
        request({ refundAddress: 'bc1qnotarkade', clientRefundPubkey: clientKey, payoutPubkey: clientKey }),
      )
      expect(outcome).toEqual({ accepted: false, reason: 'invalid_refund_address' })
    },
    120_000,
  )
})
