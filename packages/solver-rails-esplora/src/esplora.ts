/**
 * A plain Esplora HTTP REST client — broadcast, address history, and a checked
 * GET for everything else. NOT raw Electrum TCP/JSON-RPC: what a backend calls
 * an "electrs URL" is usually this same plain HTTP API, the convention
 * `mempool.space`, `blockstream.info`, and any self-hosted `esplora` instance
 * all share.
 *
 * `fetch`-only, so this is Cloudflare Workers-compatible, unlike a raw TCP
 * Electrum client would be.
 *
 * Callers reach endpoints beyond the two named ones through {@link
 * EsploraClient.getJson} / {@link EsploraClient.getText} rather than their own
 * `fetch`. That is not a convenience: the credentials live here, and an adapter
 * building its own request has to rebuild the auth header too — which is
 * exactly how half of one adapter's requests ended up unauthenticated against
 * the regtest chain API.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { Transaction } from '@scure/btc-signer'
import { GiveUp, poll } from '@arkade-os/solver-core/util/poll.js'
import type { FundedOnchainOutput } from '@arkade-os/solver-core/ports/onchain.js'

export interface EsploraTx {
  txid: string
  confirmed: boolean
  blockHeight: number | null
  vout: { scriptpubkey_address?: string; value: number }[]
  vin: { txid: string; vout: number }[]
}

export interface EsploraClient {
  broadcast(txHex: string): Promise<{ txid: string }>
  getAddressTxs(address: string): Promise<EsploraTx[]>
  /**
   * GET `path` and parse it as JSON, or throw. `path` is relative to the
   * client's base URL and starts with a slash.
   *
   * Throwing on a non-2xx is the point rather than a detail: a caller reading
   * "is this output spent" must never see a down indexer as "unspent".
   */
  getJson(path: string): Promise<unknown>
  /** As {@link EsploraClient.getJson}, for endpoints that answer in plain text. */
  getText(path: string): Promise<string>
}

export interface EsploraAuth {
  username: string
  password: string
}

interface RawEsploraTx {
  txid: string
  status: { confirmed: boolean; block_height?: number }
  vout: { scriptpubkey_address?: string; value: number }[]
  vin: { txid: string; vout: number }[]
}

export const createEsploraClient = (baseUrl: string, auth?: EsploraAuth): EsploraClient => {
  const headers = auth ? { Authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` } : undefined

  const get = async (path: string): Promise<Response> => {
    const response = await fetch(`${baseUrl}${path}`, { headers })
    if (!response.ok) throw new Error(`esplora GET ${path} failed (${response.status}): ${await response.text()}`)
    return response
  }

  return {
    async getJson(path) {
      return (await get(path)).json()
    },

    async getText(path) {
      return (await get(path)).text()
    },

    async broadcast(txHex) {
      const response = await fetch(`${baseUrl}/tx`, { method: 'POST', body: txHex, headers })
      const body = await response.text()
      if (!response.ok) throw new Error(`esplora broadcast failed (${response.status}): ${body}`)
      return { txid: body.trim() }
    },

    async getAddressTxs(address) {
      const raw = (await (await get(`/address/${address}/txs`)).json()) as RawEsploraTx[]
      return raw.map((tx) => ({
        txid: tx.txid,
        confirmed: tx.status.confirmed,
        blockHeight: tx.status.block_height ?? null,
        vout: tx.vout,
        vin: tx.vin,
      }))
    },
  }
}

/**
 * Who spent an output, as far as the chain API will say.
 *
 * THREE answers, never two, and that is the whole point. Every adapter used to
 * collapse the third into `null`:
 *
 *   if (!outspend.spent || !outspend.txid || outspend.vin === undefined) return null
 *
 * `null` means DEFINITIVELY UNSPENT to every caller — `whenRefundingOnchain`
 * reads it and broadcasts the solver's refund. "Spent, but I will not tell you
 * by what" is not that. Refunding there is a double-spend at best, and at worst
 * it walks past a client claim whose witness already carries the preimage.
 */
export type Spender = 'unspent' | 'spent-by-unknown' | { txid: string; vin: number }

type OutspendResponse = { spent?: boolean; txid?: string; vin?: number }

/**
 * Ask both shapes of chain API, because both are in use and they disagree.
 *
 * Measured on the regtest stack:
 *
 *   Electrs / a real Esplora -> `/tx/:txid/outspend/:vout` answers with the
 *                               spending `txid` and `vin`. Preferred: one
 *                               request, and it names what we need.
 *   mempool.space            -> 404s that path with HTML, so `getJson` throws.
 *                               Its `/tx/:txid/outspends` answers an array of
 *                               `{"spent": true}` with no spender at all, even
 *                               once the spend is confirmed.
 *
 * The singular THROWING is not an answer — it is a reason to ask the other way.
 * A `spent: false` from either IS an answer, and the only one that licenses a
 * refund.
 *
 * `outputScript` unlocks a third question, asked only when the first two leave
 * the spender unnamed — see {@link spenderFromScriptHistory}. Optional because
 * a caller that only wants spent-or-not need not supply it, but every caller
 * chasing a preimage should.
 */
export const spenderOf = async (
  esplora: EsploraClient,
  txid: string,
  vout: number,
  outputScript?: Uint8Array,
): Promise<Spender> => {
  let single: OutspendResponse | undefined
  try {
    single = (await esplora.getJson(`/tx/${txid}/outspend/${vout}`)) as OutspendResponse
  } catch {
    single = undefined
  }
  if (single?.spent && single.txid && single.vin !== undefined) return { txid: single.txid, vin: single.vin }
  if (single && single.spent === false) return 'unspent'

  // Deliberately NOT wrapped: if this fails too, nothing has been learned about
  // the output, and a transport failure must never read as `unspent`.
  const plural = (await esplora.getJson(`/tx/${txid}/outspends`)) as OutspendResponse[]
  const entry = plural[vout]
  if (!entry) {
    // An absent entry is NOT a `spent: false`. The array does not describe this
    // output — whether because the response was truncated or the vout is wrong,
    // nothing has been learned — and answering `unspent` here would license a
    // refund on no evidence, which is the exact conflation this function
    // exists to remove.
    throw new Error(
      `${txid}:${vout} — the chain API's outspends array has no entry for output ${vout} (length ${plural.length}), ` +
        'so whether it is spent is unknown',
    )
  }
  if (!entry.spent) return 'unspent'
  if (entry.txid && entry.vin !== undefined) return { txid: entry.txid, vin: entry.vin }

  // Spent, and this endpoint will not say by what — but the script's own
  // history will, because the spending transaction is an input there.
  if (outputScript) {
    const named = await spenderFromScriptHistory(esplora, outputScript, txid, vout)
    if (named) return named
  }
  return 'spent-by-unknown'
}

