/**
 * Keeping the solver's own Arkade coins alive, and its escrow visible.
 *
 * Every other Arkade module here is about ONE SWAP's money. This one is about the
 * solver's OWN: the balance it claims swap proceeds into (`send/arkadeOps.ts`) and
 * funds receive-leg lockups out of (`receive/arkadeOps.ts`). Those are ordinary
 * VTXOs with an ordinary batch expiry, and until this module existed nothing renewed
 * them, recovered them, or even read them. A solver left running long enough walked
 * its whole float into expiry, where the only way out is a unilateral exit this
 * service does not implement.
 *
 * Two jobs, and the distinction between them is the entire design:
 *
 * - **Renewal** re-settles coins that are approaching expiry. It selects
 *   through `getSpendableVtxos`, which is GATED: a contract whose handler
 *   answers `isGenericallySpendable: false` is excluded. `vhtlc-v2` answers
 *   exactly that, so registering a lockup PROTECTS it from renewal rather than
 *   exposing it. Escrow must never be renewed — moving it would pull the
 *   lockup out from under a counterparty still entitled to claim it.
 *
 *   Renewal settles its snapshot MINUS whatever a funding has pinned: `cli.ts`
 *   subtracts {@link ArkadeContext.reservations} from the candidate read before this
 *   module sees it. Without that, `settle` and `sendBitcoin` are two independent
 *   spenders of one float and arkd resolves the collision by failing one of them;
 *   when the loser is a funding, a swap dies for no reason. ArkLabsHQ/coinflip hit
 *   this as a P0.
 *
 *   The pin is only enforceable because funding NAMES its inputs, which is why
 *   `receive/arkadeOps.ts` selects explicitly through {@link selectLockupFunding}
 *   rather than calling `wallet.send`.
 *
 *   That selection carries the other half. A VTXO created by an offchain send stays
 *   in its parent's batch, so a lockup inherits the batch expiry of whatever funded
 *   it — and the SDK's `selectVirtualCoins` sorts SOONEST-EXPIRY-FIRST, because for
 *   an ordinary send spending a near-expiry coin is how you avoid losing it. For
 *   escrow that is inverted: it would hand the lockup the worst available parent, the
 *   gate above then forbids renewal from re-anchoring it, and the guard below holds
 *   recovery back until CLTV. So funding takes the LATEST-expiring coins that outlive
 *   `MAX_REFUND_HORIZON` and refuses rather than minting escrow that cannot survive
 *   its own swap.
 *
 *   NOTE: the inheritance step is inferred from the Ark model and from
 *   `toBatchExpiry` reading indexer state, not observed. Confirm by funding a lockup
 *   on regtest from a coin of known batch expiry and reading the child's
 *   `virtualStatus.batchExpiry`. If it is wrong the expiry rule is merely
 *   unnecessary — it only ever declines to spend — and the pin still stands.
 *
 * - **Recovery** re-registers already-swept or expired coins into a fresh
 *   batch. It selects through the UNGATED `getVtxos`, so the gate does NOT
 *   exclude a lockup here, and it sweeps everything recoverable into ONE
 *   settlement with no timelock awareness of any kind. That combination is why
 *   {@link runVtxoLifecycle} refuses to call it blind — see the guard below.
 *
 * **Registration is what makes a lockup visible at all.** `getVtxos` and
 * `getSpendableVtxos` both read a CONTRACT SNAPSHOT (`filterSnapshotVtxos` flat-maps
 * the registered contracts' own VTXOs), so an unregistered lockup is not merely
 * ungated, it is absent. It cuts both ways: before registration the solver's lockups
 * were invisible to recovery and therefore safe from it by accident; registering them
 * buys the gate, the balance accounting and a recovery path for a swept lockup, and
 * in the same stroke arms the untimelocked sweep above. The guard is the price of the
 * visibility, not an optional extra.
 */

import {
  ArkAddress,
  canRecoverOnchain,
  Estimator,
  VHTLCV2ContractHandler,
  type CreateContractParams,
  type IntentFeeConfig,
  type OffchainInput,
} from '@arkade-os/sdk'
import { splitRenewalOutputs, type PoolRung } from './vtxoPool.js'
import { hex } from '@scure/base'
import type { CovenantSwapScript } from './covenant.js'
import { assertCovenantScriptRow, type CovenantScriptRow } from './covenantRow.js'
import type { CorridorReaderSet } from '@arkade-os/solver-core/core/corridor.js'

/**
 * The contract type a swap lockup registers as.
 *
 * `vhtlc-v2` and not `vhtlc`: the two versions build different script bytes
 * for identical keys, this corridor's extended covenant wraps `ScriptV2`, and
 * a registration is refused outright unless the stored params re-derive the
 * exact pkScript the row claims. V1 would also answer
 * `isGenericallySpendable: true`, which would put live escrow back into
 * generic selection — the opposite of what registering it is for.
 */
