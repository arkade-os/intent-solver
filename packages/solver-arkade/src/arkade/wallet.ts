/**
 * Arkade wallet construction and the swap-script spends both legs need.
 *
 * Storage is SQLite and is not optional. The SDK defaults to IndexedDB, which
 * does not exist under Node — a wallet built without an explicit repository
 * fails at its first state read. Persistence also has to survive restarts for a
 * second reason: a swap that has paid its invoice but not yet claimed is money we
 * are owed, and losing that row loses the claim.
 */

import Database from 'better-sqlite3'
import {
  ArkAddress,
  assertSubmittedArkTxid,
  buildOffchainTx,
  ConditionWitness,
  EmulatorPacket,
  EsploraProvider,
  Extension,
  getArkPsbtFields,
  hasTerminalSpend,
  matchServerCheckpoints,
  MnemonicIdentity,
  PrevArkTxField,
  RestEmulatorProvider,
  setArkPsbtField,
  Transaction,
  Wallet,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { SQLiteContractRepository, SQLiteWalletRepository, type SQLExecutor } from '@arkade-os/sdk/repositories/sqlite'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { deriveUnilateralDelays, type UnilateralDelays } from '@arkade-os/solver-core/core/timelocks.js'
import { log } from '@arkade-os/solver-core/util/poll.js'
import { ensureDatabaseDir } from '@arkade-os/solver-core/util/sqlite.js'
import { claimIdentity } from './claimIdentity.js'
import type { CovenantSwapScript } from './covenant.js'
import { createReservationLedger, type ReservationLedger } from './reservations.js'

/** The two views any spend below needs; CovenantSwapScript satisfies it (as would any VtxoScript wrapper). */
export interface ClaimableScript {
  claim(): TapLeafScript
  encode(): Uint8Array
}

export const sqliteExecutor = (path: string): SQLExecutor & { close(): void } => {
  ensureDatabaseDir(path)
  const db = new Database(path)
  // WAL keeps a reader (the funding watcher) from blocking a writer (the swap
  // state machine) while a swap is mid-flight.
  db.pragma('journal_mode = WAL')
  return {
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]))
    },
    get: async (sql, params = []) => db.prepare(sql).get(...(params as never[])) as never,
    all: async (sql, params = []) => db.prepare(sql).all(...(params as never[])) as never,
    // Without this the WAL is never checkpointed. process.exit() skips it, and
    // the sidecar grows to many times the size of the database it fronts.
    close: () => db.close(),
  }
}

export interface ArkadeWalletConfig {
  mnemonic: string
  arkServerUrl: string
  databasePath: string
  isMainnet: boolean
  arkadeHrp: string
  /**
   * Lowers the SDK's minimum accepted checkpoint exit delay, in seconds.
   *
   * Unset leaves the SDK's own per-network floor — 86400 off regtest, 1200 on
   * it — which is what a deployment should want: the floor bounds how long our
   * server-independent recourse takes if the Arkade Service stops cooperating.
   * It exists because a hosted test Service may advertise a far shorter delay
   * for its own convenience (mutinynet advertises 4096), and `Wallet.create`
   * refuses to build against it at all. Config decides when that is allowed.
   */
  minCheckpointExitDelaySeconds?: number
  /**
   * Believe THIS unilateral exit delay instead of the one the server advertises
   * at `/v1/info`, in seconds. Unset means believe the server.
   *
   * It exists because arkd can advertise a delay longer than the minimum it
   * actually enforces, and mainnet does: `/v1/info` reports 605184, which is
   * that server's "Public unilateral exit", while the delay covenant leaves are
   * checked against is its plain "Unilateral exit" of 259584 — 2.33x shorter.
   * The advertised number is not merely cosmetic here:
   * every covenant this solver writes takes its CSV timelocks from it, and
   * `minFinalCltvBlocksFor` sizes the invoice's final CLTV delta against it. At
   * 7 days the Lightning receive corridor asks for 4074 blocks and cannot be
   * served at all; at 3 it asks for 1770 and is served with every gate intact.
   *
   * WHICH DIRECTION IS DANGEROUS, because it is not symmetric. Too HIGH is
   * merely wasteful — the server accepts any script at or above its minimum, so
   * a long delay costs recourse latency and nothing else. Too LOW writes a
   * script the server will REJECT, and it rejects at SPEND, not at funding:
   * `INVALID_VTXO_SCRIPT: exit delay is too short` arrives when there is already
   * money in the script. That is why this is an operator assertion about a
   * specific deployment rather than anything this service can discover, and why
   * it must be confirmed with a real spend at a small amount before it carries
   * real ones. What that confirms is that the SERVER ACCEPTS a script built at
   * this delay — a collaborative claim or refund is enough for that. It does not
   * exercise the CSV leaves, which are reachable only through a unilateral exit
   * that nothing in `src/` performs yet.
   *
   * In-flight swaps are unaffected either way: every corridor snapshots these
   * delays onto its row at quote time and reconstructs funded scripts from the
   * snapshot, so changing this moves new swaps only.
   */
  unilateralExitDelayOverride?: number
  /**
   * Where the SDK reads the Bitcoin chain, as an Esplora REST base URL. Unset
   * takes the SDK's own per-network default.
   *
   * Those defaults name PUBLIC deployments and one of them names `localhost`,
   * which is why this has to be settable. On regtest the SDK falls back to
   * `http://localhost:3000/api`; inside a container that resolves to the
   * container itself, nothing answers, and the wallet degrades QUIETLY —
   * "Failed to fetch chain tip; height-based expiry will not be evaluated" is
   * logged once and the process carries on with block-denominated VTXO expiry
   * simply unwatched. Nothing else reports it.
   *
   * Distinct from the Lightning side's explorer, which the onchain corridors
   * configure separately: this one is the ARKADE wallet's view of L1, and the
   * two can legitimately differ.
   */
  esploraUrl?: string
  /** Network name the server must report at /v1/info — refused at startup otherwise. */
  expectedArkdNetwork: string
}

