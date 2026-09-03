/**
 * Hand-written declarations for rfq-core.mjs — the portable RFQ protocol core.
 * Kept adjacent so TypeScript consumers (including this repo's tests) get the
 * API without a build step. Shapes mirror docs/rfq-protocol.md.
 */

export declare const RFQ_PAIR_SEND: string
export declare const MIN_HEADROOM_SECONDS: number
export declare const TERMINAL_STATES: readonly string[]

export declare class SwapRefusal extends Error {
  reason: string
  rfqId: string | undefined
  constructor(reason: string, rfqId?: string)
}

export declare class AddressMismatch extends Error {
  derived: string | string[]
  quoted: string | undefined
  constructor(derived: string | string[], quoted?: string)
}

export interface RfqQuote {
  v: 1
  type: 'rfq_quote'
  rfq_id: string
  pair: string
  from_amount: number
  to_amount: number
  solver_pubkey: string
  valid_until: number
  refund_locktime: number
  profile: { payment_hash: string; lockup_address: string; [key: string]: unknown }
  [key: string]: unknown
}

export interface RfqStatus {
  v: 1
  type: 'rfq_status'
  rfq_id: string
  state: string
  updated_at: number
  profile: Record<string, unknown>
  [key: string]: unknown
}

export interface RfqTransport {
  requestQuote(payload: Record<string, unknown>): Promise<RfqQuote>
  status(rfqId: string): Promise<RfqStatus | null>
  close(): Promise<void>
}

export declare const newRfqId: () => string

export declare const buildSendRequest: (input: {
  rfqId: string
  invoice: string
  refundAddress: string
  clientRefundPubkey: string
}) => Record<string, unknown>

/**
 * `derivedAddress` may be a single candidate or several — see the
 * implementation's own doc comment for why more than one may be needed
 * (docs/rfq-protocol.md § 7.1.1.1: nothing on the wire says whether a quote's
 * covenant carries the timelocked non-interactive refund leaf).
 */
export declare const verifyLockupAddress: (quote: RfqQuote, derivedAddress: string | string[]) => string

export declare const assertFundable: (input: {
  quote: RfqQuote
  invoiceExpiresAt: number
  now: number
  /**
   * The most this client will pay, as the GREATER of a proportion of
   * `from_amount` and an absolute number of sats. Absent gates nothing, which
   * is what every caller written before this got.
   *
   * Mirrors `@arkade-os/swap`'s `assertFundable` deliberately: the shipped
   * client and this reference must not disagree about a money gate, which is
   * the drift `test/interop/clientGates.test.ts` exists to catch. See that
   * implementation for why BOTH bounds are needed and why a cross-asset pair
   * is refused rather than skipped.
   */
  maxFee?: { bps?: number; sats?: number }
}) => void

/**
 * A reply is OUR quote, or it throws — `SwapRefusal` when the solver refused,
 * a plain `Error` when the payload is neither that nor a quote for `rfqId`.
 *
 * Declared late. It has been exported from the implementation since the Nostr
 * transport needed it, and this file never said so; nothing noticed because
 * nothing typechecked the example that imports it.
 */
export declare const expectQuote: (payload: unknown, rfqId: string) => RfqQuote

export declare const httpTransport: (
  baseUrl: string,
  options?: { fetchImpl?: (url: string, init?: RequestInit) => Promise<Response> },
) => RfqTransport

export declare const relayTransport: (
  relayUrl: string,
  options: {
    solverPubkey: string
    clientPubkey: string
    WebSocketCtor?: new (url: string) => WebSocket
    timeoutMs?: number
  },
) => RfqTransport

export declare const requestQuote: (
  transport: RfqTransport,
  input: { invoice: string; refundAddress: string; clientRefundPubkey: string; rfqId?: string },
) => Promise<RfqQuote>

export declare const pollStatus: (
  transport: RfqTransport,
  rfqId: string,
  options?: { pollMs?: number; maxAttempts?: number; onStatus?: (status: RfqStatus) => void },
) => Promise<RfqStatus | null>