export const LOCKUP_CONTRACT_TYPE = 'vhtlc-v2'

/** Names these rows in an operator's contract listing; carries no behaviour. */
export const LOCKUP_CONTRACT_LABEL = 'Lightning swap lockup'

/** Distinguishes our rows from any other consumer's in the same wallet. */
export const LOCKUP_CONTRACT_KIND = 'lnswap-lockup'

/**
 * The registration for a lockup.
 *
 * It used to return null for the base three-leaf program — a compiled
 * `ArkadeProgramScript` no handler could re-derive, so there was no type to
 * register it as truthfully, and such a lockup stayed invisible to the wallet's
 * own reads and to the contract stream. That shape is gone: every script this
 * service builds is a `VHTLC.ScriptV2`, so every lockup registers.
 *
 * The params come from the script's own `vhtlcOptions` rather than being
 * rebuilt from the row, so the row this was derived from and the contract that
 * gets stored cannot disagree.
 */
export const lockupContractRegistration = (script: CovenantSwapScript, address: string): CreateContractParams => {
  return {
    type: LOCKUP_CONTRACT_TYPE,
    params: VHTLCV2ContractHandler.serializeParams(script.vhtlcOptions),
    script: hex.encode(script.pkScript),
    address,
    label: LOCKUP_CONTRACT_LABEL,
    // Belt-and-braces. `vhtlc-v2`'s handler hardcodes `isGenericallySpendable:
    // false` and never consults metadata, so this changes nothing today; it is
    // written so that a row re-typed to a metadata-driven handler (`arkade`
    // reads exactly this key) cannot silently become spendable.
    metadata: { genericallySpendable: false, kind: LOCKUP_CONTRACT_KIND },
  }
}

/**
 * Every live lockup across every REGISTERED corridor, mapped onto the shape
 * {@link lockupContractRegistration} needs (by way of `covenantScriptFromRow`)
 * to register each one as a contract.
 *
 * TAKES THE READER SET, NEVER `Services.corridors`. The reader set holds every
 * corridor with a STORE; the serving set holds only corridors with a SERVICE,
 * and `createServices` gates the service on `corridorEnabled` while opening
 * every store regardless. An operator switching a corridor off does not un-fund
 * its in-flight lockups, and those are exactly the ones that still need
 * registering. Sourcing this from the serving set would drop them silently.
 *
 * This used to take four NAMED stores, which made completeness a COMPILE-TIME
 * fact — and that was the entire point rather than an incidental style choice,
 * because the bug it guards against already happened: `cli.ts`'s
 * `registerLiveLockups` once built its row set from only `store` and
 * `onchainStore`, the two SEND corridors, and never read the receive legs at
 * all. A set cannot give that guarantee, so it moved to
 * `test/arkade/liveLockups.test.ts` plus the emptiness check in the body.
 *
 * The gap this closes was not cosmetic. Per this module's header, a lockup is
 * invisible to `getVtxos`/`getSpendableVtxos` until it is registered, so an
 * unregistered receive-leg lockup got none of the `isGenericallySpendable:
 * false` gate protecting it from renewal, and no recovery path if swept.
 * Registering it also means its deadline now flows into
 * {@link runVtxoLifecycle}'s CLTV guard — intended, not a side effect to
 * suppress: the guard's job is holding recovery back from any registered
 * lockup that is not yet safe to sweep, and the solver's own receive-leg
 * escrow is exactly such a lockup.
 */
export const liveLockupRows = async (
  corridors: CorridorReaderSet,
  log: (line: string) => void = () => {},
): Promise<CovenantScriptRow[]> => {
  const rows: CovenantScriptRow[] = []
  const answered: string[] = []
  const mute: string[] = []
  for (const corridor of corridors) {
    if (!corridor.liveLockups) {
      mute.push(corridor.descriptor.pair)
      continue
    }
    answered.push(corridor.descriptor.pair)
    for (const row of await corridor.liveLockups()) {
      // Checked, not cast. `liveLockups` is typed `readonly unknown[]` so core
      // need not name this row, and a plugged-in corridor is third-party code:
      // a cast would carry a malformed row into `covenantScriptFromRow` and
      // build a wrong script from it. See `assertCovenantScriptRow`.
      rows.push(assertCovenantScriptRow(row, corridor.descriptor.pair))
    }
  }
  // A non-empty set in which NOTHING answered is a wiring fault, not an idle
  // solver: every built-in corridor supplies `liveLockups`, so the only way to
  // get here is a set assembled wrong. Returning [] would report every contract
  // as no longer live, and that is what drives retirement — so it stops instead.
  if (corridors.size > 0 && answered.length === 0) {
    throw new Error(`no corridor supplied live lockups across ${corridors.size} registered corridor(s)`)
  }
  // PARTIAL silence is the case the throw above cannot see, and it is the
  // dangerous one. If one corridor answers, `answered.length` is non-zero and
  // the guard passes — so a second corridor that holds real lockups and simply
  // omits `liveLockups` has them dropped from this list silently. They then
  // lose renewal protection and their recovery path, which is capital, not
  // display.
  //
  // It cannot throw: a corridor with no Arkade lockups to report is entitled to
  // omit the method, and this layer cannot tell the two apart — only the
  // operator who wired the set can. So it names them and leaves the judgement
  // where the knowledge is.
  if (answered.length > 0 && mute.length > 0) {
    log(
      `live lockups: ${mute.length} of ${corridors.size} corridors do not implement liveLockups (${mute.join(', ')}) — ` +
        'any of them that funds Arkade lockups has no renewal protection and no recovery path for them',
    )
  }
  return rows
}

