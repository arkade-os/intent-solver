/**
 * The row shape that describes an Arkade covenant, and how to rebuild the
 * script from it.
 *
 * Lives here because it is ARKADE's shape: every field is a parameter of the
 * covenant script — the two pubkeys, the preimage hash, the locktime, the three
 * CSV delays, the pinned destinations. It sat in `send/orchestrator.ts` only
 * because that is where the first consumer happened to be, and that placement
 * is what forced `src/arkade/` to import the corridor layer to rebuild its own
 * scripts.
 *
 * A corridor may import this freely: corridors depend on arkade, not the
 * reverse.
 */
import { hex } from '@scure/base'
import { scriptHashFromPaymentHash } from '@arkade-os/solver-core/core/preimage.js'
import { CovenantSwapScript, parseAssetId } from './covenant.js'
/**
 * The structural subset of a swap row `covenantScriptFromRow`
 * (`src/send/arkadeOps.ts`) needs to rebuild the Arkade-side covenant
 * script. `SendSwapRow` (this leg) satisfies it under these exact field
 * names already; `src/send/onchainOrchestrator.ts` maps its own row's
 * differently-named fields (`providerPubkey` -> `receiverPubkey`) onto this
 * shape explicitly at the call site, rather than relying on field-name
 * coincidence or an unsafe cast.
 */
export interface CovenantScriptRow {
  id: string
  receiverPubkey: string
  serverPubkey: string
  paymentHash: string
  refundLocktime: number
  claimDelay: number
  /** Null on legacy rows — `covenantScriptFromRow` throws on null, same as it already did against `SendSwapRow`. */
  emulatorPubkey: string | null
  refundPkScript: string | null
  pkScript: string
  /** Null for rows with no client-unilateral refund leaf — the pre-existing three-leaf script. */
  clientRefundPubkey: string | null
  /**
   * The CSV delay for the client-unilateral leaf, used only when
   * `clientRefundPubkey` is non-null. Named to match the field both
   * `SendSwapRow` and `OnchainSendSwapRow` already carry under this exact
   * name — no separate mapping needed at either call site.
   */
  refundWithoutReceiverDelay: number
  /**
   * CSV delay for `refundWithoutServer`, used only when `clientRefundPubkey`
   * is non-null. Named to match the field both rows already carry under this
   * exact name (the pre-existing `refundDelay`/`refund_delay` column) — same
   * no-separate-mapping reasoning as `refundWithoutReceiverDelay` above.
   */
  refundDelay: number
  /** Null for rows with no client-unilateral refund leaf — same gating as `clientRefundPubkey`. */
  receiverPkScript: string | null
  /**
   * The 68-hex Asset ID this lockup is denominated in; absent or null for sats.
   *
   * OPTIONAL so every existing corridor's row satisfies this shape unchanged,
   * and absent means what it meant before: a BTC covenant.
   *
   * Load-bearing on an asset lockup. The asset is a parameter of the script, so
   * rebuilding one WITHOUT it derives the BTC pkScript — a different address
   * from the one that was funded. Silent at rebuild time and total at spend
   * time: the lockup is then neither claimable nor refundable, because the only
   * script that can spend it is the one nobody can reproduce.
   *
   * CANONICAL order, as the wire and the registry carry it. `VHTLC.ScriptV2`
   * does the reversal `OP_INSPECTOUTASSETLOOKUP` wants; pre-reversed bytes fail
   * the covenant as a bare `OP_VERIFY failed`.
   */
  assetId?: string | null
  /**
   * Which covenant-suite shape this row's lockup was funded with — see
   * `CovenantSwapParams.nonInteractiveParameters`'s `legacy` selector. `true` is the
   * current suite (nine leaves, with the timelocked non-interactive refund
   * leaf); null is a row quoted before that leaf existed, and unlike
   * `clientRefundPubkey`, null here is not a refusal, it is an ANSWER:
   * rebuild the pre-timelocked-refund eight-leaf shape, exactly as funded. A
   * row created after the leaf shipped always carries `true` — nothing quotes
   * `false` going forward, and the encoder does not actually distinguish the
   * two if something did: an explicit `false` and an omitted value both
   * persist as `NULL` (see `SwapStore.insertQuote`), read back here as `null`
   * either way. That is fine — every read path already treats `null` and
   * `false` identically (the legacy selector) — but it means this column
   * cannot answer "opted out" versus "predates the feature" if that
   * distinction ever mattered; today nothing asks it to.
   */
  nonInteractiveParameters: boolean | null
}

/**
 * Reject a row that does not carry the fields `covenantScriptFromRow` reads.
 *
 * `CorridorReader.liveLockups` returns `readonly unknown[]` on purpose, so
 * `@arkade-os/solver-core` need not name this type. Something has to narrow that, and a
 * bare cast is the wrong instrument: a plugged-in corridor is third-party code,
 * and a row with a missing or mistyped field would be ACCEPTED by the cast and
 * carried into `covenantScriptFromRow`, which builds a script from whatever it
 * was handed.
 *
 * A wrong script is not a display fault. It registers the wrong contract, so
 * the real lockup is invisible to `getVtxos`/`getSpendableVtxos` — losing the
 * renewal protection and the recovery path for coins that exist. Failing at the
 * source names the corridor that produced it; failing downstream names neither.
 *
 * Nullable fields are checked for PRESENCE and type, not for non-null:
 * `emulatorPubkey`, `refundPkScript`, `clientRefundPubkey` and
 * `receiverPkScript` are legitimately null, and `covenantScriptFromRow` already
 * throws on the ones it cannot use.
 */