export interface ArkadeContext {
  wallet: Awaited<ReturnType<typeof Wallet.create>>
  identity: MnemonicIdentity
  /** Unilateral delays this server will accept, derived from its own minimum. */
  unilateralDelays: UnilateralDelays
  /** bech32 prefix for Arkade addresses on this network. */
  hrp: string
  /**
   * Coins an in-flight operation has claimed. One ledger per context, because
   * its whole purpose is to be shared: lockup funding pins what it is about to
   * spend, and the renewal settle skips whatever is pinned. Two ledgers would
   * agree on nothing. @see reservations.ts
   */
  reservations: ReservationLedger
  /** Checkpoint and release the SQLite handle. */
  close(): void
}

export const createArkadeContext = async (config: ArkadeWalletConfig): Promise<ArkadeContext> => {
  const identity = MnemonicIdentity.fromMnemonic(config.mnemonic, { isMainnet: config.isMainnet })
  const executor = sqliteExecutor(config.databasePath)

  const wallet = await Wallet.create({
    identity,
    arkServerUrl: config.arkServerUrl,
    storage: {
      walletRepository: new SQLiteWalletRepository(executor),
      contractRepository: new SQLiteContractRepository(executor),
    },
    // Passing undefined is safe and is NOT the same as passing a hole: the SDK
    // folds this into its policy only when set (`!== void 0`, pinned SDK
    // `dist/chunk-DVOQZAAX.js:12939`), so unset keeps the per-network floor.
    // Spreading it conditionally here would read as more careful and do the
    // same thing; the explicit undefined is what makes that checkable.
    minCheckpointExitDelaySeconds:
      config.minCheckpointExitDelaySeconds === undefined ? undefined : BigInt(config.minCheckpointExitDelaySeconds),
    // Safe for the same reason, by a different operator: the SDK takes
    // `config.onchainProvider || new EsploraProvider(default)` (pinned SDK
    // `dist/chunk-AEWJU6NZ.js:12457`), so an explicit undefined falls through
    // to the per-network default rather than blanking the provider.
    onchainProvider: config.esploraUrl === undefined ? undefined : new EsploraProvider(config.esploraUrl),
    // NOT a performance tweak, and UNSET IS NOT OFF. The SDK folds an absent
    // `settlementConfig` into its DEFAULT (`pollIntervalMs` 60s) and starts a
    // boarding poll that calls `getSpendableVtxos()` — an UNFILTERED
    // `getContractsWithVtxos()`, which syncs every registered contract against
    // the indexer — every minute, forever, whatever this service is doing. That
    // is the one cost `arkade/contractLifecycle.ts` cannot scope, because the
    // snapshot takes no filter and the poll is not ours to pace.
    //
    // It also makes this service the single renewal authority. The SDK's own
    // renewal was running alongside ours outside its `renewalInProgress` mutex,
    // which `vtxoLifecycle.ts` documents and the e2e run prints as
    // INTENT_INSUFFICIENT_FEE against a pass this repo never asked for.
    //
    // WHAT IT COSTS, checked rather than assumed:
    //   - boarding sweep: nothing. This service never boards; the only Arkade
    //     boarding addresses named anywhere in `src/` are ones we avoid.
    //   - deprecated-signer migration: real, so it MOVED rather than went away.
    //     `ops/float.ts` now runs `migrateDeprecatedSignerVtxos()` on the
    //     lifecycle pass. @see arkade/signerMigration.ts
    //
    // The contract event stream is untouched: `settlementConfig` is read only by
    // `VtxoManager` and the `Wallet` that constructs it, never by
    // `ContractManager` or `ContractWatcher`, so `initialize()` still starts the
    // watcher the lockup fast path subscribes to.
    settlementConfig: false,
  })

  // Everything else the swap needs -- the providers, the server key, the unroll
  // script -- the wallet already built and exposes. Only the server's minimum
  // exit delay still has to be fetched.
  const info = await wallet.arkProvider.getInfo()

  // The URL alone does not prove which chain the server is on, and every other
  // network fact (invoice prefix, address HRP, key derivation) came from config.
  // A mismatch means paying this network's invoices to claim vtxos on another
  // chain — refuse to start rather than discover it with money in flight.
  if (info.network !== config.expectedArkdNetwork) {
    throw new Error(
      `Arkade server at ${config.arkServerUrl} reports network '${info.network}', ` +
        `expected '${config.expectedArkdNetwork}' — check ARK_SERVER_URL / SWAP_NETWORK`,
    )
  }

  const advertisedExitDelay = Number(info.unilateralExitDelay)
  // Said out loud rather than applied quietly. This changes the timelocks in
  // every covenant the process writes from here on, so an operator reading a
  // boot log has to be able to see that the scripts do not match what the
  // server claims to require — and to see BOTH numbers, since the whole reason
  // the override exists is that they disagree.
  if (config.unilateralExitDelayOverride !== undefined) {
    log(
      `ARK_UNILATERAL_EXIT_DELAY=${config.unilateralExitDelayOverride}s overrides the ` +
        `${advertisedExitDelay}s this server advertises; every covenant written from now uses the override`,
    )
  }

  return {
    wallet,
    identity,
    unilateralDelays: deriveUnilateralDelays(config.unilateralExitDelayOverride ?? advertisedExitDelay),
    hrp: config.arkadeHrp,
    reservations: createReservationLedger(),
    close: () => executor.close(),
  }
}