/** The slice of a VTXO the guard needs: which script it sits at. */
export interface LifecycleVtxo {
  txid: string
  vout: number
  /** pkScript hex — what ties a coin back to the contract it belongs to. */
  script: string
}

/** A registered lockup and the deadline its recovery must wait for. */
export interface LockupDeadline {
  /** pkScript hex. */
  script: string
  /**
   * Absolute refund deadline, unix SECONDS. Always seconds here, never a
   * block height: `assertAbsoluteLocktime` (core/timelocks.ts) rejects
   * anything below `LOCKTIME_THRESHOLD`, and `CovenantSwapScript`'s
   * constructor calls it, so a height-denominated lockup cannot exist in this
   * service. That is what lets the guard compare numbers directly instead of
   * dispatching on BIP65 form the way a general-purpose client must.
   */
  refundLocktime: number
}

/**
 * The server's intent-fee policy and the limits a renewal has to price against.
 *
 * Straight off `ArkProvider.getInfo()`. Every field is operator policy, not
 * protocol constant: two servers on the same network can and do differ.
 */
export interface RenewalPolicy {
  /** CEL programs pricing each input and output. See {@link renewExpiringVtxos}. */
  intentFee: IntentFeeConfig
  /** Per-output ceiling; `-1n` means no limit. */
  vtxoMaxAmount: bigint
  /** Below this an output is unspendable, so a renewal producing one is pointless. */
  dust: bigint
}

/** The slice of a spendable coin a renewal has to read to price and schedule it. */
export interface RenewableVtxo {
  value: number
  /** When the coin was minted — the fee policy may price by age. */
  createdAt: Date
  /** Batch expiry as a timestamp, when the coin carries one. */
  expiresAt?: Date
  /** Batch expiry as a block height, for coins denominated that way. */
  expiresAtHeight?: number
  /** Already swept by the server, so it prices as `recoverable` rather than `vtxo`. */
  isSwept?: boolean
}

/**
 * The wallet reads and writes a renewal needs, shaped for injection.
 *
 * Deliberately four narrow callbacks rather than a wallet: the whole point of
 * this module is that its dependencies can be driven by a test, and a real
 * settlement is the one thing a unit test must never perform.
 */
export interface RenewVtxoDeps<V extends RenewableVtxo> {
  /** `ArkProvider.getInfo()`, narrowed to what pricing needs. */
  serverInfo(): Promise<RenewalPolicy>
  /**
   * Renewal candidates: the GATED near-expiry read
   * (`IVtxoManager.getExpiringVtxos`). Gated is load-bearing — it is what keeps
   * live escrow out of renewal; see this module's header.
   */
  expiringVtxos(): Promise<readonly V[]>
  /** Where the renewed output lands — the solver's own address. */
  destination(): Promise<string>
  /** `IWallet.settle`, narrowed to the single-output shape a renewal builds. */
  /**
   * Settle `inputs` into `outputs`.
   *
   * An ARRAY, because a renewal that hands the float back as one coin is what
   * makes it unable to fund more than one swap at a time. `settle` has always
   * taken a list; this service was passing a list of one. @see splitRenewalOutputs
   */
  settle(inputs: readonly V[], outputs: readonly { address: string; amount: bigint }[]): Promise<string>
  /**
   * The pool shape a renewal should carve its proceeds into.
   *
   * Optional: absent means one output, which is exactly what this did before.
   * A deployment that has not configured a target renews as it always has.
   */
  poolTarget?: readonly PoolRung[]
  /** Wall clock, unix MILLISECONDS. Injected so a test can place the deadline. */
  nowMs(): number
}

/**
 * Inputs per settlement, mirroring the SDK's own `MAX_VTXOS_PER_SETTLEMENT`.
 *
 * Copied rather than imported because the SDK does not export it. Being stale
 * here is a deferral, not a loss: the overflow is renewed on the next pass.
 */
