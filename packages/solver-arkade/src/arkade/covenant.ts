/**
 * The covenant swap script.
 *
 * `VHTLC.ScriptV2` from `@arkade-os/sdk` — the SAME class `@arkade-os/swap`'s
 * `lightningSendVtxoScript` builds, confirmed byte-identical (pkScript AND
 * every leaf) against it directly, not just by shared design intent. That is
 * what lets a trader's independently-derived address match this one BY
 * CONSTRUCTION rather than by hoping two implementations agree.
 *
 * **There used to be two shapes.** Without a `client` key this compiled a local
 * Arkade program artifact instead: three leaves, hand-emitted opcodes, and a
 * script no registered handler could re-derive — so such a lockup was never a
 * contract, stayed invisible to the wallet's own reads and to the contract
 * stream, and had to be special-cased everywhere it touched. The RFQ schema has
 * always required `client_refund_pubkey`, so the only things that ever built
 * one were the CLI's own self-tests; those now generate a key and the shape is
 * gone. It was also the weaker of the two: its claim leaf omitted the
 * `OP_SIZE 32 OP_EQUALVERIFY` preimage-length check that `VHTLC.ScriptV2`
 * carries.
 *
 * Rows quoted before the extended shape existed are still on disk and are all
 * terminal. `covenantScriptFromRow` refuses one rather than rebuilding it as
 * something else — see the comment there.
 *
 * Roles are named generically (`receiver`/`client`/`server`), not by swap
 * direction, so the same script shape serves both directions this corridor
 * will ever need: today `receiver` is the solver (claims by paying a
 * Lightning invoice) and `client` is the trader (refunds if the swap fails);
 * a future "receive via Lightning" leg — solver receives the payment, trader
 * claims the Arkade BTC — swaps which party plays which role without
 * touching this file.
 *
 * The three leaves every swap has had since the beginning:
 *
 * - `claim`            preimage + receiver + Arkade server. The receiver claims
 *                      by revealing the preimage that paying the invoice yields.
 * - `refund`           after `refundLocktime`: Arkade server + a covenant key.
 *                      The covenant pins the spend's output to the client's
 *                      refund address with value >= input, so ANYONE — the
 *                      receiver, a watchtower, the client — can push the refund
 *                      and the money can only go one place. The client holds no
 *                      key, signs nothing, and keeps no state.
 * - `unilateralClaim`  preimage + receiver alone, after a CSV delay. The
 *                      receiver's recourse if the Arkade Service disappears
 *                      between paying the invoice and claiming.
 *                      Spendable since `arkade/unilateralExit.ts`: the on-chain
 *                      exit flow lands the VTXO on Bitcoin through the SDK's
 *                      `UnilateralExit` and then sweeps this leaf once its CSV
 *                      matures. Operator-driven (`cli unilateral-exit <id>
 *                      --go`), never automatic — an exit costs onchain fees and
 *                      forfeits the cheap collaborative path a transient outage
 *                      would have restored. NOTHING HAS DRIVEN ONE TO COMPLETION
 *                      on any network, so the flow is reasoned and reviewed
 *                      rather than proven. The `refundLocktimeFor` bound reserves
 *                      the window this recourse runs in.
 *
 * The refund leaf carries no explicit second key: the compiler sees its
 * `arkadeScript` segment and appends the covenant co-signer automatically. That
 * key is `tweak(emulatorKey, enforcePayTo(refundKey))`: plain EC point addition
 * of the emulator's key and `H(script)*G` (tag "ArkScriptHash", NOT a taproot
 * tweak). The emulator service will only sign for that key after verifying the
 * transaction satisfies the script — which is what turns "anyone can push" from
 * a bug into the design.
 *
 * Trade-off, stated plainly: this tier (needs the server, not the receiver)
 * reaches it via the server + the emulator co-signing, rather than the server
 * + a client key directly (the reference VHTLC's `refundWithoutReceiver`
 * shape) — deliberately, to keep the BASE client integration stateless. A
 * client-keyed variant of this exact tier was considered for the extended
 * program below too, and left out even there: it would be a second path to
 * the tier `refund` already reaches, trading the emulator dependency for a
 * client-key dependency rather than removing one.
 *
 * `VHTLC.ScriptV2` adds five more leaves once a `client` key is available,
 * completing the trust ladder to match the reference VHTLC construction
 * leaf-for-leaf (`arkade-os/ts-sdk`'s `packages/ts-sdk/src/script/vhtlc.ts`).
 * Our own accessor names differ from VHTLC's in a few places (chosen before
 * this file depended on `VHTLC.ScriptV2` directly, kept for the sake of every
 * existing caller); the mapping:
 *
 * | this file's name       | `VHTLC.ScriptV2` name                | who / when |
 * | ----------------------- | ----------------------------------- | ---------- |
 * | `refund`                | `nonInteractiveRefund`              | server + receiver + emulator, immediate, no timelock, no sender signature — lets the two of them release the refund the moment they agree the swap has failed, rather than waiting out `refundLocktime`. Depends on the receiver's cooperation, unlike the base program's timelocked-but-infrastructure-only equivalent. |
 * | *(none — see `vhtlcOptions`)* | `nonInteractiveRefundWithoutReceiver` | server + emulator, after `refundLocktime`, no sender OR receiver signature — the only refund tier needing no participant at all. Same covenant-tweaked cosigner key as `nonInteractiveRefund` above (derived once, shared by both leaves), so the two always agree on where the refund goes. Part of the covenant suite's current shape — absent only when {@link NonInteractiveParameters.legacy} rebuilds the pre-timelocked-refund shape, a PARAMETER and not a constant because it moves `pkScript` and a row rebuilt from stored state must reproduce the shape it was actually funded with. This is the CLIENT's recourse for vanishing after funding, not this service's — the service holds `receiver` on send legs and `sender` on receive legs, so its own refund paths never touch this leaf. No accessor of its own: it exists only to be reachable by someone else, never by us. |
 * | `refundCollaborative`   | `refund`                            | client + receiver + server, immediate, no timelock |
 * | `refundWithoutServer`   | `unilateralRefund`                  | client + receiver, after a CSV delay, no server |
 * | `refundUnilateral`      | `unilateralRefundWithoutReceiver`   | client alone, after a CSV delay — needs nobody |
 * | `refundWithoutReceiver` | `refundWithoutReceiver`             | client + server, after `refundLocktime`, no receiver key. The RECEIVE legs' solver recourse: there the solver is `client` and the trader is `receiver`, so `refund` above is unreachable. Keeps the server, so unlike the `unilateral*` leaves it is an ordinary offchain spend rather than an exit-flow one. |
 * | `nonInteractiveClaim`   | `nonInteractiveClaim`               | server + emulator, pinned to the receiver's own payout — lets the receiver's claim be pushed without the receiver online |
 *
 * `refundWithoutServer`'s delay is `refundWithoutServerDelay` — the
 * operator-reported `unilateralRefundDelay` this repo has computed and stored
 * on every quote row since the client-refund-key leaf shipped, previously
 * unconsumed by any leaf. `nonInteractiveClaim` is marginal for today's
 * always-on solver receiver, but it's the exact leaf a future "receive via
 * Lightning" leg needs once `receiver` is the (possibly offline) trader
 * instead — already there because `VHTLC.ScriptV2` builds it, not because this
 * repo asked for it specifically.
 *
 * Building the extended case from `VHTLC.ScriptV2` directly — rather than a
 * second hand-rolled artifact, which is what this file did before — changes
 * the taproot merkle root from what that hand-rolled version produced, so
 * existing three-leaf (base) lockups are UNAFFECTED (untouched code path) but
 * any funds already sent to the OLD extended shape would need migrating.
 * Nothing was ever funded to it (still pre-merge at the time of this
 * change), so this is a one-time, uneventful cutover, not a live migration.
 */