/** A confirmed output sitting at a swap script. */
export interface FundedOutput {
  txid: string
  vout: number
  value: number
}

/**
 * Every spendable output locked up at a script.
 *
 * All of them, not the first: a client may fund a lockup in more than one send,
 * and a gate that reads only `vtxos[0]` refuses a fully funded swap — or worse,
 * claims part of the money and strands the rest at the script. The same goes
 * for PAGES: the indexer paginates, and a truncated first page undercounts the
 * lockup the exact-amount gate compares against, so every page is walked. An
 * empty page is the hard stop that keeps a misbehaving server from spinning the
 * loop; `page.total` alone is trusted only as far as results keep arriving.
 *
 * This read is the AUTHORITY on whether a lockup exists, and the failsafe that
 * finds one no matter what else fails — a poll cannot silently die and leave a
 * swap waiting forever. {@link LockupWatcher} sits in front of it purely to cut
 * latency: it subscribes to the same scripts and nudges the orchestrator to tick
 * sooner, and every tick still lands here before anything is believed. So this
 * being a poll is deliberate and unchanged by the subscription; what the
 * subscription removed is the wait, not the check.
 */
export const findLockups = async (ctx: ArkadeContext, pkScriptHex: string): Promise<FundedOutput[]> => {
  const outputs: FundedOutput[] = []
  let pageIndex = 0
  for (;;) {
    const { vtxos, page } = await ctx.wallet.indexerProvider.getVtxos({
      scripts: [pkScriptHex],
      spendableOnly: true,
      pageIndex,
      pageSize: 500,
    })
    const batch = vtxos ?? []
    for (const vtxo of batch) {
      outputs.push({ txid: vtxo.txid, vout: vtxo.vout, value: Number(vtxo.value) })
    }
    if (batch.length === 0 || !page || page.current + 1 >= page.total) break
    pageIndex = page.current + 1
  }
  return outputs
}

/** `sha256(candidate)` compared against a wire-form payment hash — same check `send/orchestrator.ts`'s `preimageMatchesHash` makes before trusting a Lightning-side preimage. */
const hashMatches = (candidate: Uint8Array, paymentHashHex: string): boolean =>
  hex.encode(sha256(candidate)) === paymentHashHex

