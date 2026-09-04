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
  getChainBalance,
  getChainFeeRate,
  getChainTransactions,
  getPendingChainBalance,
  getWalletInfo,
  sendToChainAddress,
  subscribeToChainSpend,
  type AuthenticatedLnd,
} from 'lightning'
import { hex } from '@scure/base'
import { toFundedOutputs, txOutcomeVia, witnessFromRawTx } from '@arkade-os/solver-rails-esplora/esplora.js'
import {
  createEsploraClient,
  type EsploraAuth,
  type EsploraClient,
  spenderOf,
} from '@arkade-os/solver-rails-esplora/esplora.js'
import type {
  FundedOnchainOutput,
  OnchainBalance,
  OnchainReceiveBackend,
  OnchainSendBackend,
  OnchainTxOutcome,
} from '@arkade-os/solver-core/ports/onchain.js'

interface LndChainTx {
  id: string
  confirmation_count?: number
  output_addresses: string[]
  tokens: number
}

export interface AdapterConfig {
  socket: string
  cert: string
  macaroon: string
  /**
   * Esplora base URL. Required for the RECEIVE corridor only — see
   * {@link LndOnchainAdapter.findOutputs} for why LND's own chain view cannot
   * answer that question. The send corridor never calls it.
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

  static async create(config: AdapterConfig): Promise<LndOnchainAdapter> {
    const { lnd } = authenticatedLndGrpc(config)
    // Round-trip once so a bad cert/macaroon/socket fails here, at boot,
    // same rule as the Lightning LND adapter.
    await getWalletInfo({ lnd })
    const esplora = config.esploraUrl ? createEsploraClient(config.esploraUrl, config.esploraAuth) : undefined
    return new LndOnchainAdapter(lnd, esplora)
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
    return { txid: result.id, vout }
  }

  /**
   * Esplora-backed, NOT `getChainTransactions`. Two defects made the LND chain
   * view unusable here, both surfaced by the receive corridor's first real run
   * against a live regtest stack (2026-08-07) and both harmless on the SEND
   * corridor, which is why they survived: there `fund()` locates its vout by
   * ADDRESS and never reads `valueSats`, and the funding transaction is always
   * the solver's own.
   *
   *  1. `getChainTransactions` reports a per-TRANSACTION `tokens` total and no
   *     per-output values at all. Confirmed against boltz-lnd: a 50 000-sat
   *     payment to an HTLC address reports `tokens: 50156` — amount plus its
   *     156-sat fee. `receive/onchainOrchestrator.ts`'s `whenQuoted` matches
   *     `valueSats === row.amountSats` exactly (deliberately, so a partial or
   *     dust payment is never adopted as funding), so it could never match and
   *     the swap sat in `quoted` until it timed out. This was not fixable in
   *     place: the value simply is not in that response.
   *  2. It returns only the LND WALLET's own transactions. On this corridor the
   *     CLIENT funds the HTLC, so in production that is a third party's
   *     transaction and was invisible entirely — fixing (1) alone would not
   *     have made the corridor work.
   *
   * Esplora answers both: address history is not wallet-scoped, and it carries
   * real per-output values. `toFundedOutputs` is reused verbatim from the
   * shared Esplora helpers rather than reimplemented — same mapping, already
   * proven on another backend. The tip height comes from LND itself, so this adds no
   * second source of truth for the chain tip.
   */
  async findOutputs(params: { address: string }): Promise<FundedOnchainOutput[]> {
    if (!this.esplora) {
      throw new Error(
        'onchain receive needs an Esplora URL: LND alone cannot see third-party funding or per-output values (set lnd.esploraUrl)',
      )
    }
    const [txs, info] = await Promise.all([
      this.esplora.getAddressTxs(params.address),
      getWalletInfo({ lnd: this.lnd }),
    ])
    return toFundedOutputs(txs, params.address, info.current_block_height)
  }