export const assertCovenantScriptRow = (row: unknown, source: string): CovenantScriptRow => {
  if (typeof row !== 'object' || row === null) {
    throw new Error(`${source} supplied a live lockup that is not an object: ${typeof row}`)
  }
  const candidate = row as Record<string, unknown>
  const strings = ['id', 'receiverPubkey', 'serverPubkey', 'paymentHash', 'pkScript'] as const
  const numbers = ['refundLocktime', 'claimDelay', 'refundWithoutReceiverDelay', 'refundDelay'] as const
  const nullableStrings = ['emulatorPubkey', 'refundPkScript', 'clientRefundPubkey', 'receiverPkScript'] as const

  for (const field of strings) {
    if (typeof candidate[field] !== 'string') {
      throw new Error(`${source} supplied a live lockup whose ${field} is ${typeof candidate[field]}, not a string`)
    }
  }
  for (const field of numbers) {
    const value = candidate[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // `String` for numbers, `JSON.stringify` for everything else. The obvious
      // one-liner is stringify alone, but it renders NaN and Infinity as
      // `null` — and those are the two failures a number check most often
      // catches, so it would name the wrong fault in exactly the case it
      // exists to report. `String` shows them as themselves; stringify keeps
      // the quotes that distinguish the string "5" from the number 5.
      const shown = typeof value === 'number' ? String(value) : JSON.stringify(value)
      throw new Error(`${source} supplied a live lockup whose ${field} is ${shown}, not a finite number`)
    }
  }
  for (const field of nullableStrings) {
    const value = candidate[field]
    if (value !== null && typeof value !== 'string') {
      throw new Error(`${source} supplied a live lockup whose ${field} is ${typeof value}, not a string or null`)
    }
  }
  // Presence matters here in a way it does not for the nullable strings: this
  // field SELECTS a script shape rather than merely being read, and an absent
  // one is indistinguishable from `null` at the use site — so a corridor that
  // omitted it would silently rebuild the pre-timelocked-refund suite and sign
  // against an address the lockup was never funded to.
  if (!('nonInteractiveParameters' in candidate)) {
    throw new Error(`${source} supplied a live lockup with no nonInteractiveParameters field`)
  }
  const suite = candidate.nonInteractiveParameters
  if (suite !== null && typeof suite !== 'boolean') {
    throw new Error(
      `${source} supplied a live lockup whose nonInteractiveParameters is ${typeof suite}, not a boolean or null`,
    )
  }
  return candidate as unknown as CovenantScriptRow
}

/** Rebuild the exact covenant script a row's lockup was funded against. */
export const covenantScriptFromRow = (row: CovenantScriptRow): CovenantSwapScript => {
  if (!row.refundPkScript || !row.emulatorPubkey) {
    throw new Error(`swap ${row.id} is not a covenant swap: missing refund destination or emulator key`)
  }
  // A null client key used to select the base three-leaf script. That shape is
  // gone, so this REFUSES rather than silently building something else: getting
  // a different script than the lockup was funded against is how a refund is
  // signed against the wrong address. The columns stay nullable because rows
  // predating the extended shape are still on disk; none of them is live, and
  // if one ever reaches here it must stop loudly and name itself.
  if (row.clientRefundPubkey === null || row.receiverPkScript === null) {
    throw new Error(
      `swap ${row.id} predates the client-unilateral refund leaf and cannot be rebuilt: ` +
        'its lockup was funded against the retired three-leaf script',
    )
  }
  return new CovenantSwapScript({
    receiver: hex.decode(row.receiverPubkey),
    server: hex.decode(row.serverPubkey),
    preimageHash: scriptHashFromPaymentHash(row.paymentHash),
    refundLocktime: row.refundLocktime,
    claimDelay: row.claimDelay,
    client: hex.decode(row.clientRefundPubkey),
    clientRefundDelay: row.refundWithoutReceiverDelay,
    refundWithoutServerDelay: row.refundDelay,
    // CANONICAL, never pre-reversed — @see CovenantScriptRow.assetId. Omitted
    // entirely for a sats row, which is the BTC covenant every other corridor
    // builds today.
    ...(row.assetId ? { asset: parseAssetId(row.assetId) } : {}),
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(row.emulatorPubkey),
      receiverPkScript: hex.decode(row.receiverPkScript),
      senderPkScript: hex.decode(row.refundPkScript),
      // What the row says, not what today's code would choose: null (a row
      // that predates the current suite shape) means "rebuild the
      // pre-timelocked-refund shape", exactly the shape that row was actually
      // funded against. See `NonInteractiveParameters.legacy`'s doc comment.
      ...(row.nonInteractiveParameters ? {} : { legacy: 'preTimelockedRefund' as const }),
    },
  })
}