/**
 * Every candidate witness item a spend of ONE input might carry, in the order
 * worth trying: the Ark-specific condition field first (the mechanism this
 * repo's own `claimIdentity.ts` uses to attach a preimage — `setArkPsbtField(...,
 * ConditionWitness, [preimage])` — confirmed to survive a `toPSBT()`/`fromPSBT()`
 * round trip against the pinned SDK version), then whatever the input's own
 * finalized script witness holds, in case a caller only inspects the raw
 * witness stack. Neither source is trusted blindly — see {@link findClaimPreimage}.
 */
const candidateWitnessItems = (tx: InstanceType<typeof Transaction>, inputIndex: number): Uint8Array[] => {
  const fromConditionField = getArkPsbtFields(tx, inputIndex, ConditionWitness).flat()
  const fromFinalWitness = tx.getInput(inputIndex).finalScriptWitness ?? []
  return [...fromConditionField, ...fromFinalWitness]
}

/**
 * Read the preimage back out of whichever transaction claimed one of `outpoints`,
 * once covclaimd's autonomous non-interactive claim has landed.
 *
 * The Arkade-side counterpart to `src/onchain/port.ts`'s `findSpendWitness` +
 * `src/send/onchainOrchestrator.ts`'s `preimageFromClaimWitness`: the send leg
 * only ever reads a preimage from Lightning's `getPayment` or an ONCHAIN claim
 * witness; this is the first time this repo reads one back out of an ARKADE
 * spend. "Ask the indexer, don't trust local state" — same posture as
 * {@link findLockups}: every outpoint is checked (a lockup can be more than one
 * output), and every candidate this finds is verified against `paymentHashHex`
 * before being trusted — a matching witness SHAPE is not proof, only a matching
 * HASH is, exactly the discipline `send/orchestrator.ts`'s `preimageMatchesHash`
 * and `send/onchainOrchestrator.ts`'s `paymentHashOf(...) === row.paymentHash`
 * already apply to every other preimage this codebase consumes.
 *
 * Returns null when nothing is spent yet, when the indexer cannot produce the
 * spending transaction, or when nothing found hashes to `paymentHashHex` — all
 * three are "nothing provable yet", never distinguished, because a caller's
 * only correct response to any of them is the same: wait, or (past the refund
 * deadline) escalate to a human rather than guess.
 *
 * Worth knowing about the transaction this ends up reading: the indexer's
 * `spentBy` names the CHECKPOINT transaction, not the higher-level Ark
 * transaction id (`arkTxId`) — every offchain spend builds one checkpoint per
 * input (`buildOffchainTx`/`buildCheckpointTx`), and the checkpoint's own
 * input is the one carrying the swap-script `tapLeafScript`, so that is where
 * the claim leaf's witness actually lands. Matching that input back to the
 * outpoints asked for works either way, which is why this needs no special
 * case for it.
 */
export const findClaimPreimage = async (
  ctx: ArkadeContext,
  outpoints: readonly { txid: string; vout: number }[],
  paymentHashHex: string,
): Promise<Uint8Array | null> => {
  if (outpoints.length === 0) return null
  const { vtxos } = await ctx.wallet.indexerProvider.getVtxos({ outpoints: [...outpoints] })

  // Both spend facts, not just `spentBy`. The SDK's own `hasTerminalSpend`
  // spells out why: "The wire contract permits `isSpent: true` with an empty
  // `spentBy` (settlement inputs needing no forfeit are written that way)", so
  // a `spentBy`-only read can look straight past a real spend and report
  // nothing provable — which on this path means never learning `P` for a claim
  // that did land. Either field naming a transaction is worth reading.
  //
  // Truthiness, never presence: both are documented as "" rather than absent
  // for an output they do not apply to (the same rule `convertVtxo`'s own
  // mapping applies).
  const spendingTxids = [...new Set(vtxos.flatMap((v) => [v.spentBy, v.settledBy]).filter((id): id is string => !!id))]
  if (spendingTxids.length === 0) return null

  const { txs } = await ctx.wallet.indexerProvider.getVirtualTxs(spendingTxids)
  for (const raw of txs) {
    // No options object, matching every other Transaction.fromPSBT call in
    // this file (claimSwapScript, refundSwapScript) — confirmed against the
    // pinned SDK build that the default already preserves Ark's proprietary
    // PSBT fields (ConditionWitness among them) through this exact round trip.
    const tx = Transaction.fromPSBT(base64.decode(raw))
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i)
      if (!input.txid) continue
      const matchesOurOutpoint = outpoints.some((o) => hex.encode(input.txid!) === o.txid && input.index === o.vout)
      if (!matchesOurOutpoint) continue
      for (const candidate of candidateWitnessItems(tx, i)) {
        if (hashMatches(candidate, paymentHashHex)) return candidate
      }
    }
  }
  return null
}