const MAX_VTXOS_PER_SETTLEMENT = 50

/**
 * Outputs one renewal may create.
 *
 * The same figure `mintPool` uses for a split transaction, and for the same
 * reason: a float shredded into hundreds of pieces costs a fee per piece to
 * renew forever after. Eight covers the pool target's rungs while leaving the
 * shape legible.
 *
 * WHAT THE SERVER ACTUALLY BOUNDS is transaction WEIGHT, not an output count -
 * arkd's `/v1/info` publishes `maxTxWeight` (40000 on the regtest build) and no
 * max-outputs field at all, so there is nothing to read this constant off. A
 * taproot output is ~43 vbytes, so eight of them is ~1400 weight units against
 * that 40000: roughly three percent, and the inputs dominate long before the
 * outputs do.
 *
 * So this is a SHAPE bound, not a protocol one, and it is safe by a wide margin
 * rather than by a check. If it ever grows materially - or if a settlement
 * starts carrying many more inputs - the figure that matters is `maxTxWeight`
 * and it should be estimated rather than assumed. Raised by review on #126.
 */
const MAX_RENEWAL_OUTPUTS = 8

/**
 * How long before batch expiry a coin becomes worth renewing, matching the
 * SDK's `DEFAULT_RENEWAL_CONFIG.thresholdMs`.
 *
 * Only ever an upper bound — {@link renewalThresholdMs} caps it against the
 * coin's own batch lifetime.
 */
export const RENEWAL_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Batch expiry as the FEE PROGRAMS are fed it — never as a clock.
 *
 * Multiplying a height by 1000 is dimensionally meaningless, but it is exactly
 * what the SDK's `toBatchExpiry` does, and `toOffchainInputFeeParams` hands
 * that number to the operator's CEL program. The server evaluates the same
 * program over its own copy, so matching it is what keeps our price and the
 * server's identical. Deliberately matched rather than corrected: correcting it
 * here would silently price against a different expiry than the server uses.
 *
 * Only {@link offchainInputFeeParams} and the ordering may use this. Anything
 * comparing against wall-clock time wants {@link scheduleExpiryMs}, which is a
 * different question with a different right answer.
 */
const batchExpiryMs = (vtxo: RenewableVtxo): number | undefined => {
  if (vtxo.expiresAt !== undefined) return vtxo.expiresAt.getTime()
  if (vtxo.expiresAtHeight !== undefined) return vtxo.expiresAtHeight * 1000
  return undefined
}

/**
 * Batch expiry as a WALL-CLOCK instant, for scheduling — `undefined` whenever
 * the coin does not carry one.
 *
 * A height is not a time, and no arithmetic here can turn it into one: the
 * conversion needs a chain tip, which is a fact about the world rather than
 * about the coin. So a height-denominated coin answers `undefined` — the same
 * answer the SDK's own predicates give, since `isPastExpiry` evaluates the
 * height arm only when a caller supplies `now.height`, and `isVtxoExpiringSoon`
 * reads `normalizeVtxo(vtxo).expiresAt` and returns false without one.
 *
 * Feeding `expiresAtHeight * 1000` to a clock comparison instead is what used
 * to happen, and it was never a near-miss: at any real height that product
 * lands in January 1970, so the coin read as expired by decades. It made
 * {@link renewalThresholdMs} collapse to 0 and {@link isRenewalDue}
 * unconditionally true, which is to say it disabled the treadmill cap outright
 * for those coins.
 */
const scheduleExpiryMs = (vtxo: RenewableVtxo): number | undefined => vtxo.expiresAt?.getTime()

/**
 * The renewal threshold actually applied to one coin: {@link RENEWAL_THRESHOLD_MS},
 * capped at HALF that coin's own batch lifetime.
 *
 * The cap is not a refinement, it is what stops a fee treadmill. A renewal
 * costs the operator's intent fee every time it runs (1% of each input on the
 * corridor's regtest stack), and it mints a coin with a FRESH full lifetime. So
 * whenever the flat threshold exceeds the batch lifetime — which it does by
 * more than 40x on a stack with a 6144-second expiry against the SDK's 3-day
 * default — the coin renewal just minted is instantly due again, and the float
 * is re-settled on every pass until the fees eat it. That is strictly worse
 * than the expiry this module exists to prevent, and it is invisible until
 * renewal starts working, which is why it lands in the same change.
 *
 * Half is the largest cap with that property: a coin one tick past renewal has
 * its whole lifetime left, which is always more than half of it, so a
 * successful renewal cannot immediately re-trigger. Taking less would only
 * shrink the retry window for no further benefit. Where the flat threshold is
 * already the smaller number — a mainnet-shaped four-week batch against three
 * days — this changes nothing at all.
 */
