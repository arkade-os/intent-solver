/**
 * Quoted terms in, the offer covenant out — the derivation the RFQ route needs
 * and the packet route never does.
 *
 * On the packet path an offer arrives already compiled: a maker publishes it and
 * `offerFromFundingTx` decodes it. Here the terms are fixed BEFORE anything
 * exists on chain, so the covenant has to be built from them — and both sides
 * build it independently, which is what lets a client fund an address without
 * trusting the solver's arithmetic. A derivation that disagreed by one byte
 * would put the deposit at an address nobody is watching, which is why this is
 * one function rather than a shape each caller assembles.
 */
import { asset, type RelativeTimelock } from '@arkade-os/sdk'
import { isEncodableRelativeDelay, relativeDelayFrom } from '@arkade-os/solver-core/core/timelocks.js'
import {
  RFQ_ASSET_SWAP_V2,
  RFQ_ASSET_SWAP_DIRECTED,
  RFQ_ASSET_SWAP_DIRECTED_NONCE,
  RFQ_ASSET_SWAP_DIRECTED_NONCE_V2,
  NONCE_RFQ_CONTRACT_VERSIONS,
  bindsRfqNonce,
} from '@arkade-os/solver-core/core/rfqContract.js'
import { assetRfqNonce, offerVtxoScript, type AssetSwapContractVersion, type Offer } from '@arkade-os/swap/protocol'
import { hex } from '@scure/base'

/**
 * The covenant parameters, all of them already decided.
 *
 * Structural rather than a corridor type, for the reason `offerSettle.ts` gives
 * about `OfferFillIntent`: `solver-corridors` depends on this package, not the
 * other way round.
 */
export interface QuotedOfferTerms {
  /** What any spend of the covenant must deliver. */
  wantAmount: bigint
  /** The leg it must deliver on. `null` is BTC, matching how the packet omits the field. */
  wantAssetId: string | null
  /** The leg the client deposits — `null` when it deposits sats. */
  offerAssetId: string | null
  makerPkScript: string
  makerPublicKey: string
  rfqId: string
  /** The co-signer key, x-only hex. Absent or null: the derivation's own. */
  emulatorPubkey?: string | null
}

export interface OfferDerivation {
  /** The Arkade signer key the covenant is compiled against. */
  serverPubkey: Uint8Array
  /** The emulator's co-signing key, x-only. @see xOnlyPubkey */
  emulatorPubkey: Uint8Array
  /** bech32 prefix for this network's Arkade addresses. */
  hrp: string
  /** The maker's solo exit leaf. @see offerExitDelay */
  exitDelay: RelativeTimelock
  /** This solver's x-only identity key, the quote's `solver_pubkey`: the directed covenant's
   * `fulfill` needs its signature. Without it a directed derivation throws. */
  taker: Uint8Array
}

/** The exit closure a client's `createOffer` defaults to, from swap 0.0.12 on.
 * The ADVERTISED delay, never `ARKADE_UNILATERAL_EXIT_DELAY`, which a client cannot
 * see. Agreement pinned by `offerAddressAgreement.test.ts`. */
export const offerExitDelay = (advertisedExitDelay: number): RelativeTimelock => {
  if (!Number.isInteger(advertisedExitDelay) || advertisedExitDelay <= 0) {
    throw new Error(
      `the Arkade Service advertises unilateralExitDelay=${advertisedExitDelay}, which no client can ` +
        `build an offer exit closure from — offers cannot be quoted against it`,
    )
  }
  const { unit } = relativeDelayFrom(advertisedExitDelay)
  // Named here; unguarded it is a bare `bip68` TypeError at the first quote.
  if (unit === 'seconds' && !isEncodableRelativeDelay(advertisedExitDelay)) {
    throw new Error(
      `the Arkade Service advertises unilateralExitDelay=${advertisedExitDelay}s, which BIP68 cannot ` +
        `encode: a seconds-typed exit closure must be a whole multiple of 512`,
    )
  }
  return { type: unit, value: BigInt(advertisedExitDelay) }
}

