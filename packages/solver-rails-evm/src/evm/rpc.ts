/**
 * The HTTP JSON-RPC transport, and the only place in `src/evm/` that talks to a
 * network.
 *
 * Everything else here takes {@link JsonRpc} injected - the backend, the
 * broadcaster, the nonce source - which is what lets them be tested against
 * scripted responses instead of a chain. This module is the one implementation
 * of that port, so it is also the only place a malformed or hostile response can
 * be turned into a value the rest of the corridor trusts.
 *
 * It therefore refuses rather than guesses. A JSON-RPC error, an HTTP status
 * outside 2xx, a body that is not an object, or a response carrying neither
 * `result` nor `error` all throw. The alternative - returning `undefined` for any
 * of them - would reach the backend as "the lock is not funded" or reach the
 * broadcaster as a missing base fee, and both read as ordinary chain states
 * rather than as a broken connection.
 */

/** Matches {@link import('./backend.js').JsonRpc}, restated so this module imports nothing. */
export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

export interface JsonRpcDeps {
  url: string
  /**
   * How long one call may take before it is abandoned, milliseconds.
   *
   * Present because an orchestrator tick awaits these serially: a provider that
   * accepts the connection and then never answers would otherwise wedge that
   * corridor's loop indefinitely, with no log line and no recovery. Ten seconds
   * is far above any healthy `eth_call` and far below a tick anyone would wait
   * through.
   */
  timeoutMs?: number
  /** Injected so tests need no network. Defaults to the global. */
  fetch?: typeof globalThis.fetch
}

const DEFAULT_TIMEOUT_MS = 10_000

export const createJsonRpc = (deps: JsonRpcDeps): JsonRpc => {
  const { url, timeoutMs = DEFAULT_TIMEOUT_MS } = deps
  const call = deps.fetch ?? globalThis.fetch
  // Per CLIENT, not global: ids only have to be unique within one connection,
  // and a module-level counter would make two chains' clients share a sequence.
  let id = 0

  return async (method, params) => {
    id += 1
    const response = await call(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    // Read the body BEFORE checking status: providers put the useful part of a
    // rate-limit or auth failure in the body, and reporting only "429" turns a
    // one-line fix into an investigation.
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${method}: HTTP ${response.status} ${response.statusText} - ${text.slice(0, 200)}`)
    }

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      // An HTML error page from a proxy in front of the node lands here.
      throw new Error(`${method}: response was not JSON - ${text.slice(0, 200)}`)
    }
    if (typeof body !== 'object' || body === null) {
      throw new Error(`${method}: response was not a JSON-RPC object - ${text.slice(0, 200)}`)
    }

    const { result, error } = body as { result?: unknown; error?: unknown }
    if (error !== undefined && error !== null) {
      const { code, message } = error as { code?: unknown; message?: unknown }
      throw new Error(`${method}: JSON-RPC error ${String(code)} ${String(message)}`)
    }
    // `result` may legitimately be null (`eth_getBlockByNumber` on an unknown
    // block) so its ABSENCE is what is refused, not its emptiness. A response
    // with neither member is malformed, and returning undefined for it would be
    // indistinguishable downstream from a real null.
    if (!('result' in body)) {
      throw new Error(`${method}: response carried neither result nor error - ${text.slice(0, 200)}`)
    }
    return result
  }
}