export const renewalThresholdMs = (vtxo: RenewableVtxo): number => {
  const expiry = scheduleExpiryMs(vtxo)
  if (expiry === undefined) return RENEWAL_THRESHOLD_MS
  const lifetime = Math.max(0, expiry - vtxo.createdAt.getTime())
  return Math.min(RENEWAL_THRESHOLD_MS, lifetime / 2)
}

/**
 * Whether a coin is close enough to its batch expiry to be worth the fee.
 *
 * A coin with no expiry at all is never due: nothing is going to strand it, so
 * paying to re-mint it would be pure loss.
 *
 * A HEIGHT-denominated coin is always due — a decision, not an artifact of the
 * arithmetic. It cannot be scheduled ({@link scheduleExpiryMs} explains why a height
 * is not a time), so the only question is which way to fail, and that follows from
 * which of these coins can reach here. `expiringVtxos` is the SDK's GATED near-expiry
 * read, filtered on `isVtxoExpiringSoon(...) || canRecoverOnchain(...) ||
 * isSubdust(...)`. The near-expiry arm reads `normalizeVtxo(vtxo).expiresAt` and
 * returns false without one, so it never surfaces a height-denominated coin on
 * APPROACH to expiry — the state in which renewing early would be the waste. What can
 * surface one is `canRecoverOnchain` (already swept or already past expiry) and
 * `isSubdust`. Renewing the first two at once is right; deferring them stalls until
 * they strand, because treating them as not-due hands them to `recoverVtxos` and its
 * zero-fee defect. A subdust coin drops out at the dust check below instead.
 *
 * The fee treadmill the cap guards against needs a coin re-selected pass after pass,
 * and none of these are: a renewal mints a coin that is neither swept nor past expiry
 * nor subdust, so it drops straight back out of the gated read.
 */
export const isRenewalDue = (vtxo: RenewableVtxo, nowMs: number): boolean => {
  const expiry = scheduleExpiryMs(vtxo)
  if (expiry === undefined) return vtxo.expiresAtHeight !== undefined
  return expiry - nowMs <= renewalThresholdMs(vtxo)
}

/** The fee-program inputs a coin contributes, mirroring the SDK's `toOffchainInputFeeParams`. */
const offchainInputFeeParams = (vtxo: RenewableVtxo): OffchainInput => {
  const expiry = batchExpiryMs(vtxo)
  return {
    amount: BigInt(vtxo.value),
    type: vtxo.isSwept ? 'recoverable' : 'vtxo',
    // The SDK passes zero here too: the intent fee prices the coin, not the
    // witness that will spend it.
    weight: 0,
    birth: vtxo.createdAt,
    expiry: expiry === undefined ? undefined : new Date(expiry),
  }
}

/**
 * Renew the solver's expiring float, paying the operator's intent fee.
 *
 * **Why this exists instead of `IVtxoManager.renewVtxos`.** That method sums its
 * selected inputs and asks for an output of exactly that sum, so the fee an intent
 * implies (`inputs - outputs`) is always zero. Against any operator charging a
 * non-zero intent fee the server rejects the whole intent —
 * `INTENT_INSUFFICIENT_FEE (31): got 0 min expected N` — and the float is never
 * renewed. `runPeriodicSettle` and no-argument `Wallet.settle()` price their outputs
 * properly; only `renewVtxos` and `recoverVtxos` were left gross, and `renewVtxos`
 * takes no fee argument a caller could correct it through. The pricing below is the
 * same arithmetic those working paths use. See `docs/runbook.md`.
 *
 * `recoverVtxos` has the identical defect and is NOT fixed here — see
 * {@link runVtxoLifecycle}'s guard for why that sweep is the dangerous one to
 * reimplement blind.
 *
 * **This settles outside the SDK's `renewalInProgress` mutex, and the SDK's own
 * renewal really is running alongside it.** `createArkadeContext` passes neither
 * `settlementConfig` nor `renewalConfig`, and the SDK reads that absence as its
 * DEFAULT (`vtxoThreshold` 3 days, `pollIntervalMs` 60s), not as "off"; only an
 * explicit `settlementConfig: false` disables it. `Wallet.create` then awaits
 * `getVtxoManager()`, so `initializeSubscription` runs on every wallet this service
 * builds, installing two renewal paths we never call: a `vtxo_received` subscription
 * into `renewVtxos()`, and a 60-second poll into `runPeriodicSettle`. Both hold
 * `renewalInProgress` across the window they settle in; this function cannot, because
 * the field is private.
 *
 * `test/e2e/vtxoLifecycle.e2e.test.ts` prints it on every run, from a pass this
 * module never asked for:
 *
 *   Error renewing VTXOs: INTENT_INSUFFICIENT_FEE (31): got 0 min expected 2582
 *       at _VtxoManager.renewVtxos (vtxo-manager.ts:1453)
 *
 * The cost is bounded, which is why it is documented rather than worked around: the
 * two paths can select overlapping inputs, but the server decides, so the loser is
 * refused with `VTXO_ALREADY_SPENT`, `VTXO_ALREADY_REGISTERED` or a duplicated-input
 * error and the coins it wanted have been renewed by the winner. Nothing
 * double-spends; the visible symptom is an entry in `report.failures`. The clean fix
 * — `settlementConfig: false` where the wallet is built — is a wallet-wide behaviour
 * change (it also turns off boarding sweep and deprecated-signer migration) and so is
 * an operator's call.
 *
 * Throws rather than returning a status, so {@link runVtxoLifecycle}'s classification
 * keeps working unchanged: the two "nothing to do" outcomes reuse the SDK's own
 * wording, which `BENIGN_RENEWAL` already matches.
 */
