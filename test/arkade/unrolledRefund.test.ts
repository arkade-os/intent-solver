import { describe, it, expect, beforeEach } from 'vitest'
import { base64, hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { DefaultVtxo, getArkPsbtFields, SingleKey, Transaction, VtxoTaprootTree } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import {
  UnrolledRefunder,
  type UnrolledLockup,
  type UnrolledRefundDeps,
  type UnrolledRefundRecord,
} from '@arkade-os/solver-arkade/arkade/unrolledRefund.js'

const solver = SingleKey.fromPrivateKey(new Uint8Array(32).fill(11))
const server = SingleKey.fromPrivateKey(new Uint8Array(32).fill(3))
const keyOf = (fill: number) => SingleKey.fromPrivateKey(new Uint8Array(32).fill(fill)).xOnlyPublicKey()
const p2tr = (program: Uint8Array) => Uint8Array.from([0x51, 0x20, ...program])

const REFUND_LOCKTIME = 1_800_000_000
const VALUE = 100_000
const EXIT_DELAY = 4096
const NOW = REFUND_LOCKTIME + 7200

let script: CovenantSwapScript
let boarding: DefaultVtxo.Script
let parent: Transaction
let lockup: UnrolledLockup

type Status = { confirmed: false } | { confirmed: true; blockTime: number; blockHeight: number }

const chain = {
  tip: { height: 900_000, time: REFUND_LOCKTIME + 1, hash: '00' },
  feeRate: 10 as number | undefined,
  raw: new Map<string, Uint8Array>(),
  status: new Map<string, Status>(),
  outspends: new Map<string, { spent: boolean; txid?: string }[]>(),
  broadcasts: [] as string[],
  calls: 0,
}

const fakeChain: UnrolledRefundDeps['chain'] = {
  getChainTip: async () => (chain.calls++, chain.tip),
  getFeeRate: async () => (chain.calls++, chain.feeRate),
  getRawTransaction: async (txid) => {
    chain.calls++
    const raw = chain.raw.get(txid)
    if (!raw) throw new Error('Not Found')
    return raw
  },
  getTxStatus: async (txid) => {
    chain.calls++
    const status = chain.status.get(txid)
    if (!status) throw new Error('Not Found')
    return status
  },
  getTxOutspends: async (txid) => (chain.calls++, chain.outspends.get(txid) ?? []),
  broadcastTransaction: async (...txs) => (chain.broadcasts.push(...txs), 'ok'),
}

/** arkd's checks on what it is asked to co-sign, then its signature and the broadcast. */
const cosigned: Transaction[] = []
let cosignFails: Error | null = null
let explorerLags = false
const cosign = async (psbt: string): Promise<string> => {
  if (cosignFails) throw cosignFails
  const tx = Transaction.fromPSBT(base64.decode(psbt))
  const input = tx.getInput(0)
  expect(input.tapLeafScript).toHaveLength(1)
  expect(getArkPsbtFields(tx, 0, VtxoTaprootTree)).toHaveLength(1)
  expect(input.tapScriptSig?.map(([k]) => hex.encode(k.pubKey))).toEqual([hex.encode(await solver.xOnlyPublicKey())])
  const signed = await server.sign(tx, [0])
  signed.finalize()
  cosigned.push(signed)
  if (!explorerLags) {
    chain.status.set(signed.id, { confirmed: false })
    chain.raw.set(signed.id, signed.extract())
  }
  return signed.id
}

let now = NOW
const refunder = () => new UnrolledRefunder({ chain: fakeChain, signer: solver, cosign, boarding, now: () => now })

beforeEach(async () => {
  now = NOW
  cosigned.length = 0
  cosignFails = null
  explorerLags = false
  chain.tip = { height: 900_000, time: REFUND_LOCKTIME + 1, hash: '00' }
  chain.feeRate = 10
  chain.raw.clear()
  chain.status.clear()
  chain.outspends.clear()
  chain.broadcasts.length = 0
  chain.calls = 0

  const solverKey = await solver.xOnlyPublicKey()
  const serverKey = await server.xOnlyPublicKey()
  script = new CovenantSwapScript({
    receiver: await keyOf(1),
    server: serverKey,
    preimageHash: ripemd160(sha256(new Uint8Array(32).fill(7))),
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: EXIT_DELAY,
    client: solverKey,
    clientRefundDelay: EXIT_DELAY * 2,
    refundWithoutServerDelay: EXIT_DELAY,
    nonInteractiveParameters: {
      emulatorPubkey: await keyOf(9),
      receiverPkScript: p2tr(await keyOf(13)),
      senderPkScript: p2tr(solverKey),
    },
  })
  boarding = new DefaultVtxo.Script({
    pubKey: solverKey,
    serverPubKey: serverKey,
    csvTimelock: { value: 144n, type: 'blocks' },
  })
  parent = new Transaction({ version: 3 })
  parent.addInput({ txid: 'aa'.repeat(32), index: 0 })
  parent.addOutput({ script: script.pkScript, amount: BigInt(VALUE) })
  parent.addOutput({ script: Uint8Array.from([0x51, 0x02, 0x4e, 0x73]), amount: 0n })
  parent.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] }, true)
  chain.raw.set(parent.id, parent.toBytes(true, true))
  chain.status.set(parent.id, { confirmed: false })
  lockup = { script, txid: parent.id, vout: 0, refundLocktime: REFUND_LOCKTIME, exitDelaySeconds: EXIT_DELAY }
})

