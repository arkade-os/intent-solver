/**
 * The solver's spend of a lockup the client unrolled onto Bitcoin, through arkd's
 * `CosignOnchainTx` (v0.9.22, `POST /v1/tx/onchain/cosign`): the refund on a receive leg,
 * the claim on a send leg.
 *
 * arkd refuses every offchain spend of an unrolled VTXO, and the unroll restarts every solo
 * CSV. `refundWithoutReceiver` carries only a CLTV and `claim` no timelock, so the unroll
 * delays neither. arkd co-signs an outpoint ONCE, which shuts out the client's own co-signed
 * spend, but means ours is never replaced: a dropped one is rebroadcast, and a slow one gets
 * one co-signed CPFP child.
 */

import { setArkPsbtField, Transaction, VtxoTaprootTree, type OnchainProvider, type TapLeafScript } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { claimIdentity } from './claimIdentity.js'
import { ONCHAIN_DUST_SATS } from '@arkade-os/solver-core/core/onchainReceive.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type { CovenantSwapScript } from './covenant.js'
import type { ArkadeContext } from './wallet.js'

/** What the row keeps between ticks. */
export interface UnrolledSpendRecord {
  txid: string
  /** The final transaction, hex, once an explorer has it. */
  tx: string | null
  /** sat/vB the newest version was priced at: the spend alone, or with its CPFP child. */
  feeRate: number
  broadcastAt: number
  cpfpTxid: string | null
  /** The final child, hex, once an explorer has it: arkd co-signs one, so a dropped one is resent. */
  cpfpTx?: string | null
}

/** Persists a record before arkd is asked to co-sign it, so a lost reply cannot lose arkd's one signature. */
export type SaveUnrolledSpend = (record: UnrolledSpendRecord) => Promise<void>

export const parseUnrolledSpend = (raw: string | null): UnrolledSpendRecord | null =>
  raw === null ? null : (JSON.parse(raw) as UnrolledSpendRecord)

export type UnrolledSpendStep =
  | { kind: 'waiting' }
  /** Spent by a transaction that is not ours: the client's own spend, normally. */
  | { kind: 'spent' }
  /** No co-signed spend will happen: arkd stopped co-signing, or the lockup cannot pay for one. */
  | { kind: 'closed'; reason: string }
  | { kind: 'pending'; record: UnrolledSpendRecord }
  | { kind: 'confirmed'; record: UnrolledSpendRecord }

export type UnrolledSpend = {
  script: CovenantSwapScript
  txid: string
  vout: number
  /** The script's shortest CSV, seconds: arkd stops co-signing as it nears. */
  exitDelaySeconds: number
} & ({ refundLocktime: number } | { preimage: Uint8Array })

export interface UnrolledSpendDeps {
  chain: Pick<
    OnchainProvider,
    'getChainTip' | 'getFeeRate' | 'getRawTransaction' | 'getTxStatus' | 'getTxOutspends' | 'broadcastTransaction'
  >
  signer: { sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> }
  /** arkd adds its signature, broadcasts, and returns the txid. */
  cosign(psbtBase64: string): Promise<string>
  /** The wallet's boarding script: the spend lands back in the float. */
  boarding: { pkScript: Uint8Array; forfeit(): TapLeafScript; encode(): Uint8Array }
  now(): number
  pause?: (ms: number) => Promise<void>
}

const LOCKTIME_THRESHOLD = 500_000_000
/** arkd's `UnrolledVtxoMinExpiryMargin` default. */
const COSIGN_EXIT_MARGIN_SECONDS = 300
/** The sweep ticks every few seconds; arkd and the explorer hear from a lockup once a minute. */
const ADVANCE_INTERVAL_SECONDS = 60
const RETRY_AFTER_SECONDS = 2 * ADVANCE_INTERVAL_SECONDS
const BUMP_AFTER_SECONDS = 20 * 60
/** The bump is one shot, so it is priced above the estimate rather than at it. */
const BUMP_FACTOR = 1.5
/** Long enough for arkd's broadcast to reach the explorer before the client can evict it. */
const READ_ATTEMPTS = 3
const READ_PAUSE_MS = 2_000
/** Pay-to-anchor, `OP_1 <0x4e73>`: the anchor every SDK virtual tx carries. */
const P2A_SCRIPT = '51024e73'

type Chain = UnrolledSpendDeps['chain']

/** No fee rate makes this spend relay, so no later tick will push one either. */
class UnspendableLockup extends Error {}

const leafOf = (lockup: UnrolledSpend) =>
  'preimage' in lockup
    ? { leaf: lockup.script.claim(), lockTime: 0, preimage: lockup.preimage }
    : { leaf: lockup.script.refundWithoutReceiver(), lockTime: lockup.refundLocktime, preimage: null }