export const renewExpiringVtxos = async <V extends RenewableVtxo>(deps: RenewVtxoDeps<V>): Promise<string> => {
  const candidates = await deps.expiringVtxos()
  const now = deps.nowMs()
  const due = candidates.filter((vtxo) => isRenewalDue(vtxo, now))
  if (due.length === 0) throw new Error('No VTXOs available to renew')

  const { intentFee, vtxoMaxAmount, dust } = await deps.serverInfo()
  const estimator = new Estimator(intentFee)
  const address = await deps.destination()
  const script = hex.encode(ArkAddress.decode(address).pkScript)
  const outputFeeOn = (amount: bigint): bigint => BigInt(estimator.evalOffchainOutput({ amount, script }).satoshis)

  // Soonest-expiring first, so that when a cap bites it is the most urgent
  // coins that make the cut rather than whichever the indexer listed first.
  const ordered = [...due].sort((a, b) => (batchExpiryMs(a) ?? Infinity) - (batchExpiryMs(b) ?? Infinity))

  const inputs: V[] = []
  let gross = 0n
  for (const vtxo of ordered) {
    if (inputs.length >= MAX_VTXOS_PER_SETTLEMENT) break
    const fee = BigInt(estimator.evalOffchainInput(offchainInputFeeParams(vtxo)).satoshis)
    // Renewing a coin worth less than its own fee destroys value outright.
    if (fee >= BigInt(vtxo.value)) continue
    const net = gross + BigInt(vtxo.value) - fee
    // Skip rather than stop: a smaller coin further down may still fit under
    // the ceiling. Judged on the post-output-fee amount, which is what the
    // server actually measures.
    if (vtxoMaxAmount >= 0n && net - outputFeeOn(net) > vtxoMaxAmount) continue
    inputs.push(vtxo)
    gross = net
  }
  if (inputs.length === 0) throw new Error('No VTXOs available to renew: every expiring coin is below its own fee')

  // SPLIT DURING THE SETTLEMENT, not after it. `settle` takes a list of outputs,
  // so the float can come back already in the shape that lets it fund several
  // swaps at once — one batch instead of a renewal followed by a separate split,
  // no window where the whole float sits on a single coin, and one intent-fee
  // round rather than two.
  //
  // Every piece is costed at its own size: an operator's intent fee is a CEL
  // expression and a live server answers things like `"amount * 0.01"`, so
  // neither `gross - n * fee` nor a single evaluation at `gross` is right.
  const pieces = splitRenewalOutputs({
    gross,
    target: deps.poolTarget ?? [],
    dust,
    outputFeeOn,
    maxOutputs: MAX_RENEWAL_OUTPUTS,
  })
  // An empty target, or too little to make even one rung, yields exactly one
  // piece — the behaviour this had before the split existed.
  const first = pieces[0]
  if (first === undefined || first < dust) {
    throw new Error(`Renewal output ${first ?? 0n} is below dust threshold ${dust}`)
  }

  return deps.settle(
    inputs,
    pieces.map((amount) => ({ address, amount })),
  )
}

