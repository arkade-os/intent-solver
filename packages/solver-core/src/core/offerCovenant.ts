/**
 * Packet-offer covenant rollout identifiers. These are not the offer TLV's
 * protocol version: v1 is the original offer tree, and v2 adds the maker's exit
 * leaf.
 *
 * An identifier is a STRING on purpose. Today it is a stable name; a later
 * covenant can use the hash of its contract, program, or compiled artifact
 * without changing the storage schema or the wire-facing config shape.
 */
export const OFFER_COVENANT_V1 = 'offer-v1'
export const OFFER_COVENANT_V2 = 'offer-v2'

export const OFFER_COVENANT_VERSIONS = [OFFER_COVENANT_V1, OFFER_COVENANT_V2] as const

export type OfferCovenantVersion = string

export const OFFER_COVENANT_VERSION_LATEST: OfferCovenantVersion = OFFER_COVENANT_V2

export interface OfferCovenantShape {
  exitDelay?: unknown
}

export const offerCovenantVersionOf = (offer: OfferCovenantShape): OfferCovenantVersion =>
  offer.exitDelay === undefined ? OFFER_COVENANT_V1 : OFFER_COVENANT_V2