import { arkade, VHTLC, type TapLeafScript } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import {
  absoluteLocktimeUnit,
  assertAbsoluteLocktime,
  isEncodableDelay,
  relativeDelayFrom,
  SEQUENCE_GRANULARITY_SECONDS,
} from '@arkade-os/solver-core/core/timelocks.js'
import type { XOnlyKey } from '@arkade-os/solver-core/core/preimage.js'

/** A token in an ArkadeScript `asm` array: an opcode name, a numeric push, raw bytes, or a `$param` placeholder. */
type AsmToken = string | number | bigint | Uint8Array

/**
 * Encode an opcode fragment through the SDK's ArkadeScript coder.
 *
 * The shared fragment builders return the artifact's loose {@link AsmToken}
 * (which also admits `$param` placeholder strings); this encodes a fragment that
 * holds only real opcodes and byte pushes, so narrowing to the coder's stricter
 * parameter type is sound.
 */
const encodeAsm = (asm: AsmToken[]): Uint8Array =>
  arkade.ArkadeScript.encode(asm as Parameters<typeof arkade.ArkadeScript.encode>[0])

/**
 * `HASH160 <hash20> EQUAL`, the preimage condition both claim leaves share.
 *
 * The single definition of the fragment: the artifact below embeds it with a
 * `$preimageHash` placeholder, and {@link preimageCondition} encodes it with
 * concrete bytes, so the two can never drift. Verified byte-identical to
 * `a9 14 <hash20> 87`.
 */
const preimageConditionAsm = (hash: AsmToken): AsmToken[] => ['HASH160', hash, 'EQUAL']