/** The narrow slice of the wallet and its managers this needs, shaped for injection. */
export interface VtxoLifecycleDeps {
  /** Renews the expiring float. Resolves to a settlement txid. */
  renewVtxos(): Promise<string>
  /**
   * `IVtxoManager.recoverVtxos`, narrowed. Resolves to a settlement txid.
   *
   * Carries the same zero-fee defect {@link renewExpiringVtxos} exists to work
   * around, so against a fee-charging operator this fails with
   * `INTENT_INSUFFICIENT_FEE` for exactly the same reason. Deliberately left
   * calling the SDK anyway: recovery's input selection is a subdust-sensitive
   * read this module cannot reproduce from the public surface, and it feeds the
   * untimelocked all-or-nothing sweep the guard below exists to hold back.
   * Replacing that with app code no live test has ever exercised would trade a
   * loud, contained failure for a silent, dangerous one. It surfaces in
   * `failures` until the SDK prices it.
   */
  /**
   * Re-shape the float after a renewal consolidated it. Resolves to a
   * settlement txid, or null when the float was already the right shape.
   *
   * Renewal settles every selectable coin into ONE output. That is fine for
   * sats, and fatal once the float holds an Arkade asset: settle carries assets
   * onto the wallet's own output, so the whole float lands on one asset-bearing
   * coin that may not fund a sats lockup. Splitting afterwards is what keeps the
   * float spendable. @see arkade-os/lightning-swap-service#123
   *
   * Optional so a deployment that has no pool — or a test that is not about
   * this — can leave it out and get the previous behaviour exactly.
   */
  resplitFloat?(): Promise<string | null>
  recoverVtxos(): Promise<string>
  /**
   * Exactly what `recoverVtxos` would sweep: the UNGATED read, already
   * narrowed to the coins it would actually select. The guard has to see the
   * same set the sweep will, or it is guarding a different question.
   */
  recoverableVtxos(): Promise<readonly LifecycleVtxo[]>
  /** Every registered lockup's script and deadline. */
  lockupDeadlines(): Promise<readonly LockupDeadline[]>
  /** Wall clock, unix seconds. Injected so a test can place the deadline. */
  nowSeconds(): number
}

export interface VtxoLifecycleReport {
  /** Settlement txid, or null when nothing needed renewing. */
  renewed: string | null
  /** Split txid, or null when the float needed no re-shaping after renewal. */
  resplit: string | null
  /** Settlement txid, or null when nothing was recovered. */
  recovered: string | null
  /** Why recovery did not run, when it was deliberately held back. */
  recoverySkipped: string | null
  /**
   * Inputs moved off deprecated signers this pass, by the cooperative
   * migration `runFloatLifecycle` owns since `settlementConfig: false` stopped
   * the SDK's poll. Zero on `runVtxoLifecycle`'s own report, which does not
   * migrate. The number exists so an operator can tell the cooperative path
   * ran at all — without it, every input quietly taking sweep-then-recover
   * instead would look identical to migration working.
   */
  migrated: number
  /**
   * Anything that went wrong, as text. Both steps are always attempted and
   * nothing here throws: this runs on a watch loop whose other entries are
   * unguarded money-path work, and a transient settlement failure must not be
   * able to end that loop. The next pass retries whatever this one missed.
   */
  failures: string[]
}

/**
 * The renew-side outcomes that are ordinary rather than wrong.
 *
 * A wallet with nothing near expiry, nothing above dust, or a renewal already
 * in flight has not failed at anything — the SDK simply reports these by
 * throwing. Matched on message because that is the only form they take; the
 * SDK's own event-driven renewal filters the same set the same way.
 */
const BENIGN_RENEWAL = [
  'No VTXOs available to renew',
  'below the dust threshold',
  'is below dust threshold',
  'Renewal already in progress',
]

/**
 * How far past `refundLocktime` a lockup must be before its recovery is
 * treated as safe to attempt.
 *
 * Same quantity, same reasoning and deliberately the same figure as
 * `HTLC_REFUND_MTP_MARGIN` in `send/onchainOrchestrator.ts`: an absolute
 * locktime matures against MEDIAN-TIME-PAST, which lags wall clock by roughly
 * an hour on mainnet, so a lockup that looks due by `Date.now()` can still be
 * refused. The consequence here is worse than there, which is why the margin
 * is applied to the SKIP side rather than the push side: a premature refund
 * broadcast is one rejected transaction, but a premature recovery is one
 * rejected SETTLEMENT that takes every unrelated coin in the batch with it.
 * Waiting out the margin costs nothing — these deadlines are hours wide and
 * the pass simply runs again.
 */
export const LOCKUP_RECOVERY_MTP_MARGIN_SECONDS = 90 * 60

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isBenignRenewal = (error: unknown): boolean => {
  const message = messageOf(error)
  return BENIGN_RENEWAL.some((benign) => message.includes(benign))
}

/**
 * One lifecycle pass: renew what is expiring, recover what has been swept —
 * unless recovering right now would take a live swap down with it.
 *
 * **The guard.** `recoverVtxos` puts every recoverable output into a single
 * settlement. A registered lockup's annotation leaf is `refundWithoutReceiver`,
 * which carries the swap's `refundLocktime` as an absolute CLTV, and the SDK
 * checks no timelock before including it. So one immature lockup does not fail
 * only itself — it fails the whole batch, including the operating-balance
 * coins that were the reason for recovering at all. When that is the case the
 * pass declines to recover and says so; the deadline matures on its own and
 * the next pass proceeds.
 *
 * The check is deliberately narrow in one direction and wide in the other. A
 * pre-CLTV lockup that is NOT itself recoverable cannot be in the sweep set,
 * so it does not block anything — blocking on every open swap would wedge
 * recovery for as long as the solver had business. But when a pre-CLTV lockup
 * IS in that set, the whole round is skipped rather than some subset attempted:
 * the settlement is all-or-nothing, so there is no partial version of this to
 * get right.
 *
 * Renewal is attempted first and independently. It is gated, so it cannot
 * touch a lockup, and its failure says nothing about whether recovery should
 * run — a solver whose float has already expired needs recovery MOST in
 * exactly the pass where renewal has nothing left to save.
 */
