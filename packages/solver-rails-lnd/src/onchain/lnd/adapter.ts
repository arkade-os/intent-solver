/**
 * The one and only place the LND backend SDK is imported for onchain
 * concerns. Same rule as `src/ln/lnd/adapter.ts`: everything above this file
 * speaks {@link OnchainSendBackend} — plain hex strings and unix seconds.
 *
 * Unlike a rail that can only reach the chain through Esplora, LND needs no
 * separate client for these: `broadcastChainTransaction` broadcasts any raw tx
 * (not limited to LND's own wallet outputs), and
 * `getChainTransactions`/`getChainFeeRate` cover watching and fee estimation
 * without a second network dependency.
 */

import {
  authenticatedLndGrpc,
  broadcastChainTransaction,
  createChainAddress,
  getChainBalance as lndGetChainBalance,
  getChainFeeRate as lndGetChainFeeRate,
  getChainTransactions as lndGetChainTransactions,
  getPendingChainBalance as lndGetPendingChainBalance,
  getWalletInfo as lndGetWalletInfo,
  sendToChainAddress,
  subscribeToChainSpend,
  type AuthenticatedLnd,
} from 'lightning'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { deadlined } from '../../deadline.js'
import { probeLnd } from '../../ln/lnd/adapter.js'
import {
  createEsploraClient,
  type EsploraAuth,
  type EsploraClient,
  spenderOf,
  toFundedOutputs,
  txOutcomeVia,
  witnessFromRawTx,
} from '@arkade-os/solver-rails-esplora/esplora.js'
import type {
  FundedOnchainOutput,
  OnchainBalance,
  OnchainReceiveBackend,
  OnchainSendBackend,
  OnchainTxOutcome,
} from '@arkade-os/solver-core/ports/onchain.js'

// The reads, bounded. Every call site below is left as it was. @see ../../deadline.ts.
const getChainBalance = deadlined('getChainBalance', lndGetChainBalance)
const getChainFeeRate = deadlined('getChainFeeRate', lndGetChainFeeRate)
const getChainTransactions = deadlined('getChainTransactions', lndGetChainTransactions)
const getPendingChainBalance = deadlined('getPendingChainBalance', lndGetPendingChainBalance)
const getWalletInfo = deadlined('getWalletInfo', lndGetWalletInfo)

interface LndChainTx {
  id: string
  confirmation_count?: number
  output_addresses: string[]
  tokens: number
  /** `raw_tx_hex`, when LND supplied one. */
  transaction?: string
}

/**
 * `output_addresses` is LND's `dest_addresses`, deprecated in its own proto for `output_details` — whose
 * `OutputDetail` carries an explicit `output_index`, redundant if a list position were one. It lists
 * ADDRESSES, so an output with none (`SCRIPT_TYPE_NULLDATA`, `NON_STANDARD`) shifts every later index.
 */
const assertFundingVout = (raw: string | undefined, vout: number, amountSats: number, txid: string): void => {
  if (raw === undefined) return
  const parsed = Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const amount = vout < parsed.outputsLength ? parsed.getOutput(vout).amount : undefined
  if (amount === BigInt(amountSats)) return
  throw new Error(
    `funding tx ${txid} output ${vout} does not pay ${amountSats} sats (${amount ?? 'no such output'}) — ` +
      "LND's address list does not line up with the transaction, so the vout cannot be confirmed",
  )
}

export interface AdapterConfig {
  socket: string
  cert: string
  macaroon: string
  /**
   * Esplora base URL, REQUIRED BY BOTH DIRECTIONS. The send leg has needed it
   * since {@link LndOnchainAdapter.findSpendWitness} moved off lnd's spend
   * subscription; `transactionOutcome` is a further caller, not the first.
   */
  esploraUrl?: string
  esploraAuth?: EsploraAuth
}

/**
 * How long to wait for lnd to say whether an outpoint is spent.
 *
 * Not a "give up and assume unspent" budget — see {@link
 * LndOnchainAdapter.findSpendWitness}. Exceeding it is an error, so this is
 * only how long a caller waits before being told the answer is unknown.
 */
const SPEND_LOOKUP_TIMEOUT_MS = 5_000

export class LndOnchainAdapter implements OnchainSendBackend, OnchainReceiveBackend {
  private constructor(
    private readonly lnd: AuthenticatedLnd,
    private readonly esplora: EsploraClient | undefined,
  ) {}

  /** No round-trip, like the Lightning adapter's `open`. */
  static open(config: AdapterConfig): LndOnchainAdapter {
    const { lnd } = authenticatedLndGrpc(config)
    const esplora = config.esploraUrl ? createEsploraClient(config.esploraUrl, config.esploraAuth) : undefined
    return new LndOnchainAdapter(lnd, esplora)
  }