/**
 * The covenant: "this input's output pays the given P2TR key, value >= input".
 *
 * Byte-for-byte the script the SDK builds for its non-interactive claim leaf —
 * the SDK keeps its copy module-private, so we re-emit it. Introspection opcodes
 * are Elements-style; the emulator is what executes them. Shared with {@link
 * enforcePayTo} the same way {@link preimageConditionAsm} is.
 */
const enforcePayToAsm = (refundKey: AsmToken): AsmToken[] => [
  'PUSHCURRENTINPUTINDEX',
  'DUP',
  'INSPECTOUTPUTSCRIPTPUBKEY',
  1,
  'EQUALVERIFY',
  refundKey,
  'EQUALVERIFY',
  'INSPECTOUTPUTVALUE',
  'PUSHCURRENTINPUTINDEX',
  'INSPECTINPUTVALUE',
  'GREATERTHANOREQUAL',
]

/**
 * The same covenant for a lockup carrying an Arkade ASSET: "this input's output
 * pays the given P2TR key, carries at least the input's amount of ONE named
 * asset, and value >= input".
 *
 * The sat clause is NOT dropped — it is {@link enforcePayToAsm} verbatim, as
 * the tail. An asset-carrying VTXO carries sats too (the SDK's `Recipient` has
 * both `amount` and `assets`), so a covenant that constrained only the asset
 * would let the sats be stripped, exactly as the sat-only covenant would let
 * the ASSET be stripped. Sharing the tail rather than restating it is what
 * makes "BTC is unaffected" structural: the BTC path is this function's tail
 * with no prefix, so the two cannot drift.
 *
 * Two details of the opcodes decide whether this is safe, and both are easy to
 * get wrong (see `arkade-os/emulator`'s "Supported Opcodes" table, which is
 * what actually executes this):
 *
 *  - **A canonical Asset ID is TWO stack items**, `asset_txid` then
 *    `asset_gidx` (the issuance group index) — not one 32-byte push. Encoding
 *    it as a single blob compiles cleanly and fails only at spend time.
 *  - **`INSPECTOUTASSETLOOKUP` pushes `amount 1`, or `0 0` when the asset is
 *    absent.** The `VERIFY` after each lookup pops that success flag, and it is
 *    load-bearing rather than defensive: without it an output carrying NONE of
 *    the asset reports `amount = 0`, and `0 >= 0` passes — so the
 *    asset-stripping spend this covenant exists to stop would still succeed.
 *
 * `INSPECTOUTASSETCOUNT ... EQUALVERIFY 1` bounds the output to exactly the one
 * asset. Without it a spend may satisfy the amount check and still inject
 * further assets alongside. Deliberately strict: a covenant that is too
 * permissive cannot be tightened once funds are locked to it, while a strict
 * one can be relaxed in a later script version.
 *
 * Shape follows the SDK's own `banco-btc-to-asset` program
 * (`packages/swap/src/swap-want-asset.program.json`), which uses the identical
 * `INSPECTOUTASSETLOOKUP VERIFY ... GREATERTHANOREQUAL VERIFY` sequence.
 */
const enforcePayToAssetAsm = (refundKey: AsmToken, assetTxid: AsmToken, assetGroupIndex: AsmToken): AsmToken[] => [
  // The output must carry at least as much of the asset as the input did.
  // Output index is the input's, the self-send convention the tail also uses.
  'PUSHCURRENTINPUTINDEX',
  assetTxid,
  assetGroupIndex,
  'INSPECTOUTASSETLOOKUP',
  'VERIFY', // the asset is PRESENT on the output, not merely "zero of it"
  'PUSHCURRENTINPUTINDEX',
  assetTxid,
  assetGroupIndex,
  'INSPECTINASSETLOOKUP',
  'VERIFY', // ...and was present on the input, so the comparison is meaningful
  'GREATERTHANOREQUAL',
  'VERIFY',
  // Exactly one asset out: no injection alongside the one we bound.
  'PUSHCURRENTINPUTINDEX',
  'INSPECTOUTASSETCOUNT',
  1,
  'EQUALVERIFY',
  // ...and then the destination and sat covenant, unchanged.
  ...enforcePayToAsm(refundKey),
]

/** A refund destination must be a P2TR pkScript: `0x5120` followed by a 32-byte x-only key. */
const assertP2trPkScript = (pkScript: Uint8Array): void => {
  if (pkScript.length !== 34 || pkScript[0] !== 0x51 || pkScript[1] !== 0x20) {
    throw new Error('refund destination must be a P2TR pkScript (0x5120 + 32 bytes)')
  }
}

/**
 * `HASH160 <hash20> EQUAL`, the preimage condition both claim leaves share.
 *
 * Encodes {@link preimageConditionAsm} — the same fragment the artifact embeds —
 * through the SDK's ArkadeScript encoder. Verified byte-identical to
 * `a9 14 <hash20> 87`.
 */
