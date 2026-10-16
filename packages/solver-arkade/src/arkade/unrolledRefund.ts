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
}

const LOCKTIME_THRESHOLD = 500_000_000
/** arkd's `UnrolledVtxoMinExpiryMargin` default. */
const COSIGN_EXIT_MARGIN_SECONDS = 300
/** The sweep ticks every few seconds; arkd and the explorer hear from a lockup once a minute. */
const ADVANCE_INTERVAL_SECONDS = 60
const BUMP_AFTER_SECONDS = 20 * 60
/** The bump is one shot, so it is priced above the estimate rather than at it. */
const BUMP_FACTOR = 1.5

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

/**
 * The fee for `vsize` at `feeRate`, capped to leave dust. Null when even the cap cannot pay
 * 1 sat/vB. solver-rails' `affordableFee`, restated: this layer may import only core.
 */
const affordableFee = (vsize: number, feeRate: number, valueSats: number): number | null => {
  const cap = valueSats - ONCHAIN_DUST_SATS
  return cap < vsize ? null : Math.min(Math.ceil(vsize * feeRate), cap)
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

/** The lockup's output as Bitcoin has it, which is what arkd checks the prevout against. */
const lockupOutput = async (chain: Chain, lockup: UnrolledLockup): Promise<{ vsize: number; value: number }> => {
  const raw = await chain.getRawTransaction(lockup.txid)
  const output = Transaction.fromRaw(raw).getOutput(lockup.vout)
  if (!output?.script || hex.encode(output.script) !== hex.encode(lockup.script.pkScript)) {
    throw new Error(`${lockup.txid}:${lockup.vout} does not pay the lockup script`)
  }
  return { vsize: vsizeOf(raw), value: Number(output.amount) }
}

export class UnrolledRefunder {
  private readonly lastAdvance = new Map<string, number>()

  constructor(private readonly deps: UnrolledRefundDeps) {}

  async advance(lockup: UnrolledLockup, record: UnrolledRefundRecord | null): Promise<UnrolledRefundStep> {
    const key = `${lockup.txid}:${lockup.vout}`
    const now = this.deps.now()
    if (now - (this.lastAdvance.get(key) ?? -Infinity) < ADVANCE_INTERVAL_SECONDS) return { kind: 'waiting' }
    this.lastAdvance.set(key, now)
    return record ? this.track(lockup, record) : this.start(lockup)
  }

  private async start(lockup: UnrolledLockup): Promise<UnrolledRefundStep> {
    const { chain } = this.deps
    const tip = await chain.getChainTip()
    const matured =
      lockup.refundLocktime < LOCKTIME_THRESHOLD
        ? tip.height >= lockup.refundLocktime
        : tip.time > lockup.refundLocktime
    if (!matured) return { kind: 'waiting' }
    if ((await chain.getTxOutspends(lockup.txid))[lockup.vout]?.spent) return { kind: 'spent' }
    try {
      return { kind: 'pending', record: await this.push(lockup) }
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

  private async push(lockup: UnrolledLockup): Promise<UnrolledRefundRecord> {
    const { chain, boarding } = this.deps
    const parent = await lockupOutput(chain, lockup)
    const value = parent.value
    // Unconfirmed, the unroll is a zero-fee TRUC parent: this refund evicts the
    // client's anchor child and pays for both. Waiting for it to confirm would leave
    // arkd free to co-sign the client's claim past E.
    const parentVsize = (await chain.getTxStatus(lockup.txid)).confirmed ? 0 : parent.vsize
    const feeRate = await feeRateNow(chain)
    const leaf = lockup.script.refundWithoutReceiver()
    const input = { txid: lockup.txid, vout: lockup.vout, script: lockup.script.pkScript, value }
    const build = (fee: number) =>
      spendTx(input, leaf, lockup.script.encode(), boarding.pkScript, fee, lockup.refundLocktime)
    const fee = affordableFee(signedVsize(build(0), leaf) + parentVsize, feeRate, value)
    if (fee === null) throw new Error(`a ${value} sat lockup cannot pay for its own L1 refund`)
    const signed = await this.deps.signer.sign(build(fee), [0])
    const txid = await this.deps.cosign(base64.encode(signed.toPSBT()))
    if (txid !== signed.id) throw new Error(`arkd broadcast ${txid}, expected the refund ${signed.id}`)
    // arkd returns no tx, and the client can evict this one at once. Read it now if the
    // explorer has it, never throwing past arkd's one co-signature; later ticks retry.
    const tx = await chain.getRawTransaction(txid).then(hex.encode, () => null)
    return { txid, tx, feeRate, broadcastAt: this.deps.now(), cpfpTxid: null }
  }

  private async track(lockup: UnrolledLockup, record: UnrolledRefundRecord): Promise<UnrolledRefundStep> {
    const { chain } = this.deps
    const status = await chain.getTxStatus(record.txid).catch(() => null)
    if (status?.confirmed) return { kind: 'confirmed', record }
    if (status === null) {
      const out = (await chain.getTxOutspends(lockup.txid))[lockup.vout]
      // Some explorers omit the spender: unknown is not "someone else".
      if (out?.spent && out.txid !== undefined && out.txid !== record.txid) return { kind: 'spent' }
      // Dropped, or not propagated yet: the same signed transaction is always safe to resend.
      if (record.tx) await chain.broadcastTransaction(record.tx)
      return { kind: 'pending', record }
    }
    const tx = record.tx ?? hex.encode(await chain.getRawTransaction(record.txid))
    return { kind: 'pending', record: await this.bump(lockup, { ...record, tx }) }
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
    const refundVsize = vsizeOf(refundRaw)
    const output = Number(Transaction.fromRaw(refundRaw).getOutput(0).amount)
    const refundFee = (await lockupOutput(chain, lockup)).value - output
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