  static async create(config: AdapterConfig): Promise<LndOnchainAdapter> {
    const adapter = LndOnchainAdapter.open(config)
    await probeLnd(adapter.lnd, config.socket)
    return adapter
  }

  /**
   * `idempotencyKey` is accepted and DROPPED: `sendToChainAddress` exposes no
   * such key, so a re-drive here really would broadcast a second funding
   * transaction. What keeps that safe on this backend is the recovery path's
   * chain query — and it is effective here, because `fund()` locates its own
   * vout through the very `getChainTransactions` call `findOutputs` uses, so
   * anything that reached the node's wallet is already visible to it.
   */
  async fund(params: {
    address: string
    amountSats: number
    idempotencyKey: string
  }): Promise<{ txid: string; vout: number }> {
    const result = await sendToChainAddress({ lnd: this.lnd, address: params.address, tokens: params.amountSats })
    // sendToChainAddress's transaction may carry a change output, and
    // nothing guarantees the payment output comes first — confirmed live:
    // a boltz-lnd regtest send put ~1.99 BTC change at vout 0 and the
    // actual payment at vout 1. Re-fetch to find the real vout, the same
    // lookup findOutputs already does, narrowed to this specific txid.
    const { transactions } = await getChainTransactions({ lnd: this.lnd })
    const tx = (transactions as unknown as LndChainTx[]).find((t) => t.id === result.id)
    const vout = tx?.output_addresses.indexOf(params.address) ?? -1
    if (vout === -1) throw new Error(`funding tx ${result.id} does not pay ${params.address} — cannot locate its vout`)
    assertFundingVout(tx?.transaction, vout, params.amountSats, result.id)
    return { txid: result.id, vout }
  }

  private esploraFor(why: string): EsploraClient {
    if (!this.esplora) throw new Error(`${why} (set lnd.esploraUrl)`)
    return this.esplora
  }

  /**
   * Esplora-backed, NOT `getChainTransactions`: that reports a per-TRANSACTION `tokens` total (amount plus fee),
   * never the per-output value `whenQuoted` matches exactly, and lists only the LND wallet's own transactions,
   * while here the CLIENT funds the HTLC. The tip height still comes from LND, so there is one chain-tip source.
   */
  async findOutputs(params: { address: string }): Promise<FundedOnchainOutput[]> {
    const esplora = this.esploraFor(
      'onchain receive needs an Esplora URL: LND alone cannot see third-party funding or per-output values',
    )
    const [txs, info] = await Promise.all([esplora.getAddressTxs(params.address), getWalletInfo({ lnd: this.lnd })])
    return toFundedOutputs(txs, params.address, info.current_block_height)
  }

  /**
   * Read through ESPLORA, not lnd's spend subscription: lnd never dispatches a MEMPOOL spend (measured on regtest),
   * and fires nothing for an unspent output, so "no event" cannot tell unspent from not-yet-seen — and null here
   * makes `whenRefundingOnchain` refund an HTLC whose preimage may already be public. Esplora answers both in one
   * request, including an unconfirmed spend, so the preimage arrives when the client broadcasts.
   */
  async findSpendWitness(params: {
    txid: string
    vout: number
    outputScript: Uint8Array
  }): Promise<Uint8Array[] | null> {
    const esplora = this.esploraFor(
      'onchain spend lookup needs an Esplora URL: lnd dispatches spends only on confirmation, and never for ' +
        'a third-party output it does not own',
    )
    // Two shapes in the wild, and this has to work against both.
    //
    // A real Esplora serves `/tx/:txid/outspend/:vout` and names the spender
    // (`txid`, `vin`) — everything needed to fetch the witness. The
    // mempool.space deployments this runs against 404 that path with HTML, and
    // their plural `/tx/:txid/outspends` answers `{"spent": true}` and nothing
    // more. Both measured on the regtest stack.
    const spender = await spenderOf(esplora, params.txid, params.vout, params.outputScript)
    if (spender === 'unspent') return null
    if (spender === 'spent-by-unknown') {
      // Esplora knows it is spent but will not name the spender. lnd WILL — it
      // hands back the whole raw spending transaction — but only once that
      // spend is confirmed, and only by pushing it at a subscription. So ask,
      // briefly: a confirmed spend answers in milliseconds (measured: 32ms),
      // and a mempool-only one answers never, which is the case below.
      const { current_block_height } = await getWalletInfo({ lnd: this.lnd })
      const fundingStatus = (await esplora.getJson(`/tx/${params.txid}/status`)) as
        { confirmed: false } | { confirmed: true; block_height: number }
      // Never 0: the vendor falsy-checks `min_height` and throws.
      const minHeight = fundingStatus.confirmed ? fundingStatus.block_height : current_block_height
      const viaLnd = await this.witnessFromLndSpend(params, minHeight)
      if (viaLnd) return viaLnd
      // SPENT, and this chain API will not say by what. Emphatically NOT null:
      // the caller reads null as "nobody has taken this output" and
      // `whenRefundingOnchain` acts on it by broadcasting the solver's refund.
      // Something already spent it — refunding now is a double-spend at best,
      // and at worst it is the case that branch's comment describes, where the
      // client's claim has already made the preimage public and we walk past it.
      throw new Error(
        `${params.txid}:${params.vout} is already spent, but this chain API does not name the spending ` +
          'transaction, so its witness (and any preimage in it) cannot be read',
      )
    }
    const rawTx = (await esplora.getText(`/tx/${spender.txid}/hex`)).trim()
    return witnessFromRawTx(rawTx, spender.vin)
  }

