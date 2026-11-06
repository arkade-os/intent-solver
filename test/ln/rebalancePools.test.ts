import { describe, expect, it, vi } from 'vitest'
import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import { createLndRebalanceBackend } from '@arkade-os/solver-rails-lnd/rebalance.js'

const fixture = async () => {
  const invoice = forgeInvoice({
    network: 'bcrt',
    amountSats: 1000,
    paymentHash: new Uint8Array(32).fill(7),
    timestamp: Math.floor(Date.now() / 1000),
    expirySeconds: 3600,
  })
  const ln = {
    getBalance: vi.fn().mockResolvedValue({ availableSats: 5000, incomingSats: 200 }),
    createInvoice: vi.fn().mockResolvedValue({ invoice, expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
    getOwnInvoiceState: vi.fn().mockResolvedValue({ status: 'pending', expiresAt: null, amountSats: 1000 }),
    getHoldState: vi.fn(),
  }
  const onchain = {
    getBalance: vi.fn().mockResolvedValue({ confirmedSats: 4000, unconfirmedSats: 300 }),
    newReceiveAddress: vi.fn().mockResolvedValue('destination'),
    findOutputs: vi.fn().mockResolvedValue([]),
  }
  const pools = await createLndRebalanceBackend(
    ln as unknown as LightningBackend,
    onchain as unknown as OnchainSendBackend,
  ).pools()
  return { ln, onchain, pools }
}

describe('LND rebalance pools', () => {
  it('keeps channel and confirmed onchain liquidity separate and reads fresh balances', async () => {
    const { pools, ln, onchain } = await fixture()
    expect(pools.map((pool) => pool.id)).toEqual(['rail:onchain', 'rail:lightning'])
    expect(await pools[0]!.readBalance()).toBe(4000)
    expect(await pools[1]!.readBalance()).toBe(5000)
    expect(ln.getBalance).toHaveBeenCalledTimes(1)
    expect(onchain.getBalance).toHaveBeenCalledTimes(1)
  })

  it('requires the funded transaction, exact value and a confirmation for onchain credit', async () => {
    const { pools, onchain } = await fixture()
    const pool = pools[0]!
    const deposit = await pool.prepare('onchain', 1000, 0)
    onchain.findOutputs.mockResolvedValue([
      { txid: 'other', vout: 0, valueSats: 1000, confirmations: 2 },
      { txid: 'funding', vout: 1, valueSats: 999, confirmations: 2 },
    ])
    expect(await pool.receipt(deposit, 'funding')).toEqual({ state: 'pending' })
    onchain.findOutputs.mockResolvedValue([{ txid: 'funding', vout: 0, valueSats: 1000, confirmations: 0 }])
    expect(await pool.receipt(deposit, 'funding')).toEqual({ state: 'pending' })
    onchain.findOutputs.mockResolvedValue([{ txid: 'funding', vout: 0, valueSats: 1000, confirmations: 1 }])
    expect(await pool.receipt(deposit)).toEqual({ state: 'pending' })
    expect(await pool.receipt(deposit, 'funding')).toEqual({ state: 'credited', netSats: 1000, feeSats: 0 })
  })

  it('mints a plain exact invoice and credits only its settled destination record', async () => {
    const { pools, ln } = await fixture()
    const pool = pools[1]!
    const deposit = await pool.prepare('lightning', 1000, 0)
    expect(deposit).toMatchObject({ amountSats: 1000, netSats: 1000, feeSats: 0, paymentHash: '07'.repeat(32) })
    expect(ln.createInvoice).toHaveBeenCalledWith({ amountSats: 1000 })
    expect(await pool.receipt(deposit)).toEqual({ state: 'pending' })
    ln.getOwnInvoiceState.mockResolvedValue({ status: 'settled', expiresAt: null, amountSats: 999 })
    expect(await pool.receipt(deposit)).toMatchObject({ state: 'failed' })
    ln.getOwnInvoiceState.mockResolvedValue({ status: 'settled', expiresAt: null, amountSats: 1000 })
    expect(await pool.receipt(deposit)).toEqual({ state: 'credited', netSats: 1000, feeSats: 0 })
    expect(ln.getOwnInvoiceState).toHaveBeenCalledWith(deposit.paymentHash)
    expect(ln.getBalance).not.toHaveBeenCalled()
  })

  it('refuses invalid amounts, wrong routes, and altered receipt invoice identity', async () => {
    const { pools } = await fixture()
    await expect(pools[0]!.prepare('lightning', 1000, 0)).rejects.toThrow('unsupported')
    await expect(pools[1]!.prepare('lightning', 0, 0)).rejects.toThrow('positive')
    const deposit = await pools[1]!.prepare('lightning', 1000, 0)
    expect(await pools[1]!.receipt({ ...deposit, paymentHash: '08'.repeat(32) })).toMatchObject({ state: 'failed' })
  })
})
