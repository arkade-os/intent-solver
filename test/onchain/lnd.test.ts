import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { Transaction, p2wpkh } from '@scure/btc-signer'
import { hex } from '@scure/base'

// findSpendWitness wraps `lightning`'s subscribeToChainSpend (a push
// subscription, not a request/response call) — module-mocked so a test can
// drive its events directly, the same way wallet.test.ts module-mocks
// @arkade-os/sdk's RestEmulatorProvider for the same reason (constructed
// internally, not injected).
const { subscribeToChainSpend, createChainAddress } = vi.hoisted(() => ({
  subscribeToChainSpend: vi.fn(),
  createChainAddress: vi.fn(),
}))
vi.mock('lightning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('lightning')>()
  return {
    ...actual,
    authenticatedLndGrpc: vi.fn(() => ({ lnd: {} })),
    // `current_block_height` is the chain tip findOutputs derives confirmations
    // from — LND stays the single source of truth for the tip, not Esplora.
    getWalletInfo: vi.fn(async () => ({ current_block_height: 102 })),
    subscribeToChainSpend,
    createChainAddress,
  }
})

const { LndOnchainAdapter } = await import('@arkade-os/solver-rails-lnd/onchain/lnd/adapter.js')

describe('LndOnchainAdapter.findOutputs', () => {
  const address = 'bcrt1pexample'
  const config = { socket: 's', cert: 'c', macaroon: 'm', esploraUrl: 'http://esplora.test' }

  const withEsplora = async (txs: unknown[]) => {
    const adapter = await LndOnchainAdapter.create(config)
    // The Esplora client is constructed inside `create`, so reach past it the
    // same way the rest of this file reaches past `lightning`: replace the
    // one method under test rather than standing up an HTTP server.
    ;(adapter as unknown as { esplora: { getAddressTxs: unknown } }).esplora = {
      getAddressTxs: async () => txs,
    }
    return adapter
  }

  it('reports the OUTPUT value, not the transaction total', async () => {
    // The exact defect this replaced: LND reported `tokens: 50156` (amount +
    // its 156-sat fee) for a 50 000-sat payment, so the orchestrator's exact
    // `valueSats === amountSats` match could never succeed.
    const adapter = await withEsplora([
      {
        txid: 't1',
        confirmed: true,
        blockHeight: 100,
        vout: [
          { scriptpubkey_address: 'bcrt1pother', value: 156 },
          { scriptpubkey_address: address, value: 50_000 },
        ],
        vin: [],
      },
    ])
    expect(await adapter.findOutputs({ address })).toEqual([
      { txid: 't1', vout: 1, valueSats: 50_000, confirmations: 3 },
    ])
  })

  it('sees a third party’s funding transaction, which the wallet-scoped view could not', async () => {
    const adapter = await withEsplora([
      {
        txid: 'client-tx',
        confirmed: false,
        blockHeight: null,
        vout: [{ scriptpubkey_address: address, value: 7 }],
        vin: [],
      },
    ])
    expect(await adapter.findOutputs({ address })).toEqual([
      { txid: 'client-tx', vout: 0, valueSats: 7, confirmations: 0 },
    ])
  })

  it('ignores transactions that do not pay the address', async () => {
    const adapter = await withEsplora([
      {
        txid: 't1',
        confirmed: true,
        blockHeight: 100,
        vout: [{ scriptpubkey_address: 'bcrt1pother', value: 1 }],
        vin: [],
      },
    ])
    expect(await adapter.findOutputs({ address })).toEqual([])
  })

  it('refuses to guess when no Esplora URL is configured, rather than under-reporting', async () => {
    const adapter = await LndOnchainAdapter.create({ socket: 's', cert: 'c', macaroon: 'm' })
    await expect(adapter.findOutputs({ address })).rejects.toThrow(/Esplora URL/)
  })
})

describe('LndOnchainAdapter.newReceiveAddress', () => {
  beforeEach(() => {
    createChainAddress.mockReset()
  })

  it("returns an address from the node's OWN onchain wallet, via LND's newAddress RPC", async () => {
    createChainAddress.mockResolvedValue({ address: 'bcrt1qsolverownwallet' })
    const lnd = await LndOnchainAdapter.create({ socket: 'x', cert: 'y', macaroon: 'z' })

    await expect(lnd.newReceiveAddress()).resolves.toBe('bcrt1qsolverownwallet')
    // The authenticated handle, and no format override — the reclaimed funds
    // must come back to the same wallet sendToChainAddress paid the HTLC from.
    expect(createChainAddress).toHaveBeenCalledWith({ lnd: {} })
  })
})