export const runVtxoLifecycle = async (deps: VtxoLifecycleDeps): Promise<VtxoLifecycleReport> => {
  const failures: string[] = []
  let renewed: string | null = null
  let resplit: string | null = null
  let recovered: string | null = null
  let recoverySkipped: string | null = null

  try {
    renewed = await deps.renewVtxos()
  } catch (error) {
    if (!isBenignRenewal(error)) failures.push(`renew: ${messageOf(error)}`)
  }

  // Only after a renewal that actually settled. A renewal that found nothing to
  // do consolidated nothing, so there is nothing to undo — and re-planning the
  // pool every idle pass would read the wallet for no reason. This is the exact
  // moment the float went from many coins to one.
  //
  // Failure is recorded, never thrown: a float left consolidated still funds
  // sats swaps, so this is a degradation rather than an outage, and it must not
  // stop the recovery step below.
  if (renewed !== null && deps.resplitFloat) {
    try {
      resplit = await deps.resplitFloat()
    } catch (error) {
      failures.push(`resplit: ${messageOf(error)}`)
    }
  }

  try {
    const recoverable = await deps.recoverableVtxos()
    if (recoverable.length === 0) {
      return { renewed, resplit, recovered, recoverySkipped, migrated: 0, failures }
    }

    const deadlines = await deps.lockupDeadlines()
    const now = deps.nowSeconds()
    // Only the immature ones matter. A matured lockup in the sweep set is fine
    // — its leaf is spendable, which is the whole point of waiting.
    const immature = new Map(
      deadlines
        .filter((lockup) => now < lockup.refundLocktime + LOCKUP_RECOVERY_MTP_MARGIN_SECONDS)
        .map((lockup) => [lockup.script, lockup.refundLocktime]),
    )
    const blocking = recoverable.filter((vtxo) => immature.has(vtxo.script))
    if (blocking.length > 0) {
      const detail = blocking
        .map((vtxo) => `${vtxo.txid}:${vtxo.vout} at ${vtxo.script} (refundLocktime ${immature.get(vtxo.script)})`)
        .join(', ')
      recoverySkipped = `${blocking.length} recoverable lockup output(s) not yet safely past CLTV at ${now}: ${detail}`
      return { renewed, resplit, recovered, recoverySkipped, migrated: 0, failures }
    }

    recovered = await deps.recoverVtxos()
  } catch (error) {
    failures.push(`recover: ${messageOf(error)}`)
  }

  return { renewed, resplit, recovered, recoverySkipped, migrated: 0, failures }
}

/**
 * `recoverableVtxos` over a real wallet: the same ungated read `recoverVtxos`
 * performs, narrowed by the SDK's own recoverability predicate so the guard
 * and the sweep agree on what "recoverable" means rather than this module
 * re-deriving it.
 *
 * **This set must never be NARROWER than the sweep's**, or the guard can miss
 * the very output it exists to catch. One place it could be: `recoverVtxos`
 * resolves its `TimeHeight` with a chain tip when the wallet has an onchain
 * provider, and neither that resolver nor the provider is on the SDK's public
 * surface, so this cannot obtain the same height. Without one, height-encoded
 * expiry is documented to read as NOT expired — which would drop exactly the
 * VTXOs the sweep still picks up. Any output carrying a height expiry is
 * therefore treated as potentially recoverable rather than evaluated, making
 * this a superset by construction. Being too wide only ever costs a deferred
 * recovery round; being too narrow costs the batch.
 */
export const recoverableVtxosFrom = async (wallet: {
  getVtxos(filter?: {
    withRecoverable?: boolean
    withUnrolled?: boolean
  }): Promise<readonly (LifecycleVtxo & { expiresAtHeight?: number } & Parameters<typeof canRecoverOnchain>[0])[]>
}): Promise<LifecycleVtxo[]> => {
  const vtxos = await wallet.getVtxos({ withRecoverable: true, withUnrolled: false })
  // Wall clock and no height, matching what the SDK's own offline-first paths
  // pass; the height gap is covered by the `expiresAtHeight` arm below.
  const now = { timestamp: new Date() }
  return vtxos
    .filter((vtxo) => canRecoverOnchain(vtxo, now) || vtxo.expiresAtHeight !== undefined)
    .map((vtxo) => ({ txid: vtxo.txid, vout: vtxo.vout, script: vtxo.script }))
}