export const preimageCondition = (preimageHash: Uint8Array): Uint8Array => {
  if (preimageHash.length !== 20) {
    throw new Error(`preimage hash must be 20 bytes (HASH160), got ${preimageHash.length}`)
  }
  return encodeAsm(preimageConditionAsm(preimageHash))
}

/**
 * The covenant: "this input's output pays the given P2TR script, value >= input".
 *
 * Encodes {@link enforcePayToAsm} — the fragment the refund leaf's `arkadeScript`
 * embeds — so the co-signer key the compiler commits to and this exported value
 * describe the exact same covenant.
 */
export const enforcePayTo = (destinationPkScript: Uint8Array): Uint8Array => {
  assertP2trPkScript(destinationPkScript)
  return encodeAsm(enforcePayToAsm(destinationPkScript.subarray(2)))
}

/**
 * A canonical Arkade Asset ID, as the introspection opcodes take it: the
 * issuance transaction id and the issuance group index within it.
 *
 * Two fields rather than one string because that is the opcode's own shape —
 * `INSPECTOUTASSETLOOKUP` consumes `asset_txid` and `asset_gidx` as separate
 * stack items. Keeping the split here means no call site has to know how to
 * take a serialized id apart, and none can push it as a single blob by
 * mistake.
 */
export interface ArkadeAssetId {
  /** The issuance transaction id, 32 bytes. */
  txid: Uint8Array
  /** The issuance group index within that transaction. */
  groupIndex: number
}

/**
 * {@link enforcePayTo} for a lockup denominated in an Arkade asset: "pays this
 * P2TR script, carries at least the input's amount of exactly this one asset,
 * and value >= input".
 *
 * Encodes {@link enforcePayToAssetAsm}. The BTC covenant is this one's tail, so
 * an asset lockup enforces everything a BTC lockup does and more — never less.
 *
 * NOT yet wired into any corridor: no swap is quoted or funded in an asset
 * today. This is the script half, landed on its own so it can be reviewed
 * without a state machine attached.
 */
export const enforcePayToAsset = (destinationPkScript: Uint8Array, asset: ArkadeAssetId): Uint8Array => {
  assertP2trPkScript(destinationPkScript)
  assertAssetId(asset)
  // REVERSED here, once, so no caller has to know. `asset.txid` is the id in
  // wire order — what `parseAssetId` returns and what the registry publishes —
  // but `INSPECTOUTASSETLOOKUP` matches the reversed 32 bytes. Push wire order
  // and the lookup reports the asset absent (`0 0`), which fails the covenant
  // with nothing in the error naming the cause: the emulator says only
  // `OP_VERIFY failed`. Established on regtest against a real minted asset,
  // by elimination against a passing BTC-only control.
  //
  // A copy rather than an in-place `reverse()`, because the caller's id is
  // theirs and a covenant builder must not mutate it.
  //
  // Corroborated by the reference implementation: `@arkade-os/swap`'s
  // `offer.ts` builds the `banco-btc-to-asset` program with
  // `wantAssetTxid: offer.wantAsset.txid.slice().reverse()` — same flip, and
  // the same copy-then-reverse for the same reason.
  const inspectionTxid = Uint8Array.from(asset.txid).reverse()
  return encodeAsm(enforcePayToAssetAsm(destinationPkScript.subarray(2), inspectionTxid, asset.groupIndex))
}

/**
 * The wire form of an Asset ID: 34 bytes, `txid || gidx`, as 68 lowercase hex
 * characters.
 *
 * This is the identity `docs/rfq-protocol.md` § 2 carries ("the serialized
 * Arkade AssetId in lowercase hex (68 chars, network-scoped)") and the one the
 * solver-registry card validates as `^(btc|[0-9a-f]{68})$`. 32 + 2 = 34 bytes
 * is exactly those 68 characters.
 */
const ASSET_ID_HEX_LENGTH = 68

/**
 * Parse the 68-hex wire Asset ID into the pair the introspection opcodes take.
 *
 * The format is normative in the Arkade Assets spec:
 *
 * ```
 * AssetId := { txid: bytes32, gidx: u16 LE }   # genesis tx id + group index
 * ```
 *
 * **`gidx` is LITTLE-endian** — the spec is explicit that all multi-byte
 * integer fields are, "consistent with Bitcoin's serialization convention",
 * and names `gidx` first among them. Reading it big-endian is the mistake this
 * function exists to make impossible: it does not fail, it silently names a
 * different asset (group 1 becomes group 256), and the covenant then binds a
 * lockup to an asset nobody meant.
 *
 * `txid` is a byte string rather than an integer, so the endianness rule above
 * (which covers the integer fields) does not apply to it. It is returned here
 * exactly as it appears in the id.
 *
 * BUT a script that INSPECTS the asset must push those 32 bytes REVERSED.
 * `OP_INSPECTOUTASSETLOOKUP` matches the reversed form; pushing them as they
 * appear makes it report the asset absent (`0 0`), and the covenant then fails
 * with nothing in the error naming the cause — the emulator says only
 * `OP_VERIFY failed`. Confirmed on regtest against a real minted asset.
 *
 * So: reverse when building a covenant, do not reverse when comparing ids on
 * the wire. {@link enforcePayToAsset} takes the id in wire order and is
 * responsible for that flip, so callers pass what they read.
 */
