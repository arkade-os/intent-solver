/**
 * The onchain (Bitcoin L1) backend port.
 *
 * Same rule as `src/ln/port.ts`: nothing ABOVE this port may import a vendor SDK
 * (`lightning`, a wallet SDK, or a raw `fetch`-based Esplora call) for onchain
 * concerns. Below it, the adapter layer is the subdirectories of `src/onchain/`
 * — plus, where one backend serves the Lightning and onchain sides off a SINGLE
 * connection, whatever module owns that shared connection, which belongs to
 * neither subtree. Types here are plain — hex strings, sats, unix seconds — so
 * no vendor type escapes the adapter boundary.
 *
 * NOT segregated the way `SendBackend`/`ReceiveBackend` are in `src/ln/port.ts`.
 * Lightning's two directions hit genuinely disjoint node RPCs (pay an invoice
 * vs. hold-and-settle one), so a zero-overlap split costs nothing. Onchain's
 * two directions are both just "the solver's own wallet, watching addresses
 * and broadcasting transactions it built" — `fund()` (pay an address) is the
 * ONLY primitive send needs that receive does not, and every existing adapter
 * already implements everything else off the SAME underlying client. Splitting
 * cleanly would force every adapter to either duplicate
 * `findOutputs`/`findSpendWitness`/`broadcastRaw`/
 * `estimateFeeRate`/`newReceiveAddress`/`settleReceiveAddress`/`close` across
 * two interfaces or implement an intersection type — strictly more surface for
 * the same behaviour. So: one shared base, `OnchainSendBackend` adds the one
 * send-only method, `OnchainReceiveBackend` adds none today (kept as its own
 * name rather than a bare alias of the base, so a future receive-only method
 * has somewhere to land without a breaking rename).
 */

export interface FundedOnchainOutput {
  txid: string
  vout: number
  valueSats: number
  /** 0 while unconfirmed. */
  confirmations: number
}

/** What the onchain wallet holds. Both figures are sats. */
export interface OnchainBalance {
  confirmedSats: number
  unconfirmedSats: number
  /**
   * True when these sats are the SAME pool the Lightning backend reports, not a
   * second one beside it.
   *
   * A backend may keep no separate onchain wallet at all: there `fund()` pays by
   * whatever exit its SDK offers, out of the one balance its Lightning adapter
   * ALSO reports as liquidity. The figure is real and spendable — it is what
   * decides whether this corridor can honour a quote — but an operator reading
   * two rows and adding them would believe they hold twice what they do.
   *
   * Optional because it is a fact about ONE backend family. LND really does
   * keep its own wallet, and a required flag would make every adapter answer a
   * question only the single-balance backends have.
   */
  sharedWithLightning?: boolean
}

/**
 * What became of ONE deposit sitting at {@link OnchainSendBackend.newReceiveAddress} —
 * the per-deposit outcome of {@link OnchainSendBackend.settleReceiveAddress}.
 *
 * An outcome, never a throw, and reported one deposit at a time: a settlement
 * is not a refund. By the time any of this runs the refund broadcast has
 * already succeeded and its txid is recorded on the row, so a deposit that
 * fails to settle must not be readable as a refund that failed — and one
 * failure must not hide the deposits either side of it.
 */
export type ReceiveSettlement =
  /** `reference` is the backend's own id for the credit — a transfer id, typically. */
  | { settled: true; txid: string; vout: number; reference: string }
  /** Not settled, and the deposit is untouched — the next sweep re-lists and retries it. */
  | { settled: false; txid: string; vout: number; reason: string }

/**
 * The shared surface: watch an address, watch for a spend, broadcast a
 * transaction this service built, estimate fees, and get money that landed
 * back into spendable balance. Every one of these is needed by BOTH
 * directions — see this file's header comment for why the port is not split
 * the way `src/ln/port.ts` is.
 */
export interface OnchainBackend {
  /** Outputs currently paying `address`, most useful while exactly one is expected. */
  findOutputs(params: { address: string }): Promise<FundedOnchainOutput[]>

  /**
   * The witness stack of whichever input spends `(txid, vout)`, or null if
   * nothing has spent it yet. The claim witness's preimage push is how the
   * solver learns `P` after the client claims the onchain HTLC.
   *
   * `null` MUST mean "definitively unspent", never "could not find out". Every
   * caller reads it as the former, and `whenRefundingOnchain` acts on it by
   * broadcasting the solver's own refund — so an implementation that returns
   * null when it simply failed to answer sends the solver to refund an HTLC the
   * client may already have claimed. THROW instead: the tick fails, the row
   * stays non-terminal, and the next sweep asks again.
   *
   * MEMPOOL SPENDS COUNT. The preimage is public the moment the client's claim
   * is broadcast, and waiting for a block to learn it wastes the window the
   * solver has to claim the Arkade side. The Esplora-backed adapters get this
   * for free — `outspend.spent` is true for an unconfirmed spend and they do
   * not filter on `status.confirmed`.
   *
   * `outputScript` is the spent output's own scriptPubKey. Esplora-backed
   * adapters don't need it — outspend lookup is by txid/vout alone — but LND's
   * chain notifier has no "arbitrary outpoint" query; watching a
   * THIRD-PARTY output (one the wallet doesn't own, which the HTLC's output
   * always is once funded) requires the script up front.
   */
  findSpendWitness(params: { txid: string; vout: number; outputScript: Uint8Array }): Promise<Uint8Array[] | null>

