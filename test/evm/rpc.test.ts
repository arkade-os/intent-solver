/**
 * The one place in `src/evm/` that talks to a network, and therefore the one
 * place a malformed answer can become a value the corridor trusts.
 *
 * Every refusal below has the same shape of consequence: returning `undefined`
 * instead of throwing reaches the backend as "the lock is not funded" or the
 * broadcaster as a missing base fee - both indistinguishable from ordinary
 * chain states, neither of them true.
 */

import { describe, it, expect, vi } from 'vitest'
import { createJsonRpc } from '@arkade-os/solver-rails-evm/evm/rpc.js'

const respond = (body: unknown, init: { status?: number; statusText?: string; text?: string } = {}) =>
  vi.fn().mockResolvedValue({
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    text: async () => init.text ?? JSON.stringify(body),
  } as unknown as Response)

describe('the happy path', () => {
  it('returns the result member', async () => {
    const fetch = respond({ jsonrpc: '2.0', id: 1, result: '0x2a' })
    expect(await createJsonRpc({ url: 'http://node', fetch })('eth_blockNumber', [])).toBe('0x2a')
  })

  it('posts a well-formed JSON-RPC envelope carrying the method and params', async () => {
    const fetch = respond({ result: '0x1' })
    await createJsonRpc({ url: 'http://node', fetch })('eth_call', [{ to: '0xabc' }, 'latest'])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://node')
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      jsonrpc: '2.0',
      method: 'eth_call',
      params: [{ to: '0xabc' }, 'latest'],
    })
  })

  it('gives each call its own id, so responses cannot be mismatched', async () => {
    const fetch = respond({ result: '0x1' })
    const rpc = createJsonRpc({ url: 'http://node', fetch })
    await rpc('eth_blockNumber', [])
    await rpc('eth_blockNumber', [])
    const ids = fetch.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).id)
    expect(new Set(ids).size).toBe(2)
  })

  it('counts ids per client, not globally', async () => {
    // Two chains' clients sharing a module-level counter would be a surprise
    // when reading a trace; nothing depends on it, so it is pinned cheaply.
    const first = respond({ result: '0x1' })
    const second = respond({ result: '0x1' })
    await createJsonRpc({ url: 'http://a', fetch: first })('eth_blockNumber', [])
    await createJsonRpc({ url: 'http://b', fetch: second })('eth_blockNumber', [])
    const idOf = (f: typeof first) => JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).id
    expect(idOf(first)).toBe(idOf(second))
  })

  it('passes a null result through, since an unknown block legitimately answers null', async () => {
    const fetch = respond({ result: null })
    expect(await createJsonRpc({ url: 'http://node', fetch })('eth_getBlockByNumber', ['0x99', false])).toBeNull()
  })
})

describe('refusals', () => {
  it('throws on a JSON-RPC error, naming the code and message', async () => {
    const fetch = respond({ error: { code: -32000, message: 'header not found' } })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(
      /-32000.*header not found/,
    )
  })

  it('throws on a non-2xx status and includes the BODY, not just the code', async () => {
    // A rate-limit or auth failure puts the actionable part in the body.
    const fetch = respond(null, { status: 429, statusText: 'Too Many Requests', text: 'daily quota exceeded' })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(
      /429.*daily quota exceeded/,
    )
  })

  it('throws when the body is not JSON at all', async () => {
    // An HTML error page from a proxy in front of the node.
    const fetch = respond(null, { text: '<html>502 Bad Gateway</html>' })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(/not JSON/)
  })

  it('throws when the body is JSON but not an object', async () => {
    const fetch = respond(null, { text: '"just a string"' })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(/not a JSON-RPC object/)
  })

  it('throws when the response carries NEITHER result nor error', async () => {
    // The subtle one: returning undefined here is indistinguishable downstream
    // from a real null result, which reads as an ordinary chain state.
    const fetch = respond({ jsonrpc: '2.0', id: 1 })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(
      /neither result nor error/,
    )
  })

  it('prefers the error member over a result when a server sends both', async () => {
    const fetch = respond({ result: '0xdeadbeef', error: { code: -32000, message: 'reverted' } })
    await expect(createJsonRpc({ url: 'http://node', fetch })('eth_call', [])).rejects.toThrow(/reverted/)
  })
})

describe('the timeout', () => {
  it('abandons a call the provider accepts but never answers', async () => {
    // A hung provider would otherwise wedge the corridor's tick loop with no log
    // line and no recovery.
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('TimeoutError')))
        }),
    ) as unknown as typeof globalThis.fetch
    await expect(createJsonRpc({ url: 'http://node', fetch, timeoutMs: 20 })('eth_blockNumber', [])).rejects.toThrow()
  })

  it('attaches an abort signal to every request', async () => {
    const fetch = respond({ result: '0x1' })
    await createJsonRpc({ url: 'http://node', fetch })('eth_blockNumber', [])
    expect((fetch.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })
})
