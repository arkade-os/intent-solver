/**
 * The solver's refund of a lockup the client unrolled onto Bitcoin, through arkd's
 * `CosignOnchainTx` (v0.9.22, `POST /v1/tx/onchain/cosign`).
 *
 * arkd refuses every offchain spend of an unrolled VTXO, and the unroll restarts both
 * solo CSVs with the client's first. `refundWithoutReceiver` carries only a CLTV, so
 * the unroll cannot delay it. arkd co-signs an outpoint ONCE, which also shuts out the
 * client's own co-signed L1 claim, but means the refund is never replaced: a dropped
 * one is rebroadcast, and a slow one gets one co-signed CPFP child.
 */

import { setArkPsbtField, Transaction, VtxoTaprootTree, type OnchainProvider, type TapLeafScript } from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { ONCHAIN_DUST_SATS } from '@arkade-os/solver-core/core/onchainReceive.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import type { CovenantSwapScript } from './covenant.js'
import type { ArkadeContext } from './wallet.js'

/** What the row keeps between ticks. */
export interface UnrolledRefundRecord {
  txid: string
  /** The final transaction, hex, once an explorer has it. */
  tx: string | null
  /** sat/vB the newest version was priced at: the refund alone, or with its CPFP child. */
  feeRate: number
  broadcastAt: number
  cpfpTxid: string | null
}

/** Persists a record before arkd is asked to co-sign it, so a lost reply cannot lose arkd's one signature. */
export type SaveUnrolledRefund = (record: UnrolledRefundRecord) => Promise<void>

export const parseUnrolledRefund = (raw: string | null): UnrolledRefundRecord | null =>
  raw === null ? null : (JSON.parse(raw) as UnrolledRefundRecord)

export type UnrolledRefundStep =
  | { kind: 'waiting' }
  /** Spent by a transaction that is not this refund — the client's claim, normally. */
  | { kind: 'spent' }
  /** arkd will not co-sign any more: the client's own CSV is about to open. */
  | { kind: 'closed'; reason: string }
  | { kind: 'pending'; record: UnrolledRefundRecord }
  | { kind: 'confirmed'; record: UnrolledRefundRecord }

export interface UnrolledLockup {
  script: CovenantSwapScript
  txid: string
  vout: number
  refundLocktime: number
  /** The script's shortest CSV, seconds: arkd stops co-signing as it nears. */
  exitDelaySeconds: number
}

