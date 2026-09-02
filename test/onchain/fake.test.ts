import { describe, it, expect } from 'vitest'
import { Address, OutScript } from '@scure/btc-signer'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'

describe('FakeOnchainBackend', () => {
  it('fund() credits the address and findOutputs() reports it unconfirmed', async () => {
    const backend = new FakeOnchainBackend()
    const { txid } = await backend.fund({ address: 'bcrt1pexample', amountSats: 50_000, idempotencyKey: 'test-fund' })
    const outputs = await backend.findOutputs({ address: 'bcrt1pexample' })
    expect(outputs).toEqual([{ txid, vout: 0, valueSats: 50_000, confirmations: 0 }])
  })

  it('mineBlocks() advances confirmations for existing outputs', async () => {
    const backend = new FakeOnchainBackend()
    await backend.fund({ address: 'bcrt1pexample', amountSats: 50_000, idempotencyKey: 'test-fund' })
    backend.mineBlocks(3)
    const outputs = await backend.findOutputs({ address: 'bcrt1pexample' })
    expect(outputs[0]?.confirmations).toBe(3)
  })

  it('findSpendWitness() returns null until the output is spent', async () => {
    const backend = new FakeOnchainBackend()
    const { txid } = await backend.fund({ address: 'bcrt1pexample', amountSats: 50_000, idempotencyKey: 'test-fund' })
    expect(await backend.findSpendWitness({ txid, vout: 0, outputScript: new Uint8Array() })).toBeNull()
  })

  it('spendClaim() records a witness that findSpendWitness() then returns', async () => {
    const backend = new FakeOnchainBackend()
    const { txid } = await backend.fund({ address: 'bcrt1pexample', amountSats: 50_000, idempotencyKey: 'test-fund' })
    const witness = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
    backend.spendClaim(txid, 0, witness)
    expect(await backend.findSpendWitness({ txid, vout: 0, outputScript: new Uint8Array() })).toEqual(witness)
  })

  it('broadcastRaw() returns a fresh txid each call', async () => {
    const backend = new FakeOnchainBackend()
    const a = await backend.broadcastRaw('aabbcc')
    const b = await backend.broadcastRaw('ddeeff')
    expect(a.txid).not.toBe(b.txid)
  })

  it('estimateFeeRate() returns a fixed, sane sats/vbyte figure', async () => {
    const backend = new FakeOnchainBackend()
    await expect(backend.estimateFeeRate()).resolves.toBeGreaterThan(0)
  })

  it('newReceiveAddress() is deterministic, and decodes with the same Address() the CLI builds the pkScript with', async () => {
    const backend = new FakeOnchainBackend()
    const address = await backend.newReceiveAddress()

    expect(await backend.newReceiveAddress()).toBe(address)
    // 22 bytes = OP_0 <20-byte keyhash>: a real, spendable-looking P2WPKH,
    // not a placeholder string the CLI's decode would reject at startup.
    expect(OutScript.encode(Address(ONCHAIN_NETWORKS.regtest).decode(address))).toHaveLength(22)
  })

  it('newReceiveAddress() honours the network it was constructed with — a regtest address on mainnet would throw', async () => {
    const mainnet = await new FakeOnchainBackend(5, 0, ONCHAIN_NETWORKS.bitcoin).newReceiveAddress()

    expect(mainnet.startsWith('bc1')).toBe(true)
    expect(() => Address(ONCHAIN_NETWORKS.bitcoin).decode(mainnet)).not.toThrow()
  })

  it('fund() reports a configurable, non-zero vout — a fake that always says 0 could hide a real bug', async () => {
    const backend = new FakeOnchainBackend(5, 2)
    const { txid, vout } = await backend.fund({
      address: 'bcrt1pexample',
      amountSats: 50_000,
      idempotencyKey: 'test-fund',
    })
    expect(vout).toBe(2)
    const outputs = await backend.findOutputs({ address: 'bcrt1pexample' })
    expect(outputs).toEqual([{ txid, vout: 2, valueSats: 50_000, confirmations: 0 }])
  })
})