const pushed = async (): Promise<UnrolledRefundRecord> => {
  const step = await refunder().advance(lockup, null)
  if (step.kind !== 'pending') throw new Error(`expected a push, got ${step.kind}`)
  return step.record
}

describe('UnrolledRefunder', () => {
  it('waits until median-time-past passes the refund locktime', async () => {
    chain.tip = { ...chain.tip, time: REFUND_LOCKTIME }
    expect(await refunder().advance(lockup, null)).toEqual({ kind: 'waiting' })
    expect(cosigned).toHaveLength(0)
  })

  it('builds the refund arkd co-signs and pays the unconfirmed unroll with it', async () => {
    const record = await pushed()
    const [refund] = cosigned
    expect(record).toEqual({
      txid: refund!.id,
      tx: hex.encode(refund!.extract()),
      feeRate: 10,
      broadcastAt: NOW,
      cpfpTxid: null,
    })
    expect(refund!.version).toBe(3)
    expect(refund!.lockTime).toBe(REFUND_LOCKTIME)
    expect(refund!.getInput(0)).toMatchObject({ txid: hex.decode(parent.id), index: 0, sequence: 0xfffffffe })
    expect(hex.encode(refund!.getOutput(0).script!)).toBe(hex.encode(boarding.pkScript))
    const fee = VALUE - Number(refund!.getOutput(0).amount)
    expect(fee).toBe(Math.ceil(10 * (refund!.vsize + parent.vsize)))
  })

  it('prices only itself once the unroll has confirmed', async () => {
    chain.status.set(parent.id, { confirmed: true, blockTime: NOW - 600, blockHeight: 899_999 })
    await pushed()
    const [refund] = cosigned
    expect(VALUE - Number(refund!.getOutput(0).amount)).toBe(Math.ceil(10 * refund!.vsize))
  })

  it('reports a lockup something else already spent instead of pushing', async () => {
    chain.outspends.set(parent.id, [{ spent: true, txid: 'bb'.repeat(32) }])
    expect(await refunder().advance(lockup, null)).toEqual({ kind: 'spent' })
    expect(cosigned).toHaveLength(0)
  })

  it('reports the window closed once the client CSV is near, and rethrows before that', async () => {
    cosignFails = new Error('input 0 has an available exit closure')
    chain.status.set(parent.id, { confirmed: true, blockTime: NOW - EXIT_DELAY + 300, blockHeight: 1 })
    expect(await refunder().advance(lockup, null)).toEqual({ kind: 'closed', reason: cosignFails.message })
    chain.status.set(parent.id, { confirmed: true, blockTime: NOW - EXIT_DELAY + 301, blockHeight: 1 })
    await expect(refunder().advance(lockup, null)).rejects.toThrow('available exit closure')
  })

  it('asks the chain about a lockup at most once a minute', async () => {
    const r = refunder()
    chain.tip = { ...chain.tip, time: REFUND_LOCKTIME }
    await r.advance(lockup, null)
    const calls = chain.calls
    now += 59
    expect(await r.advance(lockup, null)).toEqual({ kind: 'waiting' })
    expect(chain.calls).toBe(calls)
  })

  it('records the push even when the explorer has not seen the refund yet', async () => {
    explorerLags = true
    expect(await pushed()).toMatchObject({ txid: cosigned[0]!.id, tx: null })
  })

  it('reads the final tx later, rebroadcasts it if dropped, and reports confirmation', async () => {
    const record = { ...(await pushed()), tx: null }
    const tracked = await refunder().advance(lockup, record)
    expect(tracked).toEqual({ kind: 'pending', record: { ...record, tx: hex.encode(cosigned[0]!.extract()) } })

    const withTx = (tracked as { record: UnrolledRefundRecord }).record
    chain.status.delete(record.txid)
    expect(await refunder().advance(lockup, withTx)).toEqual({ kind: 'pending', record: withTx })
    expect(chain.broadcasts).toEqual([withTx.tx])

    chain.status.set(record.txid, { confirmed: true, blockTime: NOW, blockHeight: 900_001 })
    expect(await refunder().advance(lockup, withTx)).toEqual({ kind: 'confirmed', record: withTx })
  })

  it('treats a spend by another tx as spent, but not an explorer that omits the spender', async () => {
    const record = await pushed()
    chain.status.delete(record.txid)
    chain.outspends.set(parent.id, [{ spent: true }])
    expect((await refunder().advance(lockup, record)).kind).toBe('pending')
    chain.outspends.set(parent.id, [{ spent: true, txid: 'cc'.repeat(32) }])
    expect(await refunder().advance(lockup, record)).toEqual({ kind: 'spent' })
  })

  describe('the CPFP bump', () => {
    const slowRefund = async (): Promise<UnrolledRefundRecord> => {
      chain.status.set(parent.id, { confirmed: true, blockTime: NOW - 600, blockHeight: 899_999 })
      const record = { ...(await pushed()), tx: null }
      now += 20 * 60
      chain.feeRate = 40
      return record
    }

    it('spends the refund output once, through the boarding forfeit leaf, at the package rate', async () => {
      const record = await slowRefund()
      const step = await refunder().advance(lockup, record)
      const [refund, child] = cosigned
      expect(step).toMatchObject({ kind: 'pending', record: { cpfpTxid: child!.id, feeRate: 60, broadcastAt: now } })
      expect(child!.getInput(0)).toMatchObject({ txid: hex.decode(refund!.id), index: 0 })
      const refundOut = Number(refund!.getOutput(0).amount)
      const packageFee = VALUE - refundOut + (refundOut - Number(child!.getOutput(0).amount))
      expect(packageFee).toBeGreaterThanOrEqual(60 * (refund!.vsize + child!.vsize))

      now += 20 * 60
      await refunder().advance(lockup, (step as { record: UnrolledRefundRecord }).record)
      expect(cosigned).toHaveLength(2)
    })

    it('leaves a refund alone while the unroll is unconfirmed or the refund already pays the rate', async () => {
      const record = await slowRefund()
      chain.status.set(parent.id, { confirmed: false })
      expect((await refunder().advance(lockup, record)).kind).toBe('pending')
      chain.status.set(parent.id, { confirmed: true, blockTime: NOW - 600, blockHeight: 899_999 })
      chain.feeRate = 10
      now += 60
      expect((await refunder().advance(lockup, record)).kind).toBe('pending')
      expect(cosigned).toHaveLength(1)
    })
  })
})