export const parseAssetId = (hexId: string): ArkadeAssetId => {
  if (hexId.length !== ASSET_ID_HEX_LENGTH || !/^[0-9a-f]+$/.test(hexId)) {
    throw new Error(`asset id must be ${ASSET_ID_HEX_LENGTH} lowercase hex characters, got ${JSON.stringify(hexId)}`)
  }
  const bytes = hex.decode(hexId)
  return {
    txid: bytes.subarray(0, 32),
    groupIndex: bytes[32]! | (bytes[33]! << 8),
  }
}

/** The inverse of {@link parseAssetId}, so a round trip is testable in both directions. */
export const serializeAssetId = (asset: ArkadeAssetId): string => {
  assertAssetId(asset)
  return hex.encode(Uint8Array.from([...asset.txid, asset.groupIndex & 0xff, (asset.groupIndex >> 8) & 0xff]))
}

/** An asset id must be a 32-byte issuance txid and a non-negative group index. */
const assertAssetId = (asset: ArkadeAssetId): void => {
  if (asset.txid.length !== 32) {
    throw new Error(`asset txid must be 32 bytes, got ${asset.txid.length}`)
  }
  // A negative index cannot name a group, and a non-integer would encode as
  // something the opcode never accepts — both are caller bugs worth naming here
  // rather than at spend time, when the lockup is already funded.
  // Upper bound as well as lower, and it belongs HERE rather than only in
  // `serializeAssetId`: this is what `enforcePayToAsset` calls before building
  // a pkScript. A group index past u16 clears a lower-bound-only check, gets
  // encoded into the script push, and yields a covenant the emulator rejects
  // at SPEND time — with `OP_VERIFY failed vin=0` and nothing naming the
  // cause, on a lockup that is already funded.
  if (!Number.isInteger(asset.groupIndex) || asset.groupIndex < 0 || asset.groupIndex > 0xffff) {
    throw new Error(`asset group index must be an integer in [0, 65535], got ${asset.groupIndex}`)
  }
}

/**
 * The three-leaf covenant swap, as a program artifact. `$`-prefixed tokens are
 * constructor params bound per swap by {@link CovenantSwapScript}. The compiler
 * turns this into the taproot tree; for `refund` it derives the covenant-tweaked
 * co-signer key from the `arkadeScript` segment and appends it after `$server`,
 * so the emulator is the only party that can complete a refund, and only after
 * it verifies the covenant.
 */

/**
 * The emulator covenant suite, all or nothing — mirrors `VHTLC.Options`'s
 * `nonInteractiveParameters` group in `@arkade-os/sdk`. One key, tweaked per covenant
 * destination, co-signs every leaf in the suite; one group carries every
 * covenant leaf's parameters, so a lockup can never name one leaf without the
 * others or two different emulator keys.
 */
export interface NonInteractiveParameters {
  /** The emulator service's public key, 33-byte compressed (or 32-byte x-only). */
  emulatorPubkey: Uint8Array
  /** Where `nonInteractiveClaim` must pay: the receiver's own P2TR pkScript, 34 bytes. */
  receiverPkScript: Uint8Array
  /**
   * Where BOTH refund covenants must pay: the sender's (the client's) own P2TR
   * pkScript, 34 bytes. One destination shared by both refund leaves, so they
   * cannot diverge on where a refund goes.
   */
  senderPkScript: Uint8Array
  /**
   * LEGACY REBUILD ONLY — never for a new lockup.
   *
   * `'preTimelockedRefund'` builds the suite WITHOUT its timelocked refund
   * leaf: the shape every covenant lockup funded before that leaf shipped
   * carries. Lockups already funded in that shape keep it permanently — a leaf
   * cannot be retrofitted onto an address already committed — so re-deriving
   * such a lockup (to spend it, or to verify an old quote's address) needs
   * this. NOT a constant: it moves `pkScript`, so a caller that rebuilds a
   * script FROM A STORED ROW must pass back exactly what that row was funded
   * with, not what today's code would choose. Getting this wrong either bricks
   * an old lockup's own claim/refund (`assertScriptMatchesRow` throws against
   * every rebuild) or hands a client-integrated address that an unupgraded
   * client's own eight-leaf derivation refuses to match.
   *
   * Omitted for every NEW quote — omitting builds the current, full suite.
   */
  legacy?: 'preTimelockedRefund'
}

