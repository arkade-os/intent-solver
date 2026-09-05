/**
 * Which OUTPOINT is funded at an offer's script — the read `offerOutputsAt`
 * deliberately does not answer.
 *
 * That module sums every live output at the script, which is right for the
 * packet path: `evaluateOfferFill` asks how much is there. A fill spends ONE
 * input, so the RFQ path needs the outpoint too, and a sum cannot name one.
 *
 * Direct indexer read, and `offerOutputs.ts` carries the argument for that
 * choice unchanged: an offer's script is not a contract of ours, nothing else in
 * the process reads it, and registering every quoted address with the contract
 * manager would grow an attacker-controlled set on the money path's own wallet.
 *
 * Paged for the same reason it is there — a truncated first page can hide the
 * output a fill would spend, which reads as "the client never funded it" rather
 * than as an error.
 */
import { hasTerminalSpend } from '@arkade-os/sdk'
import type { ArkadeContext } from './wallet.js'

/** One live output at an offer's script. Satisfies the corridor's `ObservedDeposit`. */
export interface OfferOutpoint {
  txid: string
  vout: number
  sats: bigint
  assets: readonly { assetId: string; amount: bigint }[]
}

/**
 * Every unspent, unswept output at `pkScriptHex`.
 *
 * Spent and swept ones are dropped HERE rather than by the caller, unlike
 * `offerOutputsAt`: that one hands its filtering to `offerDepositFrom`, which
 * needs to tell "spent" from "not yet synced". Nothing downstream of this makes
 * that distinction — an outpoint that cannot be spent is not one a fill can use.
 */
export const liveOfferOutpoints = async (
  ctx: Pick<ArkadeContext, 'wallet'>,
  pkScriptHex: string,
): Promise<OfferOutpoint[]> => {
  const outpoints: OfferOutpoint[] = []
  let pageIndex = 0
  for (;;) {
    const { vtxos, page } = await ctx.wallet.indexerProvider.getVtxos({
      scripts: [pkScriptHex],
      pageIndex,
      pageSize: 500,
    })
    const batch = vtxos ?? []
    for (const vtxo of batch) {
      if (hasTerminalSpend(vtxo) || vtxo.isSwept === true) continue
      const carried = (vtxo as { assets?: { assetId: string; amount: bigint | string }[] }).assets ?? []
      outpoints.push({
        txid: vtxo.txid,
        vout: vtxo.vout,
        sats: BigInt(vtxo.value),
        // `BigInt` on both spellings: the indexer reports asset amounts as
        // bigints and the wallet's own view reports strings, and an asset
        // amount is 256-bit, so neither may go near a `number`.
        assets: carried.map((entry) => ({ assetId: entry.assetId, amount: BigInt(entry.amount) })),
      })
    }
    if (batch.length === 0 || !page || page.current + 1 >= page.total) break
    pageIndex = page.current + 1
  }
  return outpoints
}

/**
 * The outpoint a fill would spend: the largest by sats, or null when none is
 * funded.
 *
 * Largest rather than first, because identical terms compile to one address —
 * so an earlier negotiation's leftover dust can sit beside the deposit this one
 * is waiting for, and picking arbitrarily would report the swap as funded short.
 */
export const largestOfferOutpoint = (outpoints: readonly OfferOutpoint[]): OfferOutpoint | null =>
  outpoints.reduce<OfferOutpoint | null>((best, next) => (best === null || next.sats > best.sats ? next : best), null)

/** How much of one leg an outpoint holds — sats when the leg is BTC. */
export const heldOnOutpoint = (outpoint: OfferOutpoint, leg: string | null): bigint => {
  if (leg === null) return outpoint.sats
  let held = 0n
  for (const entry of outpoint.assets) if (entry.assetId === leg) held += entry.amount
  return held
}
