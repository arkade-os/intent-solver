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
import { offerVtxoScript, type Offer } from '@arkade-os/swap'
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
}

/** The exit closure a client's `createOffer` defaults to, from swap 0.0.12 on.
 * The ADVERTISED delay, never `ARK_UNILATERAL_EXIT_DELAY`, which a client cannot
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
  terms: QuotedOfferTerms,
  emulatorPubkey: Uint8Array,
  exitDelay: RelativeTimelock,
): Omit<Offer, 'swapPkScript'> => ({
  wantAmount: terms.wantAmount,
  ...(terms.wantAssetId !== null ? { wantAsset: asset.AssetId.fromString(terms.wantAssetId) } : {}),
  ...(terms.offerAssetId !== null ? { offerAsset: asset.AssetId.fromString(terms.offerAssetId) } : {}),
  makerPkScript: hex.decode(terms.makerPkScript),
  makerPublicKey: hex.decode(terms.makerPublicKey),
  emulatorPubkey,
  exitDelay,
})

/**
 * Bind a derivation to this deployment's keys and network.
 *
 * Curried because `AssetRfqDeps.deriveOffer` is a one-argument port: the terms
 * are the only thing that varies per quote.
 */
export const offerScriptFrom = (
  deps: OfferDerivation,
): ((terms: QuotedOfferTerms) => { pkScript: string; address: string }) => {
  const emulatorPubkey = xOnlyPubkey(deps.emulatorPubkey)
  return (terms) => {
    const script = offerVtxoScript(offerFromTerms(terms, emulatorPubkey, deps.exitDelay), deps.serverPubkey)
    // Both from the SAME compiled script: the address is what the client is
    // told and the pkScript is what the deposit is recognised by, so two
    // compilations could disagree about one covenant.
    return { pkScript: hex.encode(script.pkScript), address: script.address(deps.hrp, deps.serverPubkey).encode() }
  }
}
