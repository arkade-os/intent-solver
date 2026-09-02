import { describe, it, expect, vi, afterEach } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { createEsploraClient, spenderOf, type EsploraClient } from '@arkade-os/solver-rails-esplora/esplora.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('createEsploraClient', () => {
  it('broadcast() POSTs the raw hex to /tx and returns the txid', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://esplora.example/api/tx')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('deadbeef')
      return new Response('abc123txid', { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createEsploraClient('https://esplora.example/api')
    await expect(client.broadcast('deadbeef')).resolves.toEqual({ txid: 'abc123txid' })
  })

  it('broadcast() throws with the response body on a non-2xx status', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('bad-txn-inputs-missingorspent', { status: 400 }),
    ) as unknown as typeof fetch
    const client = createEsploraClient('https://esplora.example/api')
    await expect(client.broadcast('deadbeef')).rejects.toThrow(/bad-txn-inputs-missingorspent/)
  })

  it('getAddressTxs() GETs /address/:address/txs and parses the JSON', async () => {
    const payload = [{ txid: 't1', status: { confirmed: true, block_height: 100 }, vout: [], vin: [] }]
    globalThis.fetch = vi.fn(async (url: string) => {
      expect(url).toBe('https://esplora.example/api/address/bcrt1pexample/txs')
      return new Response(JSON.stringify(payload), { status: 200 })
    }) as unknown as typeof fetch

    const client = createEsploraClient('https://esplora.example/api')
    await expect(client.getAddressTxs('bcrt1pexample')).resolves.toEqual([
      { txid: 't1', confirmed: true, blockHeight: 100, vout: [], vin: [] },
    ])
  })

  it('getJson() parses an arbitrary endpoint, so callers need no fetch of their own', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ spent: true, vin: 0 }), { status: 200 }),
    ) as unknown as typeof fetch
    const client = createEsploraClient('https://esplora.example/api')
    await expect(client.getJson('/tx/abc/outspend/0')).resolves.toEqual({ spent: true, vin: 0 })
  })

  it('getText() and getJson() throw on a non-2xx rather than returning an empty answer', async () => {
    // The reason these live here rather than in each caller: an unspent output
    // and a down indexer must never look the same to the claim watcher.
    globalThis.fetch = vi.fn(async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch
    const client = createEsploraClient('https://esplora.example/api')
    await expect(client.getJson('/tx/abc/outspend/0')).rejects.toThrow(/502/)
    await expect(client.getText('/blocks/tip/height')).rejects.toThrow(/502/)
  })

  it('sends HTTP Basic Auth when credentials are configured', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('esplora-user:secret')}`)
      return new Response('txid', { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createEsploraClient('https://esplora.example/api', { username: 'esplora-user', password: 'secret' })
    await client.broadcast('deadbeef')
  })

  it('carries the credentials on getJson/getText too, not just the named endpoints', async () => {
    // Callers reach the other endpoints through these, so if they dropped the
    // auth header half a deployment's requests would 401 on regtest — which is
    // precisely what happened while those callers built their own fetches.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('Authorization')).toBe(`Basic ${btoa('esplora-user:secret')}`)
      return new Response('820000', { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = createEsploraClient('https://esplora.example/api', { username: 'esplora-user', password: 'secret' })
    await client.getText('/blocks/tip/height')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

/**
 * Who spent an output, as far as a chain API will say.
 *
 * Three answers, never two. The third — "spent, and I will not tell you by
 * what" — is the one that kept getting collapsed into `null`, and `null` means
 * DEFINITIVELY UNSPENT to every caller: `whenRefundingOnchain` reads it and
 * broadcasts the solver's refund against an output something already took.
 *
 * Two API shapes, both real and both measured on the regtest stack:
 *
 *   Electrs / a real Esplora -> `/tx/:txid/outspend/:vout` names the spender
 *   mempool.space            -> 404s that with HTML; `/outspends` answers
 *                               `{"spent": true}` and nothing more
 */
describe('spenderOf', () => {
  const fake = (json: Record<string, unknown>): EsploraClient =>
    ({
      getJson: async (path: string) => {
        if (!(path in json)) throw new Error(`esplora GET ${path} failed (404)`)
        return json[path]
      },
    }) as unknown as EsploraClient

  it('reads a named spender from the singular endpoint', async () => {
    const client = fake({ '/tx/aa/outspend/1': { spent: true, txid: 'bb', vin: 3 } })
    expect(await spenderOf(client, 'aa', 1)).toEqual({ txid: 'bb', vin: 3 })
  })

  it('takes an explicit spent:false as a real answer', async () => {
    const client = fake({ '/tx/aa/outspend/1': { spent: false } })
    expect(await spenderOf(client, 'aa', 1)).toBe('unspent')
  })

  it('falls back to the plural endpoint when the singular one 404s', async () => {
    // The singular throwing is not an answer — it is a reason to ask again.
    const client = fake({ '/tx/aa/outspends': [{ spent: false }, { spent: false }] })
    expect(await spenderOf(client, 'aa', 1)).toBe('unspent')
  })

  it('indexes the plural response by vout, not by position in a filtered list', async () => {
    const client = fake({ '/tx/aa/outspends': [{ spent: true, txid: 'zz', vin: 0 }, { spent: false }] })
    expect(await spenderOf(client, 'aa', 1)).toBe('unspent')
    expect(await spenderOf(client, 'aa', 0)).toEqual({ txid: 'zz', vin: 0 })
  })

  it('says spent-by-unknown when the API confirms a spend but names nothing', async () => {
    // NOT unspent. This is the whole reason the type has three cases — and with
    // no output script to search on, this is as far as it can get.
    const client = fake({ '/tx/aa/outspends': [{ spent: false }, { spent: true }] })
    expect(await spenderOf(client, 'aa', 1)).toBe('spent-by-unknown')
  })

  describe('given the output script, it finds the spender the outspends call would not name', () => {
    // The script's own transaction history contains the SPENDING transaction —
    // it is an input there. So an API that answers `{"spent": true}` and nothing
    // else can still be made to give up the spender, and with it the preimage.
    //
    // Measured against the regtest Esplora rather than assumed: the forward
    // sha256 answered with both transactions and the REVERSED one answered
    // zero. Deployments differ on this, so both are tried.
    const script = new Uint8Array([0x51, 0x20, 0xab])
    // The real hashes, computed the same way the code must — so these tests
    // pin the byte order itself, not a constant copied out of the source.
    const forward = hex.encode(sha256(script))
    const reversed = hex.encode(Uint8Array.from(sha256(script)).reverse())
    const spendingTx = {
      txid: 'spender-tx',
      vin: [
        { txid: 'other', vout: 9 },
        { txid: 'aa', vout: 1 },
      ],
    }

    it('names it from the script history when outspends will not', async () => {
      const client = fake({
        '/tx/aa/outspends': [{ spent: false }, { spent: true }],
        [`/scripthash/${forward}/txs`]: [spendingTx],
      })
      expect(await spenderOf(client, 'aa', 1, script)).toEqual({ txid: 'spender-tx', vin: 1 })
    })

    it('tries the other byte order when the first comes back empty', async () => {
      // An empty array is not a 404 and must not end the search: a deployment
      // that indexes the other order answers 200 with nothing in it.
      const client = fake({
        '/tx/aa/outspends': [{ spent: false }, { spent: true }],
        [`/scripthash/${reversed}/txs`]: [spendingTx],
      })
      expect(await spenderOf(client, 'aa', 1, script)).toEqual({ txid: 'spender-tx', vin: 1 })
    })

    it('accepts only a transaction that really spends THIS outpoint', async () => {
      // The search validates its own answer against the outpoint, which is what
      // makes trying two byte orders safe: a response from the wrong index — or
      // one spending the same script's OTHER outputs — matches nothing.
      const client = fake({
        '/tx/aa/outspends': [{ spent: false }, { spent: true }],
        [`/scripthash/${forward}/txs`]: [
          { txid: 'unrelated', vin: [{ txid: 'aa', vout: 0 }] },
          { txid: 'also-no', vin: [{ txid: 'bb', vout: 1 }] },
        ],
      })
      expect(await spenderOf(client, 'aa', 1, script)).toBe('spent-by-unknown')
    })

    it('still says spent-by-unknown, never unspent, when the history reveals nothing', async () => {
      // The fallback failing must not soften the answer. It is still spent.
      const client = fake({ '/tx/aa/outspends': [{ spent: false }, { spent: true }] })
      expect(await spenderOf(client, 'aa', 1, script)).toBe('spent-by-unknown')
    })

    it('does not reach for the history when outspends already named the spender', async () => {
      // One request, not three, on the deployments that answer properly.
      let history = 0
      const client = {
        getJson: async (path: string) => {
          if (path.startsWith('/scripthash/')) {
            history += 1
            return []
          }
          if (path === '/tx/aa/outspend/1') return { spent: true, txid: 'bb', vin: 3 }
          throw new Error('404')
        },
      } as unknown as EsploraClient
      expect(await spenderOf(client, 'aa', 1, script)).toEqual({ txid: 'bb', vin: 3 })
      expect(history).toBe(0)
    })
  })

  it('REFUSES to call a vout past the end of the plural response unspent', async () => {
    // A short array does not describe this output, so nothing has been learned
    // about it. Reading that as `unspent` is the very conflation this function
    // exists to remove — a truncated response would license a refund against an
    // output that may already be spent. `unspent` has to come from a real
    // `spent: false`, never from an absent entry.
    const client = fake({ '/tx/aa/outspends': [{ spent: true, txid: 'zz', vin: 0 }] })
    await expect(spenderOf(client, 'aa', 5)).rejects.toThrow(/no entry for output 5|does not describe/i)
  })

  it('propagates a transport failure rather than calling it unspent', async () => {
    // Both endpoints unreachable is not evidence about the output.
    const client = fake({})
    await expect(spenderOf(client, 'aa', 1)).rejects.toThrow(/failed/i)
  })
})
