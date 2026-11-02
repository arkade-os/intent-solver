/**
 * Packet-offer covenant rollout labels. These are not the offer TLV's protocol
 * version: v1 is the original offer tree, and v2 adds the maker's exit leaf.
 */
export const OFFER_COVENANT_VERSIONS = [1, 2] as const

export type OfferCovenantVersion = (typeof OFFER_COVENANT_VERSIONS)[number]

export const OFFER_COVENANT_VERSION_LATEST: OfferCovenantVersion = 2

export interface OfferCovenantShape {
  exitDelay?: unknown
}

export const offerCovenantVersionOf = (offer: OfferCovenantShape): OfferCovenantVersion =>
  offer.exitDelay === undefined ? 1 : 2