export interface CovenantSwapParams {
  /** Provider x-only key — the receiver on this leg. */
  receiver: XOnlyKey
  /** Arkade server x-only key. */
  server: XOnlyKey
  /** 20-byte HASH160 of the preimage. */
  preimageHash: Uint8Array
  /** Absolute refund deadline, unix seconds (BIP65). */
  refundLocktime: number
  /** CSV delay for the provider's server-independent claim, seconds. */
  claimDelay: number
  /** Denominating asset, if any. ONLY THE ONE NAMED IS PROTECTED: extras on a funded VTXO are the spender's. */
  asset?: ArkadeAssetId
  /**
   * The client's own refund key.
   *
   * Required. It used to be optional, and its absence selected a base
   * three-leaf script compiled from a local artifact — a shape no registered
   * handler can re-derive, so such a lockup was never a contract and was
   * invisible to the wallet's own reads and to the contract stream. The RFQ
   * schema has always required the key, so the only things that ever built one
   * were the CLI's own self-tests; those now generate one, and the shape is
   * gone.
   */
  client: XOnlyKey
  clientRefundDelay: number
  /**
   * CSV delay for `refundWithoutServer` (client + receiver, no server) — the
   * operator-reported `unilateralRefundDelay`, the middle tier of the same
   * three-tier ladder `claimDelay`/`clientRefundDelay` already come from.
   */
  refundWithoutServerDelay: number
  /**
   * The emulator covenant suite. REQUIRED — this service's lockup is
   * definitionally the covenant one; there is no six-leaf shape here.
   */
  nonInteractiveParameters: NonInteractiveParameters
}

/**
 * Composes over one of two underlying scripts rather than extending either:
 * the base (3-leaf, no `client`) case still compiles the local
 * `COVENANT_SWAP_PROGRAM` artifact directly; the extended (`client` present)
 * case builds `VHTLC.ScriptV2` from `@arkade-os/sdk` — the SAME class
 * `@arkade-os/swap`'s `lightningSendVtxoScript` builds, so a trader's
 * independently-derived address is guaranteed to match this one BY
 * CONSTRUCTION, not by hoping two hand-written implementations agree. (The
 * base case still can't use `VHTLC.ScriptV2`: its `sender` field is required
 * unconditionally, and the whole point of the base program is a client that
 * holds no key at all.)
 */
export class CovenantSwapScript {
  readonly pkScript: Uint8Array
  readonly claimScript: string
  readonly refundScript: string
  readonly unilateralClaimScript: string
  /** The ArkadeScript the refund leaf's covenant key commits to. */
  readonly refundArkadeScript: Uint8Array
  /** Set only when this script was built with a `client` key. */
  readonly refundUnilateralScript: string | undefined
  /** Set only when this script was built with a `client` key. */
  readonly refundCollaborativeScript: string | undefined
  /** Set only when this script was built with a `client` key. */
  readonly refundWithoutServerScript: string | undefined
  /**
   * Set only when this script was built with a `client` key. The solver's
   * recourse on the RECEIVE legs, where `receiver` is the client-user — see
   * {@link refundWithoutReceiver}.
   */
  readonly refundWithoutReceiverScript: string | undefined
  /** Set only when this script was built with a `client` key. */
  readonly nonInteractiveClaimScript: string | undefined
  /** The ArkadeScript `nonInteractiveClaim`'s covenant key commits to. Set only when this script was built with a `client` key. */
  readonly nonInteractiveClaimArkadeScript: Uint8Array | undefined
  /**
   * The `VHTLC.ScriptV2` options this script was built from — set only when
   * built with a `client` key, and undefined for the base three-leaf program.
   *
   * Exposed for CONTRACT REGISTRATION and nothing else. `ContractManager`
   * re-derives a contract's script from its stored params and refuses any row
   * whose supplied script does not match, so the params it is given must be
   * the very ones this script was constructed with — not a second set
   * assembled from the same row, which would drift the moment either side
   * changed. Handing over the options object itself is what makes that drift
   * impossible rather than merely unlikely.
   *
   * Undefined is the honest answer for the base case, not a gap: that path
   * compiles {@link COVENANT_SWAP_PROGRAM} rather than a VHTLC, so no
   * registered handler can derive it and there is nothing truthful to
   * register it as. See {@link lockupContractRegistration}.
   */
  readonly vhtlcOptions: VHTLC.Options

  /** The one underlying script. There used to be two — see the class comment. */
  private readonly extended: InstanceType<typeof VHTLC.ScriptV2>

