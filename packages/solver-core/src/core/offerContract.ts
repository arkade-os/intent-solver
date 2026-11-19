/**
 * Packet-offer contract version identifiers. These are not the offer TLV's
 * protocol version: v1 is the original offer tree, and v2 adds the maker's exit
 * leaf.
 *
 * An identifier is a STRING on purpose. Today it is a stable name; a later
 * contract can use the hash of its contract, program, or compiled artifact
 * without changing the storage schema or the wire-facing config shape.
 */
export const OFFER_CONTRACT_V1 = 'offer-v1'
export const OFFER_CONTRACT_V2 = 'offer-v2'

export const OFFER_CONTRACT_VERSIONS = [OFFER_CONTRACT_V1, OFFER_CONTRACT_V2] as const

export type OfferContractVersion = string

export const OFFER_CONTRACT_VERSION_LATEST: OfferContractVersion = OFFER_CONTRACT_V2

export interface OfferContractShape {
  exitDelay?: object
}

export const offerContractVersionOf = (offer: OfferContractShape): OfferContractVersion =>
  offer.exitDelay === undefined ? OFFER_CONTRACT_V1 : OFFER_CONTRACT_V2