export interface UnrolledRefundDeps {
  chain: Pick<
    OnchainProvider,
    'getChainTip' | 'getFeeRate' | 'getRawTransaction' | 'getTxStatus' | 'getTxOutspends' | 'broadcastTransaction'
  >
  signer: { sign(tx: Transaction, inputIndexes?: number[]): Promise<Transaction> }
  /** arkd adds its signature, broadcasts, and returns the txid. */
  cosign(psbtBase64: string): Promise<string>
  /** The wallet's boarding script: the refund lands back in the float. */
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
const P2A_SCRIPT = '51024e73'

type Chain = UnrolledRefundDeps['chain']

const feeRateNow = async (chain: Chain): Promise<number> => {
  const rate = await chain.getFeeRate()
  if (rate === undefined || !(rate > 0)) throw new Error('no fee estimate to price a transaction arkd co-signs once')
  return rate
}

/** vsize once finalized with two schnorr signatures, the leaf script and its control block. */
const signedVsize = (tx: Transaction, [controlBlock, scriptWithVersion]: TapLeafScript): number => {
  tx.updateInput(
    0,
    {
      finalScriptWitness: [
        new Uint8Array(64),
        new Uint8Array(64),
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

export class UnrolledRefunder {
  private readonly lastAdvance = new Map<string, number>()

  constructor(private readonly deps: UnrolledRefundDeps) {}

  async advance(
    lockup: UnrolledLockup,
    record: UnrolledRefundRecord | null,
    save: SaveUnrolledRefund,
  ): Promise<UnrolledRefundStep> {
    const key = `${lockup.txid}:${lockup.vout}`
    const now = this.deps.now()
    if (now - (this.lastAdvance.get(key) ?? -Infinity) < ADVANCE_INTERVAL_SECONDS) return { kind: 'waiting' }
    this.lastAdvance.set(key, now)
    return record ? this.track(lockup, record, save) : this.start(lockup, save)
  }

  private async start(lockup: UnrolledLockup, save: SaveUnrolledRefund): Promise<UnrolledRefundStep> {
    const { chain } = this.deps
    const tip = await chain.getChainTip()
    const matured =
      lockup.refundLocktime < LOCKTIME_THRESHOLD
        ? tip.height >= lockup.refundLocktime
        : tip.time > lockup.refundLocktime
    if (!matured) return { kind: 'waiting' }
    const out = (await chain.getTxOutspends(lockup.txid))[lockup.vout]
    if (out?.spent) {
      const ours = out.txid === undefined ? null : await this.adopt(out.txid)
      return ours ? this.track(lockup, ours, save) : { kind: 'spent' }
    }
    try {
      return { kind: 'pending', record: await this.push(lockup, save) }
    } catch (error) {
      const unroll = await chain.getTxStatus(lockup.txid).catch(() => null)
      if (
        unroll?.confirmed &&
        this.deps.now() >= unroll.blockTime + lockup.exitDelaySeconds - COSIGN_EXIT_MARGIN_SECONDS
      ) {
        return { kind: 'closed', reason: error instanceof Error ? error.message : String(error) }
      }
      throw error
    }
  }

  private async push(lockup: UnrolledLockup, save: SaveUnrolledRefund): Promise<UnrolledRefundRecord> {
    const { chain, boarding } = this.deps
    const parentRaw = await chain.getRawTransaction(lockup.txid)
    const parent = Transaction.fromRaw(parentRaw)
    if (outputScript(parent, lockup.vout) !== hex.encode(lockup.script.pkScript)) {
      throw new Error(`${lockup.txid}:${lockup.vout} does not pay the lockup script`)
    }
    const value = Number(parent.getOutput(lockup.vout).amount)
    const feeRate = await feeRateNow(chain)
    const leaf = lockup.script.refundWithoutReceiver()
    const input = { txid: lockup.txid, vout: lockup.vout, script: lockup.script.pkScript, value }
    const build = (fee: number) =>
      spendTx(input, leaf, lockup.script.encode(), boarding.pkScript, fee, lockup.refundLocktime)
    const vsize = signedVsize(build(0), leaf)
    const cap = value - ONCHAIN_DUST_SATS
    if (cap < vsize) throw new Error(`a ${value} sat lockup cannot pay for its own L1 refund`)

    let fee = Math.ceil(feeRate * vsize)
    if (!(await chain.getTxStatus(lockup.txid)).confirmed) {
      // A zero-fee TRUC parent whose one child is the client's anchor spend. This refund
      // replaces that child, so it pays for the parent and beats the child's fee and
      // feerate; arkd stays free to co-sign the client's claim past E until it does.
      fee = Math.ceil(feeRate * (vsize + vsizeOf(parentRaw)))
      const sibling = await this.anchorChild(lockup.txid, parent)
      if (sibling) {
        fee = Math.max(fee, sibling.fee + vsize, Math.ceil((sibling.fee / sibling.vsize + 1) * vsize))
        // No refund can replace a child bidding past the lockup, but a parent carried that high confirms.
        if (fee > cap) throw new Error(`the client's anchor child outbids all ${cap} sats this refund can pay`)
      }
    }
    const signed = await this.deps.signer.sign(build(Math.min(fee, cap)), [0])
    const record = { txid: signed.id, tx: null, feeRate, broadcastAt: this.deps.now(), cpfpTxid: null }
    await save(record)
    const txid = await this.deps.cosign(base64.encode(signed.toPSBT()))
    if (txid !== signed.id) throw new Error(`arkd broadcast ${txid}, expected the refund ${signed.id}`)
    return { ...record, tx: await this.readSoon(txid) }
  }

  private async track(
    lockup: UnrolledLockup,
    record: UnrolledRefundRecord,
    save: SaveUnrolledRefund,
  ): Promise<UnrolledRefundStep> {
    const { chain } = this.deps
    const status = await chain.getTxStatus(record.txid).catch(() => null)
    if (status?.confirmed) return { kind: 'confirmed', record }
    if (status) {
      const tx = record.tx ?? hex.encode(await chain.getRawTransaction(record.txid))
      return { kind: 'pending', record: await this.bump(lockup, { ...record, tx }) }
    }
    const out = (await chain.getTxOutspends(lockup.txid))[lockup.vout]
    if (out?.spent && out.txid !== undefined && out.txid !== record.txid) {
      const ours = await this.adopt(out.txid)
      return ours ? this.track(lockup, ours, save) : { kind: 'spent' }
    }
    // Spent by this refund, or by a spender the explorer does not name: wait.
    if (out?.spent) return { kind: 'pending', record }
    // Dropped: the same signed transaction is always safe to resend.
    if (record.tx) {
      await chain.broadcastTransaction(record.tx)
      return { kind: 'pending', record }
    }
    // Never seen: arkd refused it, or it left before any explorer kept it. Ask again, once
    // a lagging explorer has had time to show it; arkd refuses only if it did co-sign this outpoint.
    if (this.deps.now() - record.broadcastAt < RETRY_AFTER_SECONDS) return { kind: 'pending', record }
    return this.start(lockup, save)
  }

  /**
   * A spend whose one output pays our boarding script is one of our refunds: a client sending
   * it there only gives the sats back. Exactly one, so a claim with a dust output to us beside
   * its own cannot pass for a refund.
   */
  private async adopt(txid: string): Promise<UnrolledRefundRecord | null> {
    const raw = await this.deps.chain.getRawTransaction(txid)
    const tx = Transaction.fromRaw(raw)
    if (tx.outputsLength !== 1 || outputScript(tx, 0) !== hex.encode(this.deps.boarding.pkScript)) return null
    return { txid, tx: hex.encode(raw), feeRate: 0, broadcastAt: this.deps.now(), cpfpTxid: null }
  }

  /** The client's anchor spend of an unconfirmed unroll, priced from its prevouts. Null when the explorer cannot name it. */
  private async anchorChild(parentTxid: string, parent: Transaction): Promise<{ fee: number; vsize: number } | null> {
    const { chain } = this.deps
    let anchor = -1
    for (let i = 0; i < parent.outputsLength; i++) if (outputScript(parent, i) === P2A_SCRIPT) anchor = i
    const spender = anchor < 0 ? undefined : (await chain.getTxOutspends(parentTxid))[anchor]
    if (!spender?.spent || spender.txid === undefined) return null
    const raw = await chain.getRawTransaction(spender.txid)
    const child = Transaction.fromRaw(raw)
    let fee = 0
    for (let i = 0; i < child.inputsLength; i++) {
      const { txid, index } = child.getInput(i)
      if (txid === undefined || index === undefined) return null
      const prevTxid = hex.encode(txid)
      const prev = prevTxid === parentTxid ? parent : Transaction.fromRaw(await chain.getRawTransaction(prevTxid))
      if (index >= prev.outputsLength) return null
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
    lockup: UnrolledLockup,
    record: UnrolledRefundRecord & { tx: string },
  ): Promise<UnrolledRefundRecord> {
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
    const childVsize = signedVsize(build(0), leaf)
    const cap = output - ONCHAIN_DUST_SATS
    if (cap < childVsize) return record
    // The child pays the refund's shortfall at `feeRate` as well as its own way.
    const fee = Math.min(Math.ceil(feeRate * (refundVsize + childVsize)) - refundFee, cap)
    // No pre-commit: losing the reply loses only the bump, and arkd refuses a second child.
    const signed = await this.deps.signer.sign(build(fee), [0])
    const cpfpTxid = await this.deps.cosign(base64.encode(signed.toPSBT()))
    return { ...record, cpfpTxid, feeRate, broadcastAt: this.deps.now() }
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

export const unrolledRefunderFor = (ctx: ArkadeContext): UnrolledRefunder =>
  new UnrolledRefunder({
    chain: ctx.wallet.onchainProvider,
    signer: ctx.identity,
    cosign: (psbt) => cosignOnchainTx(ctx.arkServerUrl, psbt),
    boarding: ctx.wallet.boardingTapscript,
    now: nowSeconds,
  })