  constructor(params: CovenantSwapParams) {
    // The locktime's unit is whatever its own magnitude says: this validates the value
    // is well-formed rather than dictating a unit, because a block-typed deployment
    // legitimately builds heights here. Which unit is right for this deployment is
    // decided upstream, where the ladder is — and the mixed-unit guard below is what
    // stops the two disagreeing.
    assertAbsoluteLocktime(params.refundLocktime, 'refundLocktime', absoluteLocktimeUnit(params.refundLocktime))
    if (!isEncodableDelay(params.claimDelay)) {
      throw new Error(
        `claimDelay must be a positive block count below ${SEQUENCE_GRANULARITY_SECONDS}, ` +
          `or a positive multiple of ${SEQUENCE_GRANULARITY_SECONDS}s, got ${params.claimDelay}`,
      )
    }
    const covenants = params.nonInteractiveParameters
    if (covenants.emulatorPubkey.length !== 32 && covenants.emulatorPubkey.length !== 33) {
      throw new Error(`emulator pubkey must be 32 or 33 bytes, got ${covenants.emulatorPubkey.length}`)
    }
    if (params.preimageHash.length !== 20) {
      throw new Error(`preimage hash must be 20 bytes (HASH160), got ${params.preimageHash.length}`)
    }
    assertP2trPkScript(covenants.senderPkScript)
    if (!isEncodableDelay(params.clientRefundDelay)) {
      throw new Error(
        `clientRefundDelay must be a positive block count below ${SEQUENCE_GRANULARITY_SECONDS}, ` +
          `or a positive multiple of ${SEQUENCE_GRANULARITY_SECONDS}s, got ${params.clientRefundDelay}`,
      )
    }
    if (!isEncodableDelay(params.refundWithoutServerDelay)) {
      throw new Error(
        `refundWithoutServerDelay must be a positive block count below ${SEQUENCE_GRANULARITY_SECONDS}, ` +
          `or a positive multiple of ${SEQUENCE_GRANULARITY_SECONDS}s, got ${params.refundWithoutServerDelay}`,
      )
    }

    // THE THREE RUNGS MUST SHARE ONE UNIT.
    //
    // Each is validated alone above, so nothing there notices a ladder whose claim leaf
    // counts blocks and whose refund leaf counts seconds. Such a script compiles, funds
    // and is spendable — just not in the order the ladder was designed to enforce: 20
    // blocks against 4096 seconds inverts which recourse opens first, and the solo
    // refund opening before the claim is precisely the ordering that lets a funder take
    // money from a claimant holding the preimage.
    //
    // It cannot arise from `deriveUnilateralDelays`, which builds all three in one unit.
    // It arises from a caller assembling them by hand, or a row half-written across a
    // unit change — so it is caught HERE, at construction, where the script is still
    // cheap to refuse.
    const units = new Set([
      relativeDelayFrom(params.claimDelay).unit,
      relativeDelayFrom(params.clientRefundDelay).unit,
      relativeDelayFrom(params.refundWithoutServerDelay).unit,
    ])
    if (units.size !== 1) {
      throw new Error(
        `the unilateral ladder mixes units: claimDelay ${params.claimDelay} ` +
          `(${relativeDelayFrom(params.claimDelay).unit}), refundWithoutServerDelay ` +
          `${params.refundWithoutServerDelay} (${relativeDelayFrom(params.refundWithoutServerDelay).unit}), ` +
          `clientRefundDelay ${params.clientRefundDelay} ` +
          `(${relativeDelayFrom(params.clientRefundDelay).unit}) — all three must count the same clock`,
      )
    }
    assertP2trPkScript(covenants.receiverPkScript)

    {
      // The unit rides on the value, so the leaves are encoded in whichever clock the
      // ladder was derived in. `VHTLC.ScriptV2` takes a `RelativeTimelock` and needs no
      // help beyond being told which it is.
      const delay = (value: number): { type: 'seconds' | 'blocks'; value: bigint } => ({
        type: relativeDelayFrom(value).unit,
        value: BigInt(value),
      })
      this.extended = new VHTLC.ScriptV2({
        // Kept as one object literal, read back below through the script's own
        // `options`, so registration can never be handed a second, drifted copy.
        sender: params.client,
        receiver: params.receiver,
        server: params.server,
        preimageHash: params.preimageHash,
        refundLocktime: BigInt(params.refundLocktime),
        unilateralClaimDelay: delay(params.claimDelay),
        unilateralRefundDelay: delay(params.refundWithoutServerDelay!),
        unilateralRefundWithoutReceiverDelay: delay(params.clientRefundDelay!),
        // The SDK spells the suite per leaf until its own `nonInteractiveParameters`
        // group ships (arkade-os/ts-sdk#818); the mapping is exact — one key,
        // one suite — and collapses to a passthrough then.
        nonInteractiveClaim: { receiverPkScript: covenants.receiverPkScript, emulatorPubkey: covenants.emulatorPubkey },
        nonInteractiveRefund: {
          senderPkScript: covenants.senderPkScript,
          emulatorPubkey: covenants.emulatorPubkey,
          // The client may fund a lockup and vanish. Every OTHER refund tier
          // needs either their signature or the receiver's; this is the only
          // one that needs neither — server + emulator alone can push it to
          // the client's pre-committed address once `refundLocktime` matures.
          // Adds one tapleaf (a CLTV multisig over server + the SAME
          // covenant-tweaked cosigner `nonInteractiveRefund` above already
          // uses), so it changes `pkScript` — see the leaf-mapping table above.
          //
          // Absent only for a legacy rebuild: a caller rebuilding from a stored
          // row must pass back the shape that row was actually funded with, or
          // this script's pkScript stops matching the lockup on disk.
          withoutReceiver: covenants.legacy !== 'preTimelockedRefund',
        },
        // WIRE order: the SDK reverses it for `INSPECTOUTASSETLOOKUP` itself, and
        // pre-reversing here fails the covenant as a bare `OP_VERIFY failed`.
        asset: params.asset,
      })
      this.pkScript = this.extended.pkScript
      this.claimScript = this.extended.claimScript
      // Our `refund` names the tier "needs the server, not the receiver" —
      // VHTLC's non-interactive variant of that same tier, since a client key
      // is available here to ALSO reach it interactively (see
      // refundCollaborative/refundWithoutServer/refundUnilateral below).
      this.refundScript = this.extended.nonInteractiveRefundScript!
      this.unilateralClaimScript = this.extended.unilateralClaimScript
      this.refundArkadeScript = this.extended.nonInteractiveRefundArkadeScript!
      this.refundUnilateralScript = this.extended.unilateralRefundWithoutReceiverScript
      this.refundCollaborativeScript = this.extended.refundScript
      this.refundWithoutServerScript = this.extended.unilateralRefundScript
      this.refundWithoutReceiverScript = this.extended.refundWithoutReceiverScript
      this.nonInteractiveClaimScript = this.extended.nonInteractiveClaimScript
      this.nonInteractiveClaimArkadeScript = this.extended.nonInteractiveClaimArkadeScript
      this.vhtlcOptions = this.extended.options
    }
  }