export const totalValue = (outputs: readonly FundedOutput[]): number =>
  outputs.reduce((sum, output) => sum + output.value, 0)

/**
 * Every outpoint this script has ever held — SPENT ONES INCLUDED, which is the
 * whole reason it exists separately from {@link findLockups}.
 *
 * `findLockups` answers "what can still be spent here" and so goes empty the
 * moment a claim lands, which is exactly when {@link findClaimPreimage} needs
 * the outpoint to look up what did the claiming. Reading the unfiltered set
 * recovers it from the indexer rather than making every caller persist the
 * outpoint at funding time.
 *
 * Passing NO filter is what makes that work, and is deliberate: every one of
 * `getVtxos`'s state filters is opt-in narrowing — `spendableOnly`,
 * `spentOnly`, `recoverableOnly`, `pendingOnly`, `renewableOnly`, each
 * documented as "Only return ..." — so an absent filter restricts nothing and
 * spent outputs are included. Adding one here would reintroduce exactly the
 * blindness this exists to avoid.
 *
 * `value` and `spent` come back alongside the outpoint because the Lightning
 * receive leg funds its OWN lockup and has to tell "this script was already
 * funded (and maybe already claimed)" apart from "somebody dusted a public
 * address": the outpoint alone cannot answer that, and the exact-value
 * comparison is what keeps a 1-sat payment from being adopted as the
 * provider's funding — or from blocking one. `spent` is `hasTerminalSpend`
 * rather than a hand-rolled `spentBy` test for the reason
 * {@link lockupProvablySpent} spells out: the wire contract permits
 * `isSpent: true` with an empty `spentBy`, and only the SDK's own predicate
 * cannot read a spent output back as unspent.
 *
 * Paged the same way {@link findLockups} is, and for the same reason now that
 * values are compared here: a truncated first page would undercount the
 * lockup, and an empty page is the hard stop that keeps a misbehaving server
 * from spinning the loop.
 */
export const findLockupOutpoints = async (
  ctx: Pick<ArkadeContext, 'wallet'>,
  pkScriptHex: string,
): Promise<{ txid: string; vout: number; value: number; spent: boolean }[]> => {
  const outpoints: { txid: string; vout: number; value: number; spent: boolean }[] = []
  let pageIndex = 0
  for (;;) {
    const { vtxos, page } = await ctx.wallet.indexerProvider.getVtxos({
      scripts: [pkScriptHex],
      pageIndex,
      pageSize: 500,
    })
    const batch = vtxos ?? []
    for (const vtxo of batch) {
      outpoints.push({ txid: vtxo.txid, vout: vtxo.vout, value: Number(vtxo.value), spent: hasTerminalSpend(vtxo) })
    }
    if (batch.length === 0 || !page || page.current + 1 >= page.total) break
    pageIndex = page.current + 1
  }
  return outpoints
}

/**
 * Whether this script's money is provably GONE — it held at least one output,
 * and every one of them is spent.
 *
 * The positive counterpart to {@link findLockups}, and the reason the refund
 * sweeps no longer read an empty spendable answer as proof that somebody else
 * refunded. `findLockups` is `spendableOnly`, so it answers "what can still be
 * spent here" and goes empty for two unrelated reasons: the outputs really
 * were spent, or that view has not caught up. Absence of a spendable output is
 * not evidence of a spend, so this asks for the spend itself.
 *
 * Unfiltered for the same reason {@link findLockupOutpoints} is: every one of
 * `getVtxos`'s state filters is opt-in narrowing, so passing none is what
 * keeps spent outputs in the answer.
 *
 * `hasTerminalSpend` rather than a hand-rolled `spentBy` test, because the
 * wire contract permits `isSpent: true` with an empty `spentBy` — the SDK's
 * own predicate unions all three spend facts, and is the only one that cannot
 * read a spent output back as unspent. A SWEPT output is deliberately NOT a
 * terminal spend (the SDK keeps that fact separate), so a batch the server
 * swept answers false here and leaves the row actionable, rather than being
 * reported to a client as a refund it never received.
 *
 * An empty answer is FALSE, never true: a script the indexer knows nothing
 * about is lag, not proof, and callers only reach this for a row that already
 * recorded a funded lockup.
 */
export const lockupProvablySpent = async (
  ctx: Pick<ArkadeContext, 'wallet'>,
  pkScriptHex: string,
): Promise<boolean> => {
  const { vtxos } = await ctx.wallet.indexerProvider.getVtxos({ scripts: [pkScriptHex] })
  const all = vtxos ?? []
  return all.length > 0 && all.every((vtxo) => hasTerminalSpend(vtxo))
}