/**
 * The spending transaction, found through the output script's own history.
 *
 * `/tx/:txid/outspends` on a mempool.space-shaped deployment answers
 * `{"spent": true}` and nothing more, even once confirmed — which used to be
 * the end of the road, and left corridors pointed at such a deployment unable
 * to read a preimage at all. It is not the end of the road: the transaction
 * that spent this output necessarily lists it among its INPUTS, and it
 * necessarily touches this script, so it is in the script's transaction
 * history. One more request finds what the outspends call would not name.
 *
 * Two byte orders, because deployments disagree and the wrong one is silent
 * rather than loud — measured against the regtest Esplora, the forward sha256
 * returned both transactions and the reversed one returned an empty array, not
 * a 404. Trying both is safe because the result is VALIDATED against the
 * outpoint: only a transaction actually spending `txid:vout` is accepted, so a
 * response from the wrong index matches nothing and costs one request.
 */
const spenderFromScriptHistory = async (
  esplora: EsploraClient,
  outputScript: Uint8Array,
  txid: string,
  vout: number,
): Promise<{ txid: string; vin: number } | undefined> => {
  const digest = sha256(outputScript)
  const candidates = [hex.encode(digest), hex.encode(Uint8Array.from(digest).reverse())]
  for (const scripthash of candidates) {
    let history: { txid: string; vin: { txid: string; vout: number }[] }[]
    try {
      history = (await esplora.getJson(`/scripthash/${scripthash}/txs`)) as typeof history
    } catch {
      continue // A 404 here is this deployment declining the question, not an answer.
    }
    for (const tx of history) {
      const vin = tx.vin?.findIndex((input) => input.txid === txid && input.vout === vout) ?? -1
      if (vin !== -1) return { txid: tx.txid, vin }
    }
  }
  return undefined
}

/**
 * The vendor-neutral chain-mapping helpers every onchain adapter shares.
 *
 * They lived in one rail's onchain adapter once and the LND adapter imported
 * them from there — vendor code depending on another vendor's module, which
 * the vendor-package split makes impossible. They are Esplora-shaped, not
 * vendor-shaped, so this is their home: the one package any onchain rail may
 * import without dragging another rail in.
 */

/** Pure mapping: raw Esplora address history -> the port's `FundedOnchainOutput[]`. */
export const toFundedOutputs = (txs: EsploraTx[], address: string, tipHeight: number): FundedOnchainOutput[] => {
  const outputs: FundedOnchainOutput[] = []
  for (const tx of txs) {
    const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address)
    if (vout === -1) continue
    const confirmations = tx.confirmed && tx.blockHeight !== null ? tipHeight - tx.blockHeight + 1 : 0
    outputs.push({ txid: tx.txid, vout, valueSats: tx.vout[vout]!.value, confirmations })
  }
  return outputs
}

/** The witness stack of input `inputIndex` in a raw, already-finalized transaction. */
export const witnessFromRawTx = (txHex: string, inputIndex: number): Uint8Array[] => {
  const tx = Transaction.fromRaw(hex.decode(txHex), { allowUnknownInputs: true, allowUnknownOutputs: true })
  const input = tx.getInput(inputIndex)
  if (!input.finalScriptWitness) throw new Error(`input ${inputIndex} of ${tx.id} has no witness`)
  return [...input.finalScriptWitness]
}

/** Poll Esplora's address history for `txid`'s output paying `address`, and return its vout. */
export const pollForVout = async (esplora: EsploraClient, txid: string, address: string): Promise<number> =>
  poll(
    async () => {
      const txs = await esplora.getAddressTxs(address)
      const tx = txs.find((t) => t.txid === txid)
      if (!tx) return null
      const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === address)
      // Present but not paying the address is a fact, not a slow indexer:
      // retrying it fifteen times would only delay the same answer.
      if (vout === -1) throw new GiveUp(`funding tx ${txid} does not pay ${address} — cannot locate its vout`)
      return vout
    },
    { attempts: 15, intervalMs: 2_000, whenExhausted: `funding tx ${txid} did not appear in ${address}'s history` },
  )