  /** Broadcast an already-signed raw transaction — used for the solver's own refund spend. */
  broadcastRaw(txHex: string): Promise<{ txid: string }>

  /** Current sats/vbyte fee estimate for a transaction the solver constructs itself. */
  estimateFeeRate(): Promise<number>

  /**
   * The spendable balance of the wallet this backend funds from.
   *
   * Read by the console so an operator can see whether the onchain corridor
   * can honour what it advertises. `estimateFeeRate` alone says the backend
   * answered, not that it has anything to spend.
   */
  getBalance(): Promise<OnchainBalance>

  /**
   * A receive address THIS backend's own wallet controls — where the solver's
   * reclaimed HTLC funds land when `whenRefundingOnchain` spends the refund
   * leaf.
   *
   * It has to come from the same wallet `fund()` pays out of, so that reclaimed
   * money returns to where it started and is immediately reusable for the next
   * HTLC. Any other destination (an Arkade boarding address, say) detours the
   * solver's own onchain liquidity through a second system it then has to
   * unwind before it can fund anything again.
   *
   * A plain address string, matching `fund()`'s own `address`, rather than a
   * pkScript: turning one into a script needs the network profile, which lives
   * in config (`ONCHAIN_NETWORKS[config.network]`) rather than in every
   * adapter — and decoding it there also fails loudly if a backend is pointed
   * at the wrong network.
   */
  newReceiveAddress(): Promise<string>

  /**
   * Turn whatever has landed at {@link newReceiveAddress} into balance this
   * backend can actually spend, and report each deposit's outcome.
   *
   * Optional for the same reason {@link close} is — it exists for the backends
   * that need it, and LND is not one of them. LND hands out an ordinary wallet
   * address, so a refund paying it is spendable the moment it confirms and
   * there is nothing to settle. A backend whose receive address is instead a
   * DEPOSIT address — one held jointly with its operators, where arriving sats
   * are not backend balance until explicitly claimed — does need it; without
   * this, every solver refund on such a deployment strands as an L1 UTXO a
   * human has to claim by hand.
   *
   * SWEEP-SHAPED — no arguments, and it settles everything it finds — rather
   * than "settle the deposit this refund just made", because the step cannot
   * run when the refund is broadcast. A deposit is claimable only once it has
   * CONFIRMED and the backend's own watcher has credited it, which is minutes
   * to an hour after `broadcastRaw` returns. Driving it on the refund sweep's
   * cadence is what makes the retry free: each pass re-lists whatever is still
   * unsettled, so a deposit that fails one pass is picked up by the next, and
   * no per-refund progress has to be persisted to make that work.
   *
   * That is also why it is NOT folded into `broadcastRaw`. Doing the claim
   * there would either block a broadcast for the length of a confirmation —
   * turning a refund that genuinely went out into one the caller never records
   * — or fire an unawaited promise whose failure nobody sees. `broadcastRaw`
   * broadcasts; this settles; neither backend's contract bends to the other's.
   */
  settleReceiveAddress?(): Promise<ReceiveSettlement[]>

  /**
   * Release any long-lived connection. Optional — see the identical note on
   * {@link import('../ln/port.js').SendBackend.close}; the LND adapter is the
   * one implementation that needs it.
   */
  close?(): Promise<void>
}

export interface OnchainSendBackend extends OnchainBackend {
  /**
   * Pay `amountSats` to `address` — funds the client's HTLC. `vout` is the
   * index `address` actually landed at: a wallet-funded transaction may
   * carry a change output, and nothing guarantees the payment output comes
   * first — callers (claim detection, the claim spend itself) MUST use the
   * returned `vout`, never assume 0.
   *
   * `idempotencyKey` is a stable per-swap key, exactly like the Lightning
   * port's, and it exists for the same reason: this call can be re-driven after
   * a crash, and a blind resubmit pays the same HTLC twice out of the solver's
   * own pocket. Required rather than optional so a caller that forgets it fails
   * to compile instead of quietly funding twice.
   *
   * A backend that cannot honour it is still permitted — LND's
   * `sendToChainAddress` takes no such key — but must say so where it drops it,
   * because the funding recovery path's safety then rests on its chain query
   * alone.
   */
  fund(params: { address: string; amountSats: number; idempotencyKey: string }): Promise<{
    txid: string
    vout: number
  }>
}

/**
 * The receive leg's view of the backend. Structurally identical to
 * {@link OnchainBackend} today — the receive orchestrator never pays an
 * address itself (the CLIENT funds the onchain HTLC, out of band; the solver
 * only ever watches it, then later claims it) — but kept as its own named
 * interface rather than a bare re-export, both for call-site clarity (a
 * receive-only dependency should say so) and so a future receive-only method
 * has somewhere to land without a breaking rename.
 */
export interface OnchainReceiveBackend extends OnchainBackend {}
