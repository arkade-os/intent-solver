/**
 * Paying the solver's own sats into a lockup — the ONE implementation, shared
 * by both receive corridors.
 *
 * Shared rather than mirrored on purpose. This began as a private helper on the
 * Lightning receive leg while the onchain leg kept calling `wallet.send`, and
 * review caught it: the same corridor, the same money, one of them with the
 * coin-selection and reservation rules and one without. Two copies of a rule
 * this quiet drift apart silently, and the drift is invisible on regtest —
 * where batches are shorter than the refund horizon, the wrong selection picks
 * the same coin as the right one, so only mainnet tells them apart.
 *
 * The rules it exists to apply are in {@link selectLockupFunding} (prefer coins
 * whose batch outlives the swap) and `arkade/reservations.ts` (pin what is
 * about to be spent so a renewal settle cannot take it first).
 */

import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { selectLockupFunding } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import { MAX_REFUND_HORIZON } from '@arkade-os/solver-core/core/receive.js'
import { log } from '@arkade-os/solver-core/util/poll.js'

/**
 * Fund a lockup of `amountSats` at `address` from coins that will outlive the
 * swap, pinned for the duration of the send.
 *
 * The refusal is deliberately loud. Funding from an unusable set does not fail
 * here — it fails hours later, as a lockup the counterparty cannot claim and
 * this service may not renew, by which point the invoice is held and the client
 * is waiting. Refusing keeps the failure where it is cheap.
 */
export const fundLockup = async (ctx: ArkadeContext, address: string, amountSats: number): Promise<string> => {
  // GATED read, not `getVtxos`. The SDK's own note on `getVtxos` is that
  // feeding it to `sendBitcoin({ selectedVtxos })` bypasses the
  // generic-spending gate — which here would mean funding one lockup out of
  // another live one's escrow, since `vhtlc-v2` is exactly what the gate hides.
  const spendable = await ctx.wallet.getSpendableVtxos()
  // Passed WHOLE, not mapped down. `selectLockupFunding` is generic and hands
  // back the very objects it was given, because these go straight to
  // `sendBitcoin({ selectedVtxos })`, which needs the entire VTXO — script,
  // tapscripts and all. An earlier cut mapped them to the narrow decision
  // shape and sent THAT, so the spend arrived with `script: undefined` and
  // `assertAnnotatable` refused it with "no contract registered for
  // undefined". The `as never` that made it compile is gone with it.
  // The network's own threshold, not a constant: it is what an asset change
  // output must carry, and `selectLockupFunding` discounts an asset-bearing
  // coin by exactly this much. @see arkade/lockupFunding.ts
  const { dust } = await ctx.wallet.arkProvider.getInfo()
  const selection = selectLockupFunding({
    candidates: spendable,
    amountSats,
    horizonSeconds: MAX_REFUND_HORIZON,
    nowSeconds: Math.floor(Date.now() / 1000),
    reserved: ctx.reservations.reserved(),
    dustSats: Number(dust),
  })
  if (!selection.ok) {
    throw new Error(`refusing to fund lockup of ${amountSats} sats: ${selection.reason}`)
  }
  if (!selection.clearedHorizon) {
    // Not fatal — see selectLockupFunding on why this is a preference — but
    // never silent. It means the lockup inherits a batch that may lapse before
    // the swap resolves, which is worth seeing in a log when a claim later
    // fails for reasons that look unrelated.
    log(
      `funding lockup of ${amountSats} sats from coins that do not outlive the ${MAX_REFUND_HORIZON}s refund horizon:`,
      'float needs renewing, or this network batches shorter than the horizon',
    )
  }
  const release = ctx.reservations.reserve(selection.inputs)
  try {
    // `send`, not `sendBitcoin`, and that single swap is the whole fix.
    //
    // `sendBitcoin` builds a plain sats transfer with no asset packet, so arkd
    // refuses the spend of an asset-bearing coin outright:
    // ASSET_VALIDATION_FAILED (33). `send` builds the packet and routes the
    // asset change ITSELF — measured on a live regtest stack, not assumed:
    // spending a coin holding 8,370,456 sats and 500 units, with NO asset
    // recipient named, produced the requested output plus a change output
    // carrying all 500 units. The asset rides the sats change, which exists
    // anyway.
    //
    // An earlier cut summed the carried assets and named ourselves as a second
    // recipient. That was redundant, and worse than redundant: it forced the
    // asset onto its own 330-sat output, fragmenting the holding a little more
    // on every funding, where the SDK would have left it on the change.
    //
    // It keeps `selectedVtxos`, whose own SDK doc names this exact case — "when
    // a contract must be funded from coins outliving its timelock, which generic
    // selection does not know about" — so nothing about the expiry ordering or
    // the reservation is given up.
    return await ctx.wallet.send({
      recipients: [{ address, amount: amountSats }],
      selectedVtxos: [...selection.inputs],
    })
  } finally {
    // Released whether the send landed or threw: a pin outliving its operation
    // shrinks the spendable float with nothing left to free it. If the send
    // DID land, the coins are spent and the next read will not offer them.
    release()
  }
}
