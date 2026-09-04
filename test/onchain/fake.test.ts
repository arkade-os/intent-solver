import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { Address, OutScript, Transaction } from '@scure/btc-signer'
import { FakeOnchainBackend } from '@arkade-os/solver-rails-fake/onchain/fake/backend.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'

/** A real, parseable transaction: the fake reads the txid out of the bytes. */
const rawTx = (nonce: number): { hex: string; txid: string } => {
  const tx = new Transaction({ allowUnknownInputs: true, allowUnknownOutputs: true })
  tx.addInput({ txid: new Uint8Array(32).fill(nonce), index: 0, sequence: 0xfffffffd })
  tx.addOutput({ script: Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(3)]), amount: 1000n })
  return { hex: hex.encode(tx.toBytes(true, true)), txid: tx.id }
}

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

  it.each([0, -1, 1.5, Number.NaN])('mineBlocks(%s) throws without confirming anything', async (n) => {
    const backend = new FakeOnchainBackend()
    const tx = rawTx(4)
    await backend.broadcastRaw(tx.hex)
    expect(() => backend.mineBlocks(n)).toThrow(/whole number of blocks/)
    expect(await backend.transactionOutcome(tx.txid)).toBe('mempool')
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

  it('broadcastRaw() answers with the transaction’s OWN txid, not a fresh one', async () => {
    const backend = new FakeOnchainBackend()
    const [a, b] = [rawTx(1), rawTx(2)]
    expect((await backend.broadcastRaw(a.hex)).txid).toBe(a.txid)
    expect((await backend.broadcastRaw(b.hex)).txid).toBe(b.txid)
  })

  it('transactionOutcome() tells a broadcast we never made from one waiting on a block', async () => {
    const backend = new FakeOnchainBackend()
    const tx = rawTx(3)
    expect(await backend.transactionOutcome(tx.txid)).toBe('unknown')
    await backend.broadcastRaw(tx.hex)
    expect(await backend.transactionOutcome(tx.txid)).toBe('mempool')
    backend.mineBlocks(1)
    expect(await backend.transactionOutcome(tx.txid)).toBe('confirmed')
  })

  it('dropFromMempool() takes an unconfirmed broadcast back to unknown', async () => {
    const backend = new FakeOnchainBackend()
    const tx = rawTx(4)
    await backend.broadcastRaw(tx.hex)
    backend.dropFromMempool(tx.txid)
    expect(await backend.transactionOutcome(tx.txid)).toBe('unknown')
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
