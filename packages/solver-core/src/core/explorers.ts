/**
 * Links to what this service actually moved.
 *
 * The console renders a swap's identifiers as text: an Arkade lockup address, a
 * lockup txid, a covenant refund txid, an L1 HTLC txid. An operator ends up pasting
 * every one of them into an explorer by hand, at the worst moment — mid-incident,
 * deciding between refunding a client and claiming a lockup.
 *
 * TWO explorers per network, because the corridors span two chains:
 *
 * - Arkade addresses and Arkade transactions -> the Arkade explorer
 * - Bitcoin L1 transactions -> the mempool instance
 *
 * Crossing them is worse than useless. An L1 txid on an Arkade explorer, or an
 * Arkade txid on mempool, answers "not found" — which reads exactly like the
 * money is gone, and is the answer most likely to provoke the wrong action.
 *
 * The path shapes are read off the explorers that serve them rather than
 * guessed: `/tx/:txid` and `/address/:address` are the routes declared in
 * `ArkLabsHQ/arkade-explorer`'s `src/App.tsx`, and mempool instances use the
 * same two. The bases live in {@link NETWORKS} so that adding a network is one
 * edit the compiler forces you to complete, which is where every other
 * per-network fact already lives.
 */

import { NETWORKS, type SwapNetwork } from './networks.js'

/**
 * Join an identifier onto an explorer base, or null when there is nothing to
 * link to.
 *
 * Null rather than the bare base: a link to an explorer's home page looks like
 * it worked and silently answers a different question, which costs more than a
 * plain unlinked value. Callers render text in that case.
 *
 * The identifier is percent-encoded. Nothing that reaches here should contain a
 * path separator — these are hex ids and bech32 addresses — but a link built by
 * concatenation is exactly the shape that turns a surprising value into a
 * request somewhere else.
 */
const urlFor = (base: string, path: string, id: string): string | null => {
  const trimmed = id.trim()
  if (trimmed.length === 0) return null
  return `${base}/${path}/${encodeURIComponent(trimmed)}`
}

/** An Arkade transaction: the lockup, a covenant refund, a claim. */
export const arkadeTxUrl = (network: SwapNetwork, txid: string): string | null =>
  urlFor(NETWORKS[network].explorers.arkade, 'tx', txid)

/** An Arkade address — the lockup script a client funds. */
export const arkadeAddressUrl = (network: SwapNetwork, address: string): string | null =>
  urlFor(NETWORKS[network].explorers.arkade, 'address', address)

/** A Bitcoin L1 transaction: the onchain corridors' HTLC funding and claims. */
export const onchainTxUrl = (network: SwapNetwork, txid: string): string | null =>
  urlFor(NETWORKS[network].explorers.onchain, 'tx', txid)

/** A Bitcoin L1 address. */
export const onchainAddressUrl = (network: SwapNetwork, address: string): string | null =>
  urlFor(NETWORKS[network].explorers.onchain, 'address', address)