describe('LndOnchainAdapter.findSpendWitness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscribeToChainSpend.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const config = { socket: 'x', cert: 'y', macaroon: 'z', esploraUrl: 'http://esplora.test' }

  /**
   * An adapter whose Esplora answers a scripted map of path -> value, and
   * throws for anything unscripted.
   *
   * Two shapes matter and both are exercised below: a real Esplora serves
   * `/outspend/:vout` and NAMES the spender; the mempool.space deployments
   * 404 that and answer `/outspends` with `{"spent": true}` and nothing else.
   */
  const withEsplora = async (json: Record<string, unknown>, text: Record<string, string> = {}) => {
    const adapter = await LndOnchainAdapter.create(config)
    ;(adapter as unknown as { esplora: unknown }).esplora = {
      getJson: async (path: string) => {
        if (!(path in json)) throw new Error(`esplora GET ${path} failed (404)`)
        return json[path]
      },
      getText: async (path: string) => {
        if (!(path in text)) throw new Error(`esplora GET ${path} failed (404)`)
        return text[path]
      },
    }
    return adapter
  }

  const rawTxHexSpending = (): string => {
    const priv = secp256k1.utils.randomSecretKey()
    const pub = secp256k1.getPublicKey(priv, true)
    const addr = p2wpkh(pub)
    const tx = new Transaction()
    tx.addInput({ txid: new Uint8Array(32).fill(1), index: 0, witnessUtxo: { script: addr.script, amount: 100_000n } })
    tx.addOutputAddress(addr.address, 90_000n)
    tx.sign(priv)
    tx.finalize()
    return hex.encode(tx.extract())
  }

  const outpoint = { txid: 'f'.repeat(64), vout: 1, outputScript: new Uint8Array() }

  it('returns null only when the chain API says the output is UNSPENT', async () => {
    // The one answer that licenses a refund, so it must come from a real
    // `spent: false` and never from a lookup that simply failed.
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspend/1`]: { spent: false } })
    expect(await adapter.findSpendWitness(outpoint)).toBeNull()
  })

  it('reads the witness straight from an Esplora that names the spender', async () => {
    const raw = rawTxHexSpending()
    const adapter = await withEsplora(
      { [`/tx/${outpoint.txid}/outspend/1`]: { spent: true, txid: 'abc', vin: 0 } },
      { '/tx/abc/hex': raw },
    )
    expect(await adapter.findSpendWitness(outpoint)).toHaveLength(2)
  })

  it('falls back to the plural endpoint when the singular one is absent', async () => {
    // mempool.space 404s `/outspend/:vout` with HTML, which makes `getJson`
    // throw — that is a reason to ask the other way, not an answer.
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: false }] })
    expect(await adapter.findSpendWitness(outpoint)).toBeNull()
  })

  it('asks lnd for the witness when the chain API knows it is spent but not by what', async () => {
    // lnd is the only source that hands back the whole raw spending
    // transaction, which is what makes the preimage readable.
    const sub = new EventEmitter()
    subscribeToChainSpend.mockReturnValue(sub)
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: true }] })

    const promise = adapter.findSpendWitness(outpoint)
    await vi.advanceTimersByTimeAsync(0)
    sub.emit('confirmation', { transaction: rawTxHexSpending(), vin: 0 })
    expect(await promise).toHaveLength(2)
  })

  it('THROWS when the output is spent and no source will name the spender', async () => {
    // Never null. `whenRefundingOnchain` reads null as "nobody took this" and
    // broadcasts the solver's refund — against an output something already
    // spent, whose witness may carry the preimage we needed.
    const sub = new EventEmitter()
    subscribeToChainSpend.mockReturnValue(sub)
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: true }] })

    // The rejection handler has to be attached BEFORE the timers advance. The
    // 5s timeout is what makes this reject, so it rejects *inside*
    // `advanceTimersByTimeAsync` — and a promise that rejects with no handler
    // attached at that instant is an unhandled rejection, which fails the run
    // even though every assertion here passes. Both expressions below are
    // evaluated before either is awaited.
    const promise = adapter.findSpendWitness(outpoint)
    await Promise.all([
      expect(promise).rejects.toThrow(/already spent.*does not name the spending/is),
      vi.advanceTimersByTimeAsync(5_000),
    ])
  })

  it('propagates a subscription error instead of hanging forever', async () => {
    // Restored from main. If this reject path broke, `findSpendWitness` would
    // never settle at all — the refund poller would hang rather than fail,
    // which is far harder to notice than an error.
    const sub = new EventEmitter()
    subscribeToChainSpend.mockReturnValue(sub)
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: true }] })

    const promise = adapter.findSpendWitness(outpoint)
    const assertion = expect(promise).rejects.toThrow('subscription failed')
    await vi.advanceTimersByTimeAsync(0)
    sub.emit('error', new Error('subscription failed'))
    await assertion
  })

  it('tears the subscription down when it times out, rather than leaking a listener per lookup', async () => {
    // Restored from main, with the outcome updated: the timeout used to resolve
    // null and now falls through to the throw. The teardown it asserted still
    // matters — this call is polled for every in-flight onchain swap.
    const sub = new EventEmitter()
    const removeAllListeners = vi.spyOn(sub, 'removeAllListeners')
    subscribeToChainSpend.mockReturnValue(sub)
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: true }] })

    const promise = adapter.findSpendWitness(outpoint)
    await Promise.all([expect(promise).rejects.toThrow(/already spent/i), vi.advanceTimersByTimeAsync(5_000)])
    expect(removeAllListeners).toHaveBeenCalledOnce()
  })

  it('subscribes with min_height 1, never 0 — the underlying call falsy-checks it and throws', async () => {
    // Restored from main: this moved into the private `witnessFromLndSpend`
    // during the refactor and lost its coverage on the way. The `lightning`
    // library falsy-checks `min_height`, so a 0 there throws rather than
    // meaning "from genesis" — a footgun worth keeping pinned. Reaching the
    // subscription now needs Esplora to say spent-by-unknown first.
    const sub = new EventEmitter()
    subscribeToChainSpend.mockReturnValue(sub)
    const adapter = await withEsplora({ [`/tx/${outpoint.txid}/outspends`]: [{ spent: false }, { spent: true }] })

    const promise = adapter.findSpendWitness(outpoint)
    const settled = promise.catch(() => {}) // handler attached before it can reject
    await vi.advanceTimersByTimeAsync(0)
    expect(subscribeToChainSpend).toHaveBeenCalledWith(
      expect.objectContaining({ transaction_id: outpoint.txid, transaction_vout: 1, min_height: 1 }),
    )
    sub.emit('error', new Error('cleanup')) // let the pending promise settle
    await settled
  })

  it('refuses without an Esplora URL rather than guessing from lnd alone', async () => {
    // lnd never fires for an unspent output, so a subscription cannot tell
    // "unspent" from "not yet". `findOutputs` already refuses for the same
    // underlying reason: an HTLC is a third-party output lnd does not own.
    const adapter = await LndOnchainAdapter.create({ socket: 'x', cert: 'y', macaroon: 'z' })
    await expect(adapter.findSpendWitness(outpoint)).rejects.toThrow(/needs an Esplora URL/i)
  })
})

/**
 * The rule the port states and every adapter has to keep: `null` means
 * DEFINITIVELY UNSPENT. `whenRefundingOnchain` reads null and broadcasts the
 * solver's refund, so an adapter that answers null when it merely failed to
 * find out is routing the solver into the loss that branch's own comment
 * describes.
 */
describe('the findSpendWitness contract, across adapters', () => {
  it('is written down in the port, not just implemented in one adapter', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const port = readFileSync(
      fileURLToPath(new URL('../../packages/solver-core/src/ports/onchain.ts', import.meta.url)),
      'utf8',
    )
    expect(port).toMatch(/definitively unspent/i)
    expect(port).toMatch(/THROW instead|throw instead/i)
  })

  it('routes every adapter through the one three-way lookup', () => {
    // The conflation `if (!spent || !txid || vin === undefined) return null`
    // shipped once per adapter, because each wrote its own. One helper, one
    // place to get it right — and this loop is what keeps a rail added later
    // from writing a fourth copy.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { fileURLToPath } = require('node:url') as typeof import('node:url')
    for (const rel of ['../../packages/solver-rails-lnd/src/onchain/lnd/adapter.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
      const body = src.slice(src.indexOf('async findSpendWitness')).slice(0, 1500)
      expect(body, rel).toContain('spenderOf(')
      // The old shape, gone.
      expect(body, rel).not.toMatch(/vin === undefined\) return null/)
    }
  })

  it('keeps the lookup mempool-inclusive, which is where P comes from', () => {
    // `spent` is true for an UNCONFIRMED spend. If this ever started filtering
    // on `status.confirmed`, the solver would stop learning the preimage until
    // a block — losing most of its claim window.
    //
    // Checked against the CODE with comments stripped, not the raw text. The
    // first cut matched prose, and the word appears legitimately in the
    // explanation of why mempool.space's answer is useless "even once
    // confirmed" — so documenting the behaviour correctly failed the test
    // guarding it.
    const { readFileSync } = require('node:fs') as typeof import('node:fs')
    const { fileURLToPath } = require('node:url') as typeof import('node:url')
    const esplora = readFileSync(
      fileURLToPath(new URL('../../packages/solver-rails-esplora/src/esplora.ts', import.meta.url)),
      'utf8',
    )
    // The slice ends at the lookup's own region: the vendor-neutral helpers
    // moved to the same file carry `confirmations` as a VALUE (their output
    // counts blocks), which is a different fact from a confirmation GATE.
    const start = esplora.indexOf('export const spenderOf')
    const end = esplora.indexOf('export const toFundedOutputs')
    const fn = esplora.slice(start, end === -1 ? undefined : end)
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('confirmed')
  })
})