  address(hrp: string, serverKey: Uint8Array): ReturnType<InstanceType<typeof arkade.ArkadeProgramScript>['address']> {
    return this.extended.address(hrp, serverKey)
  }

  encode(): Uint8Array {
    return this.extended.encode()
  }

  claim(): TapLeafScript {
    return this.extended.claim()
  }

  refund(): TapLeafScript {
    return this.extended.nonInteractiveRefund()[0]
  }

  unilateralClaim(): TapLeafScript {
    return this.extended.unilateralClaim()
  }

  refundUnilateral(): TapLeafScript {
    if (!this.extended) {
      throw new Error('this covenant script was built without a client refund key — no refundUnilateral leaf')
    }
    return this.extended.unilateralRefundWithoutReceiver()
  }

  refundCollaborative(): TapLeafScript {
    if (!this.extended) {
      throw new Error('this covenant script was built without a client refund key — no refundCollaborative leaf')
    }
    return this.extended.refund()
  }

  refundWithoutServer(): TapLeafScript {
    if (!this.extended) {
      throw new Error('this covenant script was built without a client refund key — no refundWithoutServer leaf')
    }
    return this.extended.unilateralRefund()
  }

  /**
   * `client` + `server` after `refundLocktime`, with NO receiver key. The
   * solver's correct recourse on the RECEIVE legs: there the solver funds the
   * lockup (so it plays `client`) and the trader is `receiver`, which makes
   * {@link refund}'s receiver signature unobtainable — the beneficiary of a
   * failed swap is exactly the party with no reason to sign it away.
   *
   * Unlike {@link refundUnilateral}, this leaf keeps the server, so it is
   * spendable as an ordinary offchain Arkade transaction rather than needing
   * the unilateral-exit flow this service still does not implement. Its
   * timelock is ABSOLUTE and is the same `refundLocktime` the receive
   * orchestrators already gate the `refunding` transition on, so it needs no
   * new timing rule.
   */
  refundWithoutReceiver(): TapLeafScript {
    if (!this.extended) {
      throw new Error('this covenant script was built without a client refund key — no refundWithoutReceiver leaf')
    }
    return this.extended.refundWithoutReceiver()
  }

  nonInteractiveClaim(): TapLeafScript {
    if (!this.extended) {
      throw new Error('this covenant script was built without a client refund key — no nonInteractiveClaim leaf')
    }
    return this.extended.nonInteractiveClaim()[0]
  }

  /**
   * The ACTUAL number of taproot leaves in the compiled script.
   *
   * Not the count of accessors this class exposes — `nonInteractiveRefundWithoutReceiver`
   * changes this number (8 or 9) with no accessor of its own, by design (see
   * the leaf-mapping table above), so a count built from this class's own
   * named fields can never see it. This reads the underlying `VHTLC.ScriptV2`
   * taptree directly, which is the only thing that cannot drift from what
   * `pkScript` actually commits to.
   */
  get leafCount(): number {
    return this.extended.leaves.length
  }
}
