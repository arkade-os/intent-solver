/**
 * The Taxi quote reader behind the receive-carrier port, with the Taxi's own
 * covenant verification stubbed: what is under test is what the reader checks
 * around it, and which coins it offers.
 */
import { describe, expect, it, vi } from 'vitest'
import { MultisigTapscript, VtxoScript } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { carrierCoins, createTaxiReceiveCarrierReader } from '@arkade-os/solver-app/ops/assetRfqTaxi.js'

vi.mock('@arkade-taxi/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arkade-taxi/client')>()),
  verifyReceiveQuote: vi.fn((args: { quote: Record<string, unknown> }) => ({
    quote: args.quote,
    script: { pkScript: hex.decode(MAKER_SCRIPT) },
    descriptor: {
      quoteId: args.quote.quoteId,
      senderKey: MAKER_KEY,
      assetId: ASSET,
      physicalSats: 330n,
      loanSats: 329n,
      receiptSats: 1n,
      serviceFareSats: 0n,
      expiresAt: 1_600,
    },
  })),
}))

const MAKER_SCRIPT = `5120${'cc'.repeat(32)}`
const MAKER_KEY = 'ab'.repeat(32)
const ASSET = `${'aa'.repeat(32)}0000`
const OPERATOR = 'dd'.repeat(32)
const solverKey = hex.decode('11'.repeat(32))
const serverKey = hex.decode('22'.repeat(32))
const tree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverKey, serverKey] }).script])

const coin = (seed: number, over: Record<string, unknown> = {}) => ({
  txid: seed.toString(16).padStart(64, '0'),
  vout: 0,
  value: 5_000,
  expiresAtHeight: 2_000,
  tapTree: tree.encode(),
  forfeitTapLeafScript: tree.leaves[0]!,
  ...over,
})

const reader = (coins: ReturnType<typeof coin>[], reserved: string[] = []) =>
  createTaxiReceiveCarrierReader({
    clientFor: () => ({
      info: async () => ({ operatorKey: OPERATOR, assetRules: [] }) as never,
      getReceiveQuote: async (quoteId: string) =>
        ({ quoteId, state: 'quoted', inputExpiryFloor: { kind: 'height', value: '1500' } }) as never,
      submitFill: vi.fn(),
    }),
    trust: {
      serverKey,
      emulatorKey: hex.decode('33'.repeat(32)),
      dustSats: 330n,
      vtxoMinAmount: 330n,
      hrp: 'tark',
      locktimeDomain: 'height',
      inputExpiryMargin: 10n,
    },
    maxServiceFareSats: 1_000n,
    coins: async () => coins,
    reserved: () => new Set(reserved),
    quoteValiditySeconds: 30,
    tipHeight: async () => 1_000,
  })

const request = (over: Record<string, unknown> = {}) => ({
  quoteId: 'q-1',
  makerPkScript: MAKER_SCRIPT,
  makerPublicKey: MAKER_KEY,
  assetId: ASSET,
  now: 1_000,
  admission: true,
  ...over,
})

describe('the coins a carrier fill is offered', () => {
  it("are the wallet's lock-aware spendable read, so a coin a registered intent holds is never offered", async () => {
    const held = coin(2)
    const wallet = {
      // The SDK drops an outpoint a registered intent holds; a raw contract read does not.
      getSpendableVtxos: vi.fn(async () => [coin(1)]),
      getContractManager: () => {
        throw new Error('the raw contract read returns intent-locked coins')
      },
    }
    const offered = await carrierCoins(wallet as never)
    expect(wallet.getSpendableVtxos).toHaveBeenCalledWith({ withRecoverable: false, genericallySpendableOnly: true })
    expect(offered.map(({ txid }) => txid)).toEqual([coin(1).txid])
    expect(offered.map(({ txid }) => txid)).not.toContain(held.txid)
    expect(offered[0]!.script).toBe(hex.encode(tree.pkScript))
  })
})

describe('the Taxi quote reader', () => {
  it("counts only unreserved coins that clear the quote's input expiry floor", async () => {
    const coins = [
      coin(1, { assets: [{ assetId: ASSET, amount: 7n }] }),
      coin(2),
      coin(3, { expiresAtHeight: 1_499 }),
      coin(4, { expiresAtHeight: undefined, expiresAt: new Date(2_000_000 * 1000) }),
    ]
    const inventory = await reader(coins, [`${coin(2).txid}:0`]).available(request())
    expect(inventory.get(ASSET)).toBe(7n)
    // One coin left once the reservation, the low expiry and the wrong locktime domain are out.
    expect(inventory.get(null)).toBe(5_000n - 330n)
  })

  it('answers the quote from the verified covenant, carrying its floor', async () => {
    expect(await reader([]).resolve(request())).toMatchObject({
      quoteId: 'q-1',
      makerPkScript: MAKER_SCRIPT,
      taxiKey: OPERATOR,
      loanSats: 329n,
      inputExpiryFloor: { kind: 'height', value: 1_500n },
    })
  })

  it.each([
    ['a Taxi key the request did not name', { taxi: { url: 'https://taxi.example', operatorKey: 'ee'.repeat(32) } }],
    ['a payout script that is not the verified covenant', { makerPkScript: `5120${'ef'.repeat(32)}` }],
    ['a maker key that is not x-only', { makerPublicKey: `02${MAKER_KEY}` }],
  ])('refuses %s', async (_why, over) => {
    await expect(reader([]).resolve(request(over))).rejects.toThrow()
  })
})
