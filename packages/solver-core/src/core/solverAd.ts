/**
 * The kind-38859 solver advertisement (docs/rfq-protocol.md § 3).
 *
 * NOT the solver-registry corridor card (`registryCard.ts`). They share a key
 * model — the card's `discovery_pubkey` is the pubkey RFQ traffic is addressed
 * to — but they are different documents with different audiences: the card is
 * git-reviewed into `arkade-os/solver-registry`, the ad is published to relays
 * for machine discovery. Both are indicative; neither is terms.
 */

export interface SolverAdPair {
  pair: string
  min: number
  max: number
  feeBpsIndicative: number
  feeFlatIndicative: number
  quoteValiditySeconds: number
}

export interface SolverAdInputs {
  pairs: SolverAdPair[]
  relays: string[]
}

export interface SolverAd {
  v: 1
  type: 'solver_ad'
  pairs: Array<Record<string, unknown>>
  relays: string[]
}

export const buildSolverAd = (inputs: SolverAdInputs): SolverAd => ({
  v: 1,
  type: 'solver_ad',
  pairs: inputs.pairs.map((p) => ({
    pair: p.pair,
    min: p.min,
    max: p.max,
    fee_bps_indicative: p.feeBpsIndicative,
    // Omitted means zero (§ 3). Emitting an explicit 0 says the same thing in
    // a different document, and would change the digest for no change in terms.
    ...(p.feeFlatIndicative > 0 ? { fee_flat_indicative: p.feeFlatIndicative } : {}),
    quote_validity_s_typical: p.quoteValiditySeconds,
  })),
  relays: [...inputs.relays],
})