  /**
   * `registerSpendNtfn` (wrapped as `subscribeToChainSpend`) is LND's only way
   * to watch an arbitrary, non-wallet-owned outpoint — the HTLC output is
   * exactly that, from the moment `fund()` pays it out. It's a push
   * subscription, not a one-shot query, so this adapts it to the port's poll
   * shape: subscribe, wait briefly for a `'confirmation'` (which the notifier
   * replays from `min_height` if the spend already happened, not just future
   * ones), then tear down either way — the orchestrator's own tick loop
   * (`whenAwaitingClaim`) is the real poll; this call only answers "as of
   * right now". `min_height: 1` rescans (almost) the whole chain on every
   * call, cheap on regtest's short history; a mainnet deployment would want
   * the funding height here instead to bound the rescan. NOT 0: the
   * underlying call falsy-checks `min_height` and throws
   * `ExpectedMinHeightToSubscribeToChainSpend` for it, rejecting silently
   * inside the Promise executor on every single attempt.
   */
  /**
   * Read through ESPLORA, not through lnd.
   *
   * The first version subscribed with `subscribeToChainSpend` and treated a
   * five-second silence as "unspent". Both halves of that are wrong, and an
   * e2e against a regtest node is what showed it:
   *
   *   spend sitting in the mempool, watched 60s -> NO EVENT AT ALL
   *   the same outpoint, after one block         -> event in 32ms
   *
   * So lnd is confirmation-only for spends — not slow, it never dispatches a
   * mempool spend. That made the old `resolve(null)` a lie in the one direction
   * that costs money: `whenRefundingOnchain` reads null as UNSPENT and
   * broadcasts the solver's refund against an HTLC the client has already
   * claimed and whose preimage is already public.
   *
   * And a subscription cannot answer the ordinary question either. Nothing
   * fires for an output that is simply unspent, so "no event" is the normal
   * case as well as the failure case — a timeout can only ever guess between
   * them. Rejecting instead of guessing broke the polling path, which is how
   * this got caught.
   *
   * Esplora answers both definitively, in one request, including mempool
   * spends — `outspend.spent` is true for an unconfirmed spend, which is how
   * the preimage reaches us the moment the client broadcasts rather than a
   * block later. Same call every Esplora-backed adapter makes, so the backends
   * all satisfy the port's contract identically.
   *
   * Requiring Esplora here is not a new dependency: `findOutputs` already
   * refuses without it, for the same underlying reason — an HTLC is a
   * THIRD-PARTY output, and lnd cannot see those on its own.
   */
  async findSpendWitness(params: {
    txid: string
    vout: number
    outputScript: Uint8Array
  }): Promise<Uint8Array[] | null> {
    if (!this.esplora) {
      throw new Error(
        'onchain spend lookup needs an Esplora URL: lnd dispatches spends only on confirmation, and never for ' +
          'a third-party output it does not own (set lnd.esploraUrl)',
      )
    }
    // Two shapes in the wild, and this has to work against both.
    //
    // A real Esplora serves `/tx/:txid/outspend/:vout` and names the spender
    // (`txid`, `vin`) — everything needed to fetch the witness. The
    // mempool.space deployments this runs against 404 that path with HTML, and
    // their plural `/tx/:txid/outspends` answers `{"spent": true}` and nothing
    // more. Both measured on the regtest stack.
    const spender = await spenderOf(this.esplora, params.txid, params.vout, params.outputScript)
    if (spender === 'unspent') return null
    if (spender === 'spent-by-unknown') {
      // Esplora knows it is spent but will not name the spender. lnd WILL — it
      // hands back the whole raw spending transaction — but only once that
      // spend is confirmed, and only by pushing it at a subscription. So ask,
      // briefly: a confirmed spend answers in milliseconds (measured: 32ms),
      // and a mempool-only one answers never, which is the case below.
      const viaLnd = await this.witnessFromLndSpend(params)
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
    const rawTx = (await this.esplora.getText(`/tx/${spender.txid}/hex`)).trim()
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
  private async witnessFromLndSpend(params: {
    txid: string
    vout: number
    outputScript: Uint8Array
  }): Promise<Uint8Array[] | null> {
    return new Promise((resolve, reject) => {
      const sub = subscribeToChainSpend({
        lnd: this.lnd,
        transaction_id: params.txid,
        transaction_vout: params.vout,
        output_script: hex.encode(params.outputScript),
        min_height: 1,
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
    if (!this.esplora) {
      throw new Error(
        'onchain transaction lookup needs an Esplora URL: lnd lists only its own wallet transactions, so it cannot ' +
          'say whether a spend of a third-party output landed (set lnd.esploraUrl)',
      )
    }
    return txOutcomeVia(this.esplora, txid)
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