const feeRateNow = async (chain: Chain): Promise<number> => {
  const rate = await chain.getFeeRate()
  if (rate === undefined || !(rate > 0)) throw new Error('no fee estimate to price a transaction arkd co-signs once')
  return rate
}

/** vsize once finalized with two schnorr signatures, any preimage, the leaf script and its control block. */
const signedVsize = (
  unsigned: Transaction,
  [controlBlock, scriptWithVersion]: TapLeafScript,
  preimage: Uint8Array | null,
): number => {
  const tx = unsigned.clone()
  tx.updateInput(
    0,
    {
      finalScriptWitness: [
        new Uint8Array(64),
        new Uint8Array(64),
        ...(preimage ? [preimage] : []),
        scriptWithVersion.subarray(0, -1),
        new Uint8Array(33 + 32 * controlBlock.merklePath.length),
      ],
    },
    true,
  )
  return tx.vsize
}

interface SpentOutput {
  txid: string
  vout: number
  script: Uint8Array
  value: number
}

/** One input spending `leaf`, one output back to the boarding script. */
const spendTx = (
  input: SpentOutput,
  leaf: TapLeafScript,
  tapTree: Uint8Array,
  destination: Uint8Array,
  fee: number,
  lockTime = 0,
) => {
  const tx = new Transaction({ version: 3, lockTime })
  tx.addInput({
    txid: input.txid,
    index: input.vout,
    // Non-final, or the CLTV is not enforced.
    sequence: lockTime ? 0xfffffffe : undefined,
    witnessUtxo: { script: input.script, amount: BigInt(input.value) },
    tapLeafScript: [leaf],
  })
  setArkPsbtField(tx, 0, VtxoTaprootTree, tapTree)
  tx.addOutput({ script: destination, amount: BigInt(input.value - fee) })
  return tx
}

/** From the bytes: btc-signer reports no vsize for a parsed input it does not see as finalized. */
const vsizeOf = (raw: Uint8Array): number =>
  Math.ceil((Transaction.fromRaw(raw).toBytes(true, false).length * 3 + raw.length) / 4)

const outputScript = (tx: Transaction, vout: number): string | null => {
  const script = tx.getOutput(vout)?.script
  return script ? hex.encode(script) : null
}

export class UnrolledSpender {
  private readonly lastAdvance = new Map<string, number>()

  constructor(private readonly deps: UnrolledSpendDeps) {}

  async advance(
    lockup: UnrolledSpend,
    record: UnrolledSpendRecord | null,
    save: SaveUnrolledSpend,
  ): Promise<UnrolledSpendStep> {
    const key = `${lockup.txid}:${lockup.vout}`
    const now = this.deps.now()
    if (now - (this.lastAdvance.get(key) ?? -Infinity) < ADVANCE_INTERVAL_SECONDS) return { kind: 'waiting' }
    this.lastAdvance.set(key, now)
    return record ? this.track(lockup, record, save) : this.start(lockup, save)
  }