/**
 * Spend a swap script's claim leaf, revealing the preimage.
 *
 * The claim leaf is `preimage-condition + receiver + Arkade server`, so this needs
 * both our signature and the server's countersignature. `claimIdentity` carries
 * the rule that the preimage is attached after signing, on both the Arkade
 * transaction and every checkpoint the server hands back.
 *
 * The countersignature round-trip is the dangerous moment: the server answers
 * `submitTx` with checkpoint PSBTs it wants our signature on, and signing input 0
 * attaches the preimage. Nothing structural forces those PSBTs to be the
 * checkpoints we built — a forged one could spend the same lockup outpoint
 * through the same claim leaf to outputs of the server's choosing, and our blind
 * signature would complete the theft (we already paid the Lightning invoice, so
 * the lockup is our money at this point). Hence the rule: **sign nothing the
 * server returned until it is proven to be one of ours** — the response must
 * name the ark tx we submitted, and every returned checkpoint must txid-match a
 * locally built one (witnesses never change a txid, so the server's signature
 * cannot legitimately alter it). `assertSubmittedArkTxid` /
 * `matchServerCheckpoints` are the SDK's own guards for exactly this; a mismatch
 * throws and the swap routes to `stuck` for a human rather than signing.
 */
export const claimSwapScript = async (
  ctx: ArkadeContext,
  script: ClaimableScript,
  funded: readonly FundedOutput[],
  preimage: Uint8Array,
  destination: string,
): Promise<string> => {
  if (funded.length === 0) throw new Error('nothing to claim: no funded outputs')
  const signer = claimIdentity(ctx.identity, preimage)

  const { arkTx, checkpoints } = buildOffchainTx(
    funded.map((output) => ({
      txid: output.txid,
      vout: output.vout,
      value: output.value,
      tapLeafScript: script.claim(),
      tapTree: script.encode(),
    })),
    [{ script: ArkAddress.decode(destination).pkScript, amount: BigInt(totalValue(funded)) }],
    ctx.wallet.serverUnrollScript,
  )

  // No index list: every input spends the same claim leaf, so all are signed.
  const signedArkTx = await signer.sign(arkTx)
  const submitted = await ctx.wallet.arkProvider.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  // Verify BEFORE signing anything the server sent — see the doc comment.
  // `matched` keeps the server's order, which is what finalizeTx expects.
  assertSubmittedArkTxid(submitted, signedArkTx, 'claimSwapScript')
  const matched = matchServerCheckpoints(submitted.signedCheckpointTxs, checkpoints, 'claimSwapScript')

  const finalCheckpoints = await Promise.all(
    matched.map(async ({ server }) => {
      const signed = await signer.sign(server, [0])
      return base64.encode(signed.toPSBT())
    }),
  )

  await ctx.wallet.arkProvider.finalizeTx(submitted.arkTxid, finalCheckpoints)
  return submitted.arkTxid
}

/** Raw witness encoding of an empty stack: varint item count 0. */
export const EMPTY_RAW_WITNESS = Uint8Array.from([0x00])

/**
 * Insert the Extension OP_RETURN carrying the emulator packets, before the P2A
 * anchor that `buildOffchainTx` appends last. (The SDK has an equivalent helper
 * but keeps it module-private.)
 */
export const attachEmulatorPackets = (tx: Transaction, packets: Parameters<typeof Extension.create>[0]): void => {
  const out = Extension.create(packets).txOut()
  const anchorIndex = tx.outputsLength - 1
  const anchor = tx.getOutput(anchorIndex)
  if (!anchor?.script) throw new Error('transaction has no anchor output to displace')
  tx.updateOutput(anchorIndex, { script: out.script, amount: out.amount })
  tx.addOutput({ script: anchor.script, amount: anchor.amount ?? 0n })
}

