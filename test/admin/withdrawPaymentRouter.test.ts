/**
 * Why `arkadeWithdraw` still hand-rolls the onchain exit rather than routing it
 * through the SDK's `PaymentRouter`, pinned as behaviour rather than prose. A
 * failure here is the SDK having moved, not a bug in this repo — it means the
 * adoption question is open again.
 */

import { describe, it, expect, vi } from 'vitest'
import { Address } from '@scure/btc-signer'
import { ArkAddress, Estimator, PaymentRouter, Ramps, arkRail, onchainRail } from '@arkade-os/sdk'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { arkadeFundSource } from '@arkade-os/solver-app/ops/arkadeFunds.js'

const REGTEST_ADDRESS = Address(ONCHAIN_NETWORKS.regtest).encode({
  type: 'wpkh',
  hash: new Uint8Array(20).fill(0x11),
})
const REGTEST_SCRIPT = '0014' + '11'.repeat(20)
const ARKADE_ADDRESS = new ArkAddress(new Uint8Array(32).fill(9), new Uint8Array(32).fill(8), 'tark').encode()
const TARK_ADDRESS = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'tark').encode()

const coin = (fill: number, value: number) => ({
  txid: fill.toString(16).padStart(2, '0').repeat(32),
  vout: 0,
  value,
  createdAt: new Date('2026-09-01T00:00:00Z'),
})

type Info = { dust: bigint; vtxoMaxAmount: bigint; fees: { intentFee: Record<string, string> } }

const wallet = (coins: unknown[], info: Info) => ({
  // `Ramps` reads the wallet's snapshot; `arkadeWithdraw` reads `getInfo()` live.
  dustAmount: info.dust,
  getBalance: vi.fn().mockResolvedValue({
    available: 10_000_000,
    boarding: { confirmed: 0, unconfirmed: 0, total: 0 },
    recoverable: 0,
    total: 10_000_000,
  }),
  getAddress: vi.fn().mockResolvedValue(ARKADE_ADDRESS),
  getSpendableVtxos: vi.fn().mockResolvedValue(coins),
  arkProvider: { getInfo: vi.fn().mockResolvedValue(info) },
  send: vi.fn().mockResolvedValue('ee'.repeat(32)),
  settle: vi.fn().mockResolvedValue('ff'.repeat(32)),
})

const withdrawWith = (w: unknown, params: { address: string; amount: string }) =>
  arkadeFundSource({
    config: { network: 'regtest' },
    arkade: { wallet: w, reservations: createReservationLedger() },
  } as never).withdraw!(params)

const outputsOf = (w: ReturnType<typeof wallet>) =>
  (w.settle.mock.calls[0]![0] as { outputs: { address: string; amount: bigint }[] }).outputs

const FLAT: Info = { dust: 330n, vtxoMaxAmount: -1n, fees: { intentFee: {} } }
const PROPORTIONAL: Info = {
  dust: 330n,
  vtxoMaxAmount: -1n,
  fees: { intentFee: { onchainOutput: 'amount * 0.01', offchainInput: '7.0', offchainOutput: '50.0' } },
}

