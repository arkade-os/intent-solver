/**
 * The offer a funding transaction carries, and the outpoint that funds it.
 *
 * The intake `offerStream.ts` produces for and `ops/assetOffers.ts` consumes:
 * the stream says WHICH transactions carry an offer packet, this says WHAT the
 * packet is and where the deposit sits. Both halves are needed before
 * `consider()` has anything to decide — arkd's filter matches on the packet's
 * presence and proves nothing about its contents.
 *
 * DECODING IS `@arkade-os/swap`'s, NOT OURS. The offer TLV is byte-identical
 * across three implementations, so a hand-rolled parser here would be a fourth
 * one to keep in step. `decodeOffer` is the same function the maker's wallet
 * encoded with, which is what makes a packet solverd emitted one we read the
 * same way it does.
 *
 * EVERY INPUT IS ATTACKER-SUPPLIED. Anyone can put a transaction on the stream,
 * so a malformed packet is normal traffic rather than an incident: every
 * refusal is `null`, and one bad offer costs one offer instead of the discovery
 * loop that was iterating.
 */
import { Extension, Transaction } from '@arkade-os/sdk'
import { decodeOffer, OFFER_PACKET_TYPE, type Offer } from '@arkade-os/swap'
import { base64, hex } from '@scure/base'

/** A decoded offer, funded at a known outpoint of the transaction that carried it. */
export interface DiscoveredOfferTx {
  offer: Offer
  /**
   * Derived from the BYTES, never taken from whatever announced them.
   *
   * The stream reports a txid beside each transaction, and using it would let a
   * relay announce A while shipping B: the row would be keyed on A and
   * settlement would spend B. Deriving it removes the disagreement rather than
   * checking for it.
   */
  txid: string
  /** The output at the offer's own script — the deposit a fill spends. */
  vout: number
  /** Sats on that output. */
  value: number
}

/**
 * The offer this funding transaction publishes, or null when it publishes none
 * we can act on.
 *
 * Null covers every refusal, and they are all ordinary: bytes that are not a
 * transaction, no extension, no offer packet, a packet that does not decode,
 * and — the one worth naming — a well-formed offer riding a transaction that
 * never funded its script. That last is not a malformed packet at all; it is a
 * packet whose deposit is somewhere else, and recording it would key a row to
 * an outpoint that is not the deposit.
 *
 * @param rawArkTx the transaction as base64 PSBT, which is the encoding both
 * `streamOfferTxs` and `indexerProvider.getVirtualTxs` hand back.
 */
export const offerFromFundingTx = (rawArkTx: string): DiscoveredOfferTx | null => {
  let tx: Transaction
  let offer: Offer
  try {
    tx = Transaction.fromPSBT(base64.decode(rawArkTx))
    const packet = Extension.fromTx(tx).getPacketByType(OFFER_PACKET_TYPE)
    if (packet === null) return null
    offer = decodeOffer(packet.serialize())
  } catch {
    // `Extension.fromTx` throws when there is no extension output, `decodeOffer`
    // throws on malformed or unknown records, and a non-transaction throws
    // before either. All three mean the same thing to a taker: nothing to fill.
    return null
  }

  const want = hex.encode(offer.swapPkScript).toLowerCase()
  for (let vout = 0; vout < tx.outputsLength; vout += 1) {
    const output = tx.getOutput(vout)
    if (output?.script === undefined || output.amount === undefined) continue
    if (hex.encode(output.script).toLowerCase() !== want) continue
    const value = Number(output.amount)
    // Sats fit a double — the 21e14 cap is comfortably inside 2^53 — so this can
    // only fail on a transaction that is already nonsense. Refused rather than
    // carried, because the value goes on to size a real spend.
    if (!Number.isSafeInteger(value) || value < 0) return null
    // The FIRST output at the script. A funding transaction paying the same
    // offer twice would be one deposit per outpoint, and this names the one this
    // discovery is about; the other is a second offer to be discovered on its
    // own terms rather than silently merged into this row.
    return { offer, txid: tx.id, vout, value }
  }
  return null
}
