/**
 * Covenant identifiers for the RFQ swap methods.
 *
 * The RFQ envelope has its own integer protocol version (`v`). This is a
 * different axis: which settlement contract/program an RFQ method compiles to.
 * The identifiers are strings so a method can use a stable name today and a
 * content hash of its contract, program or compiled artifact later without a
 * schema or storage migration.
 */
export const RFQ_LIGHTNING_SEND_V2 = 'lightning-send-v2'
export const RFQ_LIGHTNING_RECEIVE_V2 = 'lightning-receive-v2'
export const RFQ_ONCHAIN_SEND_V2 = 'onchain-send-v2'
export const RFQ_ASSET_SWAP_V2 = 'asset-swap-v2'
export const RFQ_EVM_SEND_V1 = 'evm-send-v1'
export const RFQ_EVM_RECEIVE_V1 = 'evm-receive-v1'

/** The versions this build serves when `rfq.covenantVersions` is unset. */
export const RFQ_COVENANT_VERSIONS = [
  RFQ_LIGHTNING_SEND_V2,
  RFQ_LIGHTNING_RECEIVE_V2,
  RFQ_ONCHAIN_SEND_V2,
  RFQ_ASSET_SWAP_V2,
  RFQ_EVM_SEND_V1,
  RFQ_EVM_RECEIVE_V1,
] as const

/**
 * A config-safe version identifier: a name, a content hash, or an
 * `algorithm:digest` spelling. Commas are excluded because the env form is a
 * comma-separated list.
 */
export const RFQ_COVENANT_VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export type RfqCovenantVersion = string

/** Whether a version is served: the operator's list when one is set (non-null), else this build's defaults. */
export const rfqCovenantEnabled = (configured: readonly string[] | null, version: string): boolean =>
  (configured ?? (RFQ_COVENANT_VERSIONS as readonly string[])).includes(version)