/**
 * Push a covenant refund: spend every funded output back to the refund
 * destination the script commits to.
 *
 * The base program's refund leaf needs no signature of ours — its signers are
 * the Arkade server and the covenant-tweaked emulator key — so historically
 * the transaction went to the emulator unsigned. The extended (RFQ-family)
 * program's `refund` leaf is `nonInteractiveRefund`: server + RECEIVER +
 * emulator-tweaked key (confirmed in the SDK's own `ScriptV2`, which encodes
 * it as `MultisigTapscript([server, receiver, arkadeScriptKey])`). So we
 * always attempt to sign before submitting: on the base leaf our key is not
 * among its two signers, so the underlying signer finds nothing of ours to
 * sign and leaves the transaction untouched (same "sign what's ours, skip the
 * rest" contract {@link claimSwapScript} already relies on) — on the extended
 * leaf it supplies the one signature nothing else here can.
 *
 * ONLY VALID WHERE THE RECEIVER IS US. That holds on the SEND legs, where
 * `arkadeOpsFromContext` publishes `ctx.identity` as `providerPubkey`/receiver.
 * It does NOT hold on either RECEIVE leg: there the CLIENT is the receiver (it
 * is the beneficiary and generated `P`), so this function cannot produce the
 * receiver signature and a solver-initiated refund through this leaf will not
 * finalize without the client's cooperation.
 *
 * The receive legs therefore use {@link refundWithoutReceiverSwapScript} instead,
 * which spends `refundWithoutReceiver` (`client` + server after `refundLocktime`, no
 * receiver key). Not `refundUnilateral`: that drops the SERVER as well as the
 * receiver, so it is only reachable through the unilateral-exit flow this service
 * does not implement, and it needs a CSV rule that does not exist yet.
 * `refundWithoutReceiver` keeps the server, so it is an ordinary offchain spend, and
 * its ABSOLUTE timelock is the same `refundLocktime` the receive orchestrators
 * already gate on.
 *
 * Once signed (or left alone), the transaction is submitted to the emulator,
 * which executes the ArkadeScript against it, co-signs for the tweaked key
 * when it passes, and finalizes with the Arkade server. If the covenant does
 * not hold (wrong destination, short value), the emulator refuses, which is
 * the security model working, not an error to route around.
 *
 * Before `refundLocktime` matures, the server rejects with
 * FORFEIT_CLOSURE_LOCKED. Seconds-based locktimes mature against the chain
 * tip's timestamp, not wall clock, so a push right at the deadline can be
 * refused until the next block lands — callers should defer and retry.
 */
export const refundSwapScript = async (
  ctx: ArkadeContext,
  emulatorUrl: string,
  script: CovenantSwapScript,
  funded: readonly FundedOutput[],
  refundPkScript: Uint8Array,
): Promise<string> => {
  if (funded.length === 0) throw new Error('nothing to refund: no funded outputs')

  const { arkTx, checkpoints } = buildOffchainTx(
    funded.map((output) => ({
      txid: output.txid,
      vout: output.vout,
      value: output.value,
      tapLeafScript: script.refund(),
      tapTree: script.encode(),
    })),
    // One output PER input, index-aligned: the covenant inspects the output at
    // the CURRENT INPUT'S index (PUSHCURRENTINPUTINDEX ... INSPECTOUTPUTSCRIPTPUBKEY),
    // so input i's check is satisfied by output i and nothing else. A single
    // aggregate output would fail every input past the first.
    funded.map((output) => ({ script: refundPkScript, amount: BigInt(output.value) })),
    ctx.wallet.serverUnrollScript,
  )

  const fundingTxids = [...new Set(funded.map((output) => output.txid))]
  const { txs: fundingTxs } = await ctx.wallet.indexerProvider.getVirtualTxs(fundingTxids)
  const fundingByTxid = new Map<string, Uint8Array>()
  for (const raw of fundingTxs) {
    const tx = Transaction.fromPSBT(base64.decode(raw))
    fundingByTxid.set(tx.id, tx.toBytes(true))
  }
  funded.forEach((output, vin) => {
    const sourceTx = fundingByTxid.get(output.txid)
    if (!sourceTx) throw new Error(`indexer produced no virtual tx for ${output.txid}: cannot prove the refund prevout`)
    setArkPsbtField(arkTx, vin, PrevArkTxField, sourceTx)
  })

  attachEmulatorPackets(arkTx, [
    EmulatorPacket.create(
      funded.map((_, vin) => ({ vin, script: script.refundArkadeScript, witness: EMPTY_RAW_WITNESS })),
    ),
  ])

  // No index list: every input spends the same refund leaf, so all are
  // signed — same as claimSwapScript. Signed AFTER attaching the emulator
  // packets: those change the output set, and a signature over the
  // pre-packet outputs would not match the transaction actually submitted.
  // The unindexed form is what makes "skip leaves that aren't ours" work: the
  // SDK's own `Transaction.sign()` catches each input's "No taproot scripts
  // signed" internally and only surfaces an aggregate "No inputs signed",
  // which the SDK's identity wrapper specifically swallows.
  const signedArkTx = await ctx.identity.sign(arkTx)
  // The emulator verifies "non-arkd" signatures on checkpoints BEFORE it does
  // its own arkd-side handshake — unlike claimSwapScript's two-phase flow
  // (submit unsigned, sign the server's OWN co-signed checkpoints, finalize),
  // this is a single submitTx call, so the receiver's checkpoint signature
  // has to be in place upfront. Each checkpoint carries exactly one relevant
  // input, index 0.
  //
  // Unlike the arkTx above, an INDEXED sign call (`[0]`) goes straight to
  // `signIdx`, bypassing `Transaction.sign()`'s per-input try/catch — so on
  // the base program's refund leaf (no receiver signer), `signIdx` throws
  // "No taproot scripts signed" uncaught instead of leaving the checkpoint
  // untouched. Caught here to restore that same "sign what's ours, skip the
  // rest" contract claimSwapScript's checkpoint round gets for free.
  const signedCheckpoints = await Promise.all(
    checkpoints.map(async (c) => {
      try {
        return await ctx.identity.sign(c, [0])
      } catch (error) {
        if (error instanceof Error && error.message.includes('No taproot scripts signed')) return c
        throw error
      }
    }),
  )

  const emulator = new RestEmulatorProvider(emulatorUrl)
  const result = await emulator.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    signedCheckpoints.map((c) => base64.encode(c.toPSBT())),
  )
  // We sign nothing here, but the recorded txid must still be OUR transaction:
  // witnesses cannot change a txid, so any other value means a misrouted or
  // forged response, and persisting it as the refund's txid would bury that.
  const returned = Transaction.fromPSBT(base64.decode(result.signedArkTx))
  if (returned.id !== arkTx.id) {
    throw new Error(`emulator returned ark tx ${returned.id}, expected ${arkTx.id}`)
  }
  return returned.id
}