/**
 * The x-only spelling of a key that may arrive compressed.
 *
 * `Offer.emulatorPubkey` is 32 bytes and the emulator advertises 33; passing the
 * compressed form through compiles a DIFFERENT covenant, so the address would be
 * one no client ever derives and no deposit ever lands at.
 */
export const xOnlyPubkey = (pubkey: Uint8Array): Uint8Array => {
  // Asserted, not assumed: `slice(-32)` of a 65-byte UNCOMPRESSED key silently
  // takes the back half of Y and compiles a covenant no client derives. Every
  // current caller passes 32 or 33, so this only ever catches a new one.
  if (pubkey.length !== 32 && pubkey.length !== 33) {
    throw new Error(`pubkey must be 32 bytes x-only or 33 compressed, got ${pubkey.length}`)
  }
  return pubkey.slice(-32)
}

/** The offer these terms describe, less the script. `exitDelay` is required, not optional: omitted, the tree moves. */
export const offerFromTerms = (
  terms: Omit<QuotedOfferTerms, 'rfqId'>,
  emulatorPubkey: Uint8Array,
  exitDelay: RelativeTimelock,
  taker?: Uint8Array,
): Omit<Offer, 'swapPkScript'> => ({
  wantAmount: terms.wantAmount,
  ...(terms.wantAssetId !== null ? { wantAsset: asset.AssetId.fromString(terms.wantAssetId) } : {}),
  ...(terms.wantAssetId === null && terms.offerAssetId !== null
    ? { offerAsset: asset.AssetId.fromString(terms.offerAssetId) }
    : {}),
  makerPkScript: hex.decode(terms.makerPkScript),
  makerPublicKey: hex.decode(terms.makerPublicKey),
  emulatorPubkey,
  exitDelay,
  ...(taker ? { taker } : {}),
})

// Keep the persisted baseline independent of the SDK's default.
const derivableVersion = (id: string | undefined): AssetSwapContractVersion => {
  if (id === undefined || id === RFQ_ASSET_SWAP_V2) return RFQ_ASSET_SWAP_V2
  if (
    id === RFQ_ASSET_SWAP_DIRECTED ||
    id === RFQ_ASSET_SWAP_DIRECTED_NONCE ||
    id === RFQ_ASSET_SWAP_DIRECTED_NONCE_V2
  ) {
    return id
  }
  throw new Error(`unsupported contract version ${id}`)
}

/**
 * Bind a derivation to this deployment's keys and network.
 *
 * Curried because `AssetRfqDeps.deriveOffer` is a one-argument port: the terms
 * are the only thing that varies per quote.
 */
export const offerScriptFrom = (
  deps: OfferDerivation,
): ((
  terms: QuotedOfferTerms,
  contractVersion?: string,
) => { pkScript: string; address: string; offer: Offer; emulatorPubkey: string }) => {
  const fallback = xOnlyPubkey(deps.emulatorPubkey)
  return (terms, contractVersion) => {
    const emulatorPubkey = terms.emulatorPubkey ? xOnlyPubkey(hex.decode(terms.emulatorPubkey)) : fallback
    const version = derivableVersion(contractVersion)
    if (terms.wantAssetId !== null && terms.offerAssetId !== null && !bindsRfqNonce(version)) {
      throw new Error(`a two-asset quote requires ${NONCE_RFQ_CONTRACT_VERSIONS.join(' or ')}`)
    }
    const offer = offerFromTerms(
      terms,
      emulatorPubkey,
      deps.exitDelay,
      version === RFQ_ASSET_SWAP_V2 ? undefined : deps.taker,
    )
    if (bindsRfqNonce(version)) {
      offer.nonce = assetRfqNonce(terms.rfqId)
    }
    const script = offerVtxoScript(offer, deps.serverPubkey, version)
    // Both from the SAME compiled script: the address is what the client is
    // told and the pkScript is what the deposit is recognised by, so two
    // compilations could disagree about one covenant.
    return {
      pkScript: hex.encode(script.pkScript),
      address: script.address(deps.hrp, deps.serverPubkey).encode(),
      offer: { ...offer, swapPkScript: script.pkScript },
      emulatorPubkey: hex.encode(emulatorPubkey),
    }
  }
}
