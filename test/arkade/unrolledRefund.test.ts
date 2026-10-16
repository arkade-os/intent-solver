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
const order: string[] = []
let cosignFails: Error | null = null
let replyLost = false
let explorerLags = false
const cosign = async (psbt: string): Promise<string> => {
  order.push('cosign')
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
  if (replyLost) throw new Error('arkd broadcast it, and the reply never arrived')
  return signed.id
}

const saved: UnrolledRefundRecord[] = []
const save = async (record: UnrolledRefundRecord) => {
  order.push('save')
  saved.push(record)
}

let now = NOW
const refunder = () =>
  new UnrolledRefunder({ chain: fakeChain, signer: solver, cosign, boarding, now: () => now, pause: async () => {} })

/** A transaction spending the lockup to `to`, as the explorer would serve it. */
const spendOfLockup = (to: Uint8Array): string => {
  const tx = new Transaction({ version: 3 })
  tx.addInput({ txid: parent.id, index: 0 })
  tx.addOutput({ script: to, amount: 1_000n })
  chain.raw.set(tx.id, tx.toBytes(true, true))
  return tx.id
}

beforeEach(async () => {
  now = NOW
  cosigned.length = 0
  order.length = 0
  saved.length = 0
  cosignFails = null
  replyLost = false
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
  const step = await refunder().advance(lockup, null, save)
  if (step.kind !== 'pending') throw new Error(`expected a push, got ${step.kind}`)
  return step.record
}

describe('UnrolledRefunder', () => {
  it('waits until median-time-past passes the refund locktime', async () => {
    chain.tip = { ...chain.tip, time: REFUND_LOCKTIME }
    expect(await refunder().advance(lockup, null, save)).toEqual({ kind: 'waiting' })
    expect(cosigned).toHaveLength(0)
  })

  it('builds the refund arkd co-signs, saved before arkd sees it, and pays the unconfirmed unroll', async () => {
    const record = await pushed()
    const [refund] = cosigned
    expect(record).toEqual({
      txid: refund!.id,
      tx: hex.encode(refund!.extract()),
      feeRate: 10,
      broadcastAt: NOW,
      cpfpTxid: null,
    })
    expect(order).toEqual(['save', 'cosign'])
    expect(saved[0]).toEqual({ ...record, tx: null })
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

  /** The client's anchor spend of the unroll, paying `fee` out of a coin of its own. */
  const anchorChildPaying = async (fee: number): Promise<Uint8Array> => {
    const coin = new Transaction({ version: 2 })
    coin.addInput({ txid: 'cc'.repeat(32), index: 0 })
    coin.addOutput({ script: p2tr(await keyOf(21)), amount: BigInt(fee + 50_000) })
    chain.raw.set(coin.id, coin.toBytes(true, true))
    const child = new Transaction({ version: 3 })
    child.addInput({ txid: parent.id, index: 1 })
    child.addInput({ txid: coin.id, index: 0 })
    child.addOutput({ script: p2tr(await keyOf(21)), amount: 50_000n })
    const raw = child.toBytes(true, true)
    chain.raw.set(child.id, raw)
    chain.outspends.set(parent.id, [{ spent: false }, { spent: true, txid: child.id }])
    return raw
  }

  it('outbids the client anchor child while the unroll is unconfirmed', async () => {
    const childRaw = await anchorChildPaying(20_000)

    await pushed()
    const [refund] = cosigned
    const fee = VALUE - Number(refund!.getOutput(0).amount)
    expect(fee).toBeGreaterThanOrEqual(20_000 + refund!.vsize)
    expect(fee / refund!.vsize).toBeGreaterThan(20_000 / childRaw.length)
  })

  it('prices for the parent alone when the anchor child cannot be read', async () => {
    const child = new Transaction({ version: 3 })
    child.addInput({ txid: parent.id, index: 7 })
    child.addOutput({ script: p2tr(await keyOf(21)), amount: 0n })
    chain.raw.set(child.id, child.toBytes(true, true))
    chain.outspends.set(parent.id, [{ spent: false }, { spent: true, txid: child.id }])

    await pushed()
    const [refund] = cosigned
    expect(VALUE - Number(refund!.getOutput(0).amount)).toBe(Math.ceil(10 * (refund!.vsize + parent.vsize)))
  })

  it('asks arkd nothing when the anchor child outbids all the lockup holds', async () => {
    await anchorChildPaying(VALUE)

    await expect(refunder().advance(lockup, null, save)).rejects.toThrow('outbids all')
    expect(order).toEqual([])
  })

  it('reports a lockup too small to pay for its own refund as closed, asking arkd nothing', async () => {
    const small = new Transaction({ version: 3 })
    small.addInput({ txid: 'dd'.repeat(32), index: 0 })
    small.addOutput({ script: script.pkScript, amount: 400n })
    small.updateInput(0, { finalScriptWitness: [new Uint8Array(64)] }, true)
    chain.raw.set(small.id, small.toBytes(true, true))
    chain.status.set(small.id, { confirmed: true, blockTime: NOW - 600, blockHeight: 899_999 })

    const step = await refunder().advance({ ...lockup, txid: small.id }, null, save)
    expect(step).toMatchObject({ kind: 'closed', reason: expect.stringContaining('cannot pay for its own') })
    expect(order).toEqual([])
  })

  it('reports a lockup someone else spent instead of pushing', async () => {
    chain.outspends.set(parent.id, [{ spent: true, txid: spendOfLockup(p2tr(await keyOf(13))) }])
    expect(await refunder().advance(lockup, null, save)).toEqual({ kind: 'spent' })
    expect(cosigned).toHaveLength(0)
  })

  it('adopts a spend paying the boarding script as its own refund', async () => {
    const record = await pushed()
    chain.outspends.set(parent.id, [{ spent: true, txid: record.txid }])
    now += 60
    expect(await refunder().advance(lockup, null, save)).toEqual({
      kind: 'pending',
      record: { ...record, feeRate: 0, broadcastAt: now },
    })
    expect(cosigned).toHaveLength(1)
  })

  it('does not adopt a claim that adds a dust output to the boarding script beside its own', async () => {
    const claim = new Transaction({ version: 3 })
    claim.addInput({ txid: parent.id, index: 0 })
    claim.addOutput({ script: boarding.pkScript, amount: 330n })
    claim.addOutput({ script: p2tr(await keyOf(13)), amount: BigInt(VALUE - 1_000) })
    chain.raw.set(claim.id, claim.toBytes(true, true))
    chain.outspends.set(parent.id, [{ spent: true, txid: claim.id }])

    expect(await refunder().advance(lockup, null, save)).toEqual({ kind: 'spent' })
  })

  it('reports the window closed once the client CSV is near, and rethrows before that', async () => {
    cosignFails = new Error('input 0 has an available exit closure')
    chain.status.set(parent.id, { confirmed: true, blockTime: NOW - EXIT_DELAY + 300, blockHeight: 1 })
    expect(await refunder().advance(lockup, null, save)).toEqual({ kind: 'closed', reason: cosignFails.message })
    chain.status.set(parent.id, { confirmed: true, blockTime: NOW - EXIT_DELAY + 301, blockHeight: 1 })
    await expect(refunder().advance(lockup, null, save)).rejects.toThrow('available exit closure')
  })

  it('asks the chain about a lockup at most once a minute', async () => {
    const r = refunder()
    chain.tip = { ...chain.tip, time: REFUND_LOCKTIME }
    await r.advance(lockup, null, save)
    const calls = chain.calls
    now += 59
    expect(await r.advance(lockup, null, save)).toEqual({ kind: 'waiting' })
    expect(chain.calls).toBe(calls)
  })

  it('keeps the refund arkd broadcast when its reply never arrived', async () => {
    replyLost = true
    await expect(refunder().advance(lockup, null, save)).rejects.toThrow('reply never arrived')
    replyLost = false
    now += 60

    const step = await refunder().advance(lockup, saved[0]!, save)
    expect(step).toEqual({ kind: 'pending', record: { ...saved[0], tx: hex.encode(cosigned[0]!.extract()) } })
    expect(cosigned).toHaveLength(1)
  })

  it('asks arkd again when an attempt never went out, once a lagging explorer had time to show it', async () => {
    cosignFails = new Error('arkd refused to co-sign (500)')
    await expect(refunder().advance(lockup, null, save)).rejects.toThrow('500')
    cosignFails = null
    now += 60
    expect(await refunder().advance(lockup, saved[0]!, save)).toEqual({ kind: 'pending', record: saved[0] })
    expect(cosigned).toHaveLength(0)
    now += 60

    const step = await refunder().advance(lockup, saved[0]!, save)
    expect(step).toMatchObject({ kind: 'pending', record: { txid: cosigned[0]!.id } })
    expect(cosigned).toHaveLength(1)
  })

  it('records the push even when the explorer has not seen the refund yet', async () => {
    explorerLags = true
    expect(await pushed()).toMatchObject({ txid: cosigned[0]!.id, tx: null })
  })

  it('reads the final tx later, rebroadcasts it if dropped, and reports confirmation', async () => {
    const record = { ...(await pushed()), tx: null }
    const tracked = await refunder().advance(lockup, record, save)
    expect(tracked).toEqual({ kind: 'pending', record: { ...record, tx: hex.encode(cosigned[0]!.extract()) } })

    const withTx = (tracked as { record: UnrolledRefundRecord }).record
    chain.status.delete(record.txid)
    expect(await refunder().advance(lockup, withTx, save)).toEqual({ kind: 'pending', record: withTx })
    expect(chain.broadcasts).toEqual([withTx.tx])

    chain.status.set(record.txid, { confirmed: true, blockTime: NOW, blockHeight: 900_001 })
    expect(await refunder().advance(lockup, withTx, save)).toEqual({ kind: 'confirmed', record: withTx })
  })

  it('waits on a spender the explorer does not name, and reports one paying someone else', async () => {
    const record = await pushed()
    chain.status.delete(record.txid)
    chain.outspends.set(parent.id, [{ spent: true }])
    expect((await refunder().advance(lockup, record, save)).kind).toBe('pending')
    expect(chain.broadcasts).toEqual([])
    chain.outspends.set(parent.id, [{ spent: true, txid: spendOfLockup(p2tr(await keyOf(13))) }])
    expect(await refunder().advance(lockup, record, save)).toEqual({ kind: 'spent' })
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
      const step = await refunder().advance(lockup, record, save)
      const [refund, child] = cosigned
      expect(step).toMatchObject({ kind: 'pending', record: { cpfpTxid: child!.id, feeRate: 60, broadcastAt: now } })
      expect(child!.getInput(0)).toMatchObject({ txid: hex.decode(refund!.id), index: 0 })
      const refundOut = Number(refund!.getOutput(0).amount)
      const packageFee = VALUE - refundOut + (refundOut - Number(child!.getOutput(0).amount))
      expect(packageFee).toBeGreaterThanOrEqual(60 * (refund!.vsize + child!.vsize))

      now += 20 * 60
      await refunder().advance(lockup, (step as { record: UnrolledRefundRecord }).record, save)
      expect(cosigned).toHaveLength(2)
    })

    it('leaves a refund alone while the unroll is unconfirmed or the refund already pays the rate', async () => {
      const record = await slowRefund()
      chain.status.set(parent.id, { confirmed: false })
      expect((await refunder().advance(lockup, record, save)).kind).toBe('pending')
      chain.status.set(parent.id, { confirmed: true, blockTime: NOW - 600, blockHeight: 899_999 })
      chain.feeRate = 10
      now += 60
      expect((await refunder().advance(lockup, record, save)).kind).toBe('pending')
      expect(cosigned).toHaveLength(1)
    })

    it('reports a failed bump once, then waits another interval before asking again', async () => {
      const record = await slowRefund()
      cosignFails = new Error('arkd unreachable')
      await expect(refunder().advance(lockup, record, save)).rejects.toThrow('arkd unreachable')
      const kept = saved.at(-1)!
      expect(kept).toMatchObject({ txid: record.txid, cpfpTxid: null, broadcastAt: now })

      cosignFails = null
      now += 60
      order.length = 0
      expect(await refunder().advance(lockup, kept, save)).toEqual({ kind: 'pending', record: kept })
      expect(order).toEqual([])
    })
  })
})