  /**
   * The spending witness according to lnd, or null if it will not say.
   *
   * lnd's spend subscription is the only source here that hands back the whole
   * raw spending transaction, which is what makes the preimage readable — the
   * mempool.space deployments answer `{"spent": true}` and nothing else. Its
   * limits are the mirror image: it never fires for an unspent output, and
   * never for a spend that is only in the mempool (both measured on regtest).
   *
   * So it is asked ONLY once Esplora has already established that the output is
   * spent. That turns "no event" from an ambiguity into a fact — the spend
   * exists and is not yet confirmed — and null here says exactly that.
   */
  private async witnessFromLndSpend(
    params: {
      txid: string
      vout: number
      outputScript: Uint8Array
    },
    minHeight: number,
  ): Promise<Uint8Array[] | null> {
    return new Promise((resolve, reject) => {
      const sub = subscribeToChainSpend({
        lnd: this.lnd,
        transaction_id: params.txid,
        transaction_vout: params.vout,
        output_script: hex.encode(params.outputScript),
        min_height: minHeight,
      })
      const timer = setTimeout(() => {
        sub.removeAllListeners()
        resolve(null)
      }, SPEND_LOOKUP_TIMEOUT_MS)
      sub.once('confirmation', (event: { transaction: string; vin: number }) => {
        clearTimeout(timer)
        sub.removeAllListeners()
        resolve(witnessFromRawTx(event.transaction, event.vin))
      })
      sub.once('error', (error: Error) => {
        clearTimeout(timer)
        sub.removeAllListeners()
        reject(error)
      })
    })
  }

  async broadcastRaw(txHex: string): Promise<{ txid: string }> {
    const result = await broadcastChainTransaction({ lnd: this.lnd, transaction: txHex })
    return { txid: result.id }
  }

  /** NOT `getChainTransactions`: an HTLC spend is not lnd's own, so it lists none of them. */
  async transactionOutcome(txid: string): Promise<OnchainTxOutcome> {
    const esplora = this.esploraFor(
      'onchain transaction lookup needs an Esplora URL: lnd lists only its own wallet transactions, so it cannot ' +
        'say whether a spend of a third-party output landed',
    )
    return txOutcomeVia(esplora, txid)
  }

  async estimateFeeRate(): Promise<number> {
    const estimate = await getChainFeeRate({ lnd: this.lnd })
    return estimate.tokens_per_vbyte
  }

  async getBalance(): Promise<OnchainBalance> {
    // Two calls because LND separates them: `chain_balance` is confirmed,
    // `pending_chain_balance` is everything not yet confirmed. Neither alone
    // answers "can this corridor fund a swap".
    const [confirmed, pending] = await Promise.all([
      getChainBalance({ lnd: this.lnd }),
      getPendingChainBalance({ lnd: this.lnd }),
    ])
    return {
      confirmedSats: confirmed.chain_balance,
      unconfirmedSats: pending.pending_chain_balance,
    }
  }

  /**
   * LND's own `newAddress` RPC, so the reclaimed funds land back in the very
   * wallet `sendToChainAddress` funded the HTLC out of. The default format
   * (`p2wpkh`) is left alone: nothing here needs taproot, and asking for it
   * costs an extra `listAccounts` round-trip plus a hard failure on LND 0.14.5
   * and below, which have no p2tr support.
   */
  async newReceiveAddress(): Promise<string> {
    const { address } = await createChainAddress({ lnd: this.lnd })
    return address
  }

  /** `this.lnd` is one raw gRPC client per LND subservice — close every one. */
  async close(): Promise<void> {
    for (const client of Object.values(this.lnd)) {
      ;(client as { close?: () => void })?.close?.()
    }
  }
}