  private async start(lockup: UnrolledSpend, save: SaveUnrolledSpend): Promise<UnrolledSpendStep> {
    const { chain } = this.deps
    const { lockTime } = leafOf(lockup)
    if (lockTime > 0) {
      const tip = await chain.getChainTip()
      if (lockTime < LOCKTIME_THRESHOLD ? tip.height < lockTime : tip.time <= lockTime) return { kind: 'waiting' }
    }
    const out = (await chain.getTxOutspends(lockup.txid))[lockup.vout]
    if (out?.spent) {
      const ours = out.txid === undefined ? null : await this.adopt(out.txid)
      return ours ? this.track(lockup, ours, save) : { kind: 'spent' }
    }
    try {
      return { kind: 'pending', record: await this.push(lockup, save) }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof UnspendableLockup) return { kind: 'closed', reason }
      const unroll = await chain.getTxStatus(lockup.txid).catch(() => null)
      if (
        unroll?.confirmed &&
        this.deps.now() >= unroll.blockTime + lockup.exitDelaySeconds - COSIGN_EXIT_MARGIN_SECONDS
      ) {
        return { kind: 'closed', reason }
      }
      throw error
    }
  }

  private async push(lockup: UnrolledSpend, save: SaveUnrolledSpend): Promise<UnrolledSpendRecord> {
    const { chain, boarding } = this.deps
    const parentRaw = await chain.getRawTransaction(lockup.txid)
    const parent = Transaction.fromRaw(parentRaw)
    if (outputScript(parent, lockup.vout) !== hex.encode(lockup.script.pkScript)) {
      throw new Error(`${lockup.txid}:${lockup.vout} does not pay the lockup script`)
    }
    const value = Number(parent.getOutput(lockup.vout).amount)
    const feeRate = await feeRateNow(chain)
    const { leaf, lockTime, preimage } = leafOf(lockup)
    const input = { txid: lockup.txid, vout: lockup.vout, script: lockup.script.pkScript, value }
    const build = (fee: number) => spendTx(input, leaf, lockup.script.encode(), boarding.pkScript, fee, lockTime)
    const vsize = signedVsize(build(0), leaf, preimage)
    const cap = value - ONCHAIN_DUST_SATS
    if (cap < vsize) throw new UnspendableLockup(`a ${value} sat lockup cannot pay for its own L1 spend`)

    let fee = Math.ceil(feeRate * vsize)
    if (!(await chain.getTxStatus(lockup.txid)).confirmed) {
      // A zero-fee TRUC parent whose one child is the client's anchor spend. This spend
      // replaces that child, so it pays for the parent and beats the child's fee and
      // feerate; until it does, the client's own co-signed spend can still win.
      fee = Math.ceil(feeRate * (vsize + vsizeOf(parentRaw)))
      const sibling = await this.anchorChild(lockup.txid, parent)
      if (sibling) {
        fee = Math.max(fee, sibling.fee + vsize, Math.ceil((sibling.fee / sibling.vsize + 1) * vsize))
        // No spend can replace a child bidding past the lockup, but a parent carried that high confirms.
        if (fee > cap) throw new Error(`the client's anchor child outbids all ${cap} sats this spend can pay`)
      }
    }
    const signer = preimage ? claimIdentity(this.deps.signer, preimage) : this.deps.signer
    const signed = await signer.sign(build(Math.min(fee, cap)), [0])
    const record = { txid: signed.id, tx: null, feeRate, broadcastAt: this.deps.now(), cpfpTxid: null }
    await save(record)
    const txid = await this.deps.cosign(base64.encode(signed.toPSBT()))
    if (txid !== signed.id) throw new Error(`arkd broadcast ${txid}, expected ${signed.id}`)
    return { ...record, tx: await this.readSoon(txid) }
  }

  private async track(
    lockup: UnrolledSpend,
    record: UnrolledSpendRecord,
    save: SaveUnrolledSpend,
  ): Promise<UnrolledSpendStep> {
    const { chain } = this.deps
    const status = await chain.getTxStatus(record.txid).catch(() => null)
    if (status?.confirmed) return { kind: 'confirmed', record }
    if (status) {
      const tx = record.tx ?? hex.encode(await chain.getRawTransaction(record.txid))
      if (record.cpfpTxid && record.cpfpTx && !(await chain.getTxStatus(record.cpfpTxid).catch(() => null))) {
        await chain.broadcastTransaction(record.cpfpTx)
      }
      return { kind: 'pending', record: await this.bump(lockup, { ...record, tx }, save) }
    }
    const out = (await chain.getTxOutspends(lockup.txid))[lockup.vout]
    if (out?.spent && out.txid !== undefined && out.txid !== record.txid) {
      const ours = await this.adopt(out.txid)
      return ours ? this.track(lockup, ours, save) : { kind: 'spent' }
    }
    // Spent by this spend, or by a spender the explorer does not name: wait.
    if (out?.spent) return { kind: 'pending', record }
    // Dropped: the same signed transaction is always safe to resend.
    if (record.tx) {
      await chain.broadcastTransaction(record.tx)
      return { kind: 'pending', record }
    }
    // Never seen: arkd refused it, or it left before any explorer kept it. Ask again, once
    // a lagging explorer has had time to show it. In the second case arkd refuses every retry
    // ("inputs already signed") and the row escalates when the window closes, naming the solo leaf.
    if (this.deps.now() - record.broadcastAt < RETRY_AFTER_SECONDS) return { kind: 'pending', record }
    return this.start(lockup, save)
  }

  /**
   * A spend whose one output pays our boarding script is one of ours: a client sending
   * it there only gives the sats back. Exactly one, so a claim with a dust output to us beside
   * its own cannot pass for ours.
   */
  private async adopt(txid: string): Promise<UnrolledSpendRecord | null> {
    const raw = await this.deps.chain.getRawTransaction(txid)
    const tx = Transaction.fromRaw(raw)
    if (tx.outputsLength !== 1 || outputScript(tx, 0) !== hex.encode(this.deps.boarding.pkScript)) return null
    return { txid, tx: hex.encode(raw), feeRate: 0, broadcastAt: this.deps.now(), cpfpTxid: null }
  }

  /**
   * The client's anchor spend of an unconfirmed unroll, priced from its prevouts. Null when the
   * explorer cannot name it or serve it: a client churning anchor children must not stall the push.
   */
  private async anchorChild(parentTxid: string, parent: Transaction): Promise<{ fee: number; vsize: number } | null> {
    const { chain } = this.deps
    const read = (txid: string) => chain.getRawTransaction(txid).catch(() => null)
    let anchor = -1
    for (let i = 0; i < parent.outputsLength; i++) if (outputScript(parent, i) === P2A_SCRIPT) anchor = i
    const spender = anchor < 0 ? undefined : (await chain.getTxOutspends(parentTxid))[anchor]
    if (!spender?.spent || spender.txid === undefined) return null
    const raw = await read(spender.txid)
    if (!raw) return null
    const child = Transaction.fromRaw(raw)
    let fee = 0
    for (let i = 0; i < child.inputsLength; i++) {
      const { txid, index } = child.getInput(i)
      if (txid === undefined || index === undefined) return null
      const prevTxid = hex.encode(txid)
      const prevRaw = prevTxid === parentTxid ? null : await read(prevTxid)
      const prev = prevTxid === parentTxid ? parent : prevRaw && Transaction.fromRaw(prevRaw)
      if (!prev || index >= prev.outputsLength) return null
      fee += Number(prev.getOutput(index).amount)
    }
    for (let i = 0; i < child.outputsLength; i++) fee -= Number(child.getOutput(i).amount)
    return { fee, vsize: vsizeOf(raw) }
  }

  /** arkd returns no tx, and the client can evict this one at once: read it while it is still around. */
  private async readSoon(txid: string): Promise<string | null> {
    const pause = this.deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let attempt = 1; ; attempt++) {
      const raw = await this.deps.chain.getRawTransaction(txid).catch(() => null)
      if (raw) return hex.encode(raw)
      if (attempt === READ_ATTEMPTS) return null
      await pause(READ_PAUSE_MS)
    }
  }

  private async bump(
    lockup: UnrolledSpend,
    record: UnrolledSpendRecord & { tx: string },
    save: SaveUnrolledSpend,
  ): Promise<UnrolledSpendRecord> {
    const { chain, boarding } = this.deps
    if (record.cpfpTxid !== null || this.deps.now() - record.broadcastAt < BUMP_AFTER_SECONDS) return record
    // TRUC: a child of the refund while the unroll is unconfirmed would be a third generation.
    if (!(await chain.getTxStatus(lockup.txid)).confirmed) return record
    const refundRaw = hex.decode(record.tx)
    const refund = Transaction.fromRaw(refundRaw)
    const refundVsize = vsizeOf(refundRaw)
    const output = Number(refund.getOutput(0).amount)
    const lockupValue = Number(
      Transaction.fromRaw(await chain.getRawTransaction(lockup.txid)).getOutput(lockup.vout).amount,
    )
    const refundFee = lockupValue - output
    const estimate = await feeRateNow(chain)
    if (refundFee >= refundVsize * estimate) return record

    const feeRate = estimate * BUMP_FACTOR
    const leaf = boarding.forfeit()
    const input = { txid: record.txid, vout: 0, script: boarding.pkScript, value: output }
    const build = (fee: number) => spendTx(input, leaf, boarding.encode(), boarding.pkScript, fee)
    const childVsize = signedVsize(build(0), leaf, null)
    const cap = output - ONCHAIN_DUST_SATS
    if (cap < childVsize) return record
    // The child pays the refund's shortfall at `feeRate` as well as its own way.
    const fee = Math.min(Math.ceil(feeRate * (refundVsize + childVsize)) - refundFee, cap)
    // No pre-commit: losing the reply loses only the bump, and arkd refuses a second child.
    const signed = await this.deps.signer.sign(build(fee), [0])
    try {
      const cpfpTxid = await this.deps.cosign(base64.encode(signed.toPSBT()))
      return { ...record, cpfpTxid, cpfpTx: await this.readSoon(cpfpTxid), feeRate, broadcastAt: this.deps.now() }
    } catch (error) {
      // The refund stands without its bump: ask again after another interval, not every tick.
      await save({ ...record, broadcastAt: this.deps.now() })
      throw error
    }
  }
}

/** `POST /v1/tx/onchain/cosign`, which the pinned SDK does not wrap. */
export const cosignOnchainTx = async (arkServerUrl: string, psbtBase64: string): Promise<string> => {
  const response = await fetch(`${arkServerUrl.replace(/\/$/, '')}/v1/tx/onchain/cosign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: psbtBase64 }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`arkd refused to co-sign (${response.status}): ${body}`)
  const { txid } = JSON.parse(body) as { txid?: unknown }
  if (typeof txid !== 'string' || txid.length !== 64) throw new Error(`arkd co-signed but returned no txid: ${body}`)
  return txid
}

export const unrolledSpenderFor = (ctx: ArkadeContext): UnrolledSpender =>
  new UnrolledSpender({
    chain: ctx.wallet.onchainProvider,
    signer: ctx.identity,
    cosign: (psbt) => cosignOnchainTx(ctx.arkServerUrl, psbt),
    boarding: ctx.wallet.boardingTapscript,
    now: nowSeconds,
  })