describe('the onchain rail cannot replace this file’s fee model', () => {
  it('ships the change this file refuses, because offboard has no per-output ceiling', async () => {
    const info: Info = { ...FLAT, vtxoMaxAmount: 40_000n }
    const coins = [coin(0x01, 100_000)]

    await expect(withdrawWith(wallet(coins, info), { address: REGTEST_ADDRESS, amount: '50000' })).rejects.toThrow(
      /per-output ceiling/,
    )

    const viaSdk = wallet(coins, info)
    await new Ramps(viaSdk as never).offboard(REGTEST_ADDRESS, info.fees as never, 50_000n, undefined, coins as never)
    expect(outputsOf(viaSdk)[1]!.amount).toBe(50_000n)
    expect(outputsOf(viaSdk)[1]!.amount).toBeGreaterThan(info.vtxoMaxAmount)
  })

  it('short-pays the destination when handed this file’s `needed`, because offboard DEDUCTS its fee', async () => {
    const coins = [coin(0x01, 100_000)]
    const outputFee = BigInt(
      new Estimator(PROPORTIONAL.fees.intentFee).evalOnchainOutput({ amount: 50_000n, script: REGTEST_SCRIPT })
        .satoshis,
    )
    const needed = 50_000n + outputFee

    const viaSdk = wallet(coins, PROPORTIONAL)
    await new Ramps(viaSdk as never).offboard(
      REGTEST_ADDRESS,
      PROPORTIONAL.fees as never,
      needed,
      undefined,
      coins as never,
    )

    expect(outputFee).toBe(500n)
    expect(outputsOf(viaSdk)[0]!.amount).toBe(49_995n)

    const ours = wallet(coins, PROPORTIONAL)
    await withdrawWith(ours, { address: REGTEST_ADDRESS, amount: '50000' })
    expect(outputsOf(ours)[0]!.amount).toBe(50_000n)
  })

  it('disagrees on the change with the rail’s gross-up, which only a flat schedule hides', async () => {
    const coins = [coin(0x01, 100_000)]
    const changeVia = async (info: Info) => {
      const ours = wallet(coins, info)
      await withdrawWith(ours, { address: REGTEST_ADDRESS, amount: '50000' })
      const routed = wallet(coins, info)
      const router = new PaymentRouter({ wallet: routed as never, prefs: {} }).use(
        onchainRail({ feeInfo: async () => info.fees as never }),
      )
      const quote = await router.route({ raw: REGTEST_ADDRESS, amount: 50_000, selectedVtxos: coins as never })
      await (await quote.send()).settled()
      return [outputsOf(ours)[1]!.amount, outputsOf(routed)[1]!.amount]
    }

    const [oursFlat, routedFlat] = await changeVia({
      ...FLAT,
      fees: { intentFee: { onchainOutput: '100.0', offchainInput: '7.0', offchainOutput: '50.0' } },
    })
    expect(oursFlat).toBe(routedFlat)

    const [oursProp, routedProp] = await changeVia(PROPORTIONAL)
    expect(oursProp).toBe(49_443n)
    expect(routedProp).toBe(49_437n)
  })
})

describe('what a future adoption could still rely on', () => {
  it('honours a named selection without ever reading the wallet’s own coins', async () => {
    const named = [coin(0x01, 100_000)]
    const routed = wallet([...named, coin(0x02, 500_000)], FLAT)
    const router = new PaymentRouter({ wallet: routed as never, prefs: {} }).use(
      onchainRail({ feeInfo: async () => FLAT.fees as never }),
    )

    const quote = await router.route({ raw: REGTEST_ADDRESS, amount: 50_000, selectedVtxos: named as never })
    await (await quote.send()).settled()

    const inputs = (routed.settle.mock.calls[0]![0] as { inputs: { value: number }[] }).inputs
    expect(inputs.map((i) => i.value)).toEqual([100_000])
    expect(routed.getSpendableVtxos).not.toHaveBeenCalled()
  })

  it('refuses a shortfall rather than topping it up from an unnamed coin', async () => {
    const routed = wallet([coin(0x01, 10_000), coin(0x02, 500_000)], FLAT)
    const router = new PaymentRouter({ wallet: routed as never, prefs: {} }).use(
      onchainRail({ feeInfo: async () => FLAT.fees as never }),
    )

    const quote = await router.route({
      raw: REGTEST_ADDRESS,
      amount: 50_000,
      selectedVtxos: [coin(0x01, 10_000)] as never,
    })
    await expect((await quote.send()).settled()).rejects.toThrow(/greater than total amount/)
    expect(routed.settle).not.toHaveBeenCalled()
    expect(routed.getSpendableVtxos).not.toHaveBeenCalled()
  })

  it('makes the ark rail exactly the `wallet.send` this file already issues', async () => {
    const coins = [coin(0x01, 100_000)]

    const ours = wallet(coins, FLAT)
    await withdrawWith(ours, { address: TARK_ADDRESS, amount: '50000' })

    const routed = wallet(coins, FLAT)
    const quote = await new PaymentRouter({ wallet: routed as never, prefs: {} })
      .use(arkRail())
      .route({ raw: TARK_ADDRESS, amount: 50_000, selectedVtxos: coins as never })
    await (await quote.send()).settled()

    expect(routed.send.mock.calls[0]).toEqual(ours.send.mock.calls[0])
  })

  it('classifies an Arkade address for another network, which `withdrawRoute` refuses', async () => {
    const mainnet = new ArkAddress(new Uint8Array(32).fill(2), new Uint8Array(32).fill(3), 'ark').encode()
    const coins = [coin(0x01, 100_000)]

    await expect(withdrawWith(wallet(coins, FLAT), { address: mainnet, amount: '50000' })).rejects.toThrow(
      /another network/,
    )

    const routed = wallet(coins, FLAT)
    const quote = await new PaymentRouter({ wallet: routed as never, prefs: {} })
      .use(arkRail())
      .route({ raw: mainnet, amount: 50_000, selectedVtxos: coins as never })
    await (await quote.send()).settled()
    expect(routed.send).toHaveBeenCalledTimes(1)
  })
})