/**
 * Spend the `refundWithoutReceiver` leaf — `client` + Arkade server after
 * `refundLocktime`, with no receiver key and no emulator.
 *
 * This is the RECEIVE legs' solver recourse. There the solver funds the lockup
 * (so it plays the covenant's `client`) and the trader is `receiver`, which
 * makes {@link refundSwapScript}'s leaf unusable: it needs the signature of
 * the very party who benefits from withholding it.
 *
 * Because the leaf keeps the server and drops the covenant, this is an
 * ordinary two-phase Arkade submission — the same shape {@link claimSwapScript}
 * uses — rather than the emulator round trip. Two consequences worth stating:
 *
 * - No emulator packets, so no ArkadeScript pins the destination. That is safe
 *   here precisely because the solver is BOTH the signer and the beneficiary;
 *   the covenant on {@link refundSwapScript} exists to make "anyone can push"
 *   safe for a client that holds no key, which is not this situation.
 * - A single aggregate output, not one per input. The per-input, index-aligned
 *   shape {@link refundSwapScript} needs is a covenant requirement
 *   (PUSHCURRENTINPUTINDEX ... INSPECTOUTPUTSCRIPTPUBKEY); without the covenant
 *   there is nothing to align against.
 *
 * The CLTV needs no handling here: `buildOffchainTx` reads `absoluteTimelock`
 * off the input tapscripts, sets the transaction's `lockTime` to the largest,
 * and makes the sequence non-final so it is enforced. Callers still must not
 * push before `refundLocktime` — the server rejects with FORFEIT_CLOSURE_LOCKED,
 * and seconds-based locktimes mature against the chain tip's timestamp rather
 * than wall clock, so a push right at the deadline can be refused until the
 * next block lands.
 */
export const refundWithoutReceiverSwapScript = async (
  ctx: ArkadeContext,
  script: CovenantSwapScript,
  funded: readonly FundedOutput[],
  refundPkScript: Uint8Array,
): Promise<string> => {
  if (funded.length === 0) throw new Error('nothing to refund: no funded outputs')

  const { arkTx, checkpoints } = buildOffchainTx(
    funded.map((output) => ({
      txid: output.txid,
      vout: output.vout,
      value: output.value,
      tapLeafScript: script.refundWithoutReceiver(),
      tapTree: script.encode(),
    })),
    [{ script: refundPkScript, amount: BigInt(totalValue(funded)) }],
    ctx.wallet.serverUnrollScript,
  )

  // No index list: every input spends the same leaf, so all are signed.
  const signedArkTx = await ctx.identity.sign(arkTx)
  const submitted = await ctx.wallet.arkProvider.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    checkpoints.map((c) => base64.encode(c.toPSBT())),
  )

  const finalCheckpoints = await Promise.all(
    submitted.signedCheckpointTxs.map(async (encoded) => {
      const signed = await ctx.identity.sign(Transaction.fromPSBT(base64.decode(encoded)), [0])
      return base64.encode(signed.toPSBT())
    }),
  )

  await ctx.wallet.arkProvider.finalizeTx(submitted.arkTxid, finalCheckpoints)
  return submitted.arkTxid
}
