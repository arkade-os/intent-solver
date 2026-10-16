/**
 * Paying the solver's own sats into a lockup — the ONE implementation, shared
 * by both receive corridors. A drifted copy is invisible on regtest, whose
 * batches are shorter than the refund horizon, so only mainnet would tell.
 *
 * The rules it exists to apply are in {@link selectLockupFunding} (prefer coins
 * whose batch outlives the swap) and `arkade/reservations.ts` (pin what is
 * about to be spent so a renewal settle cannot take it first).
 */

import { randomUUID } from 'node:crypto'
import type { ArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { ArkError } from '@arkade-os/sdk'
import type { ClaimPacketStamp } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import { selectLockupFunding } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import {
  sendPhaseTimings,
  withProviderTimingScope,
  type ProviderTimingScope,
} from '@arkade-os/solver-arkade/arkade/latencyProviders.js'
import { CLAIM_PACKET_TYPE } from '@arkade-os/swap'
import { MAX_REFUND_HORIZON } from '@arkade-os/solver-core/core/receive.js'
import { json, log, nowSeconds } from '@arkade-os/solver-core/util/poll.js'

export const LOCKUP_FUNDING_FILTER = { withRecoverable: false, genericallySpendableOnly: true } as const

/**
 * A funding failure that provably submitted nothing. The boundary is
 * `ctx.wallet.send()`, whose ambiguous errors stay unwrapped because a lost response cannot be
 * told from a rejection — so a lease-holding caller that releases on an
 * ambiguous failure lets a second worker fund the same lockup, while the first
 * funding is still invisible to the indexer.
 */
export class FundNotSubmittedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FundNotSubmittedError'
  }
}

/**
 * Fund a lockup of `amountSats` at `address` from coins that will outlive the
 * swap, pinned for the duration of the send.
 *
 * The refusal is deliberately loud. Funding from an unusable set does not fail
 * here — it fails hours later, as a lockup the counterparty cannot claim and
 * this service may not renew, by which point the invoice is held and the client
 * is waiting. Refusing keeps the failure where it is cheap.
 */
export const fundLockup = async (
  ctx: ArkadeContext,
  address: string,
  amountSats: number,
  stamp?: ClaimPacketStamp,
): Promise<string> => {
  const started = performance.now()
  const fundRef = randomUUID()
  let inputs: Awaited<ReturnType<typeof ctx.wallet.getSpendableVtxos>>
  let readMs = 0
  let selectMs = 0
  let reserveMs = 0
  let release: () => void
  try {
    const selection = await selectFundingInputs(ctx, amountSats, fundRef)
    inputs = selection.inputs
    readMs = selection.readMs
    selectMs = selection.selectMs
    const reserveStarted = performance.now()
    release = ctx.reservations.reserve(inputs)
    reserveMs = Math.round(performance.now() - reserveStarted)
  } catch (error) {
    log(
      'receive_fund_timing',
      json({
        addressRef: address.slice(0, 16),
        fundRef,
        stage: 'select',
        totalMs: Math.round(performance.now() - started),
        outcome: 'failed',
      }),
    )
    throw error instanceof FundNotSubmittedError
      ? error
      : new FundNotSubmittedError(`failed to select coins to fund a lockup of ${amountSats} sats`, { cause: error })
  }
  const sendStarted = performance.now()
  const sendScope: ProviderTimingScope = { fundRef }
  let outcome = 'failed'
  try {
    // `send`, not `sendBitcoin`: the latter builds no asset packet, so arkd refuses
    // an asset-bearing coin (ASSET_VALIDATION_FAILED, 33). `send` routes the asset
    // onto the sats change itself; naming ourselves as an asset recipient instead
    // would fragment the holding onto its own 330-sat output on every funding.
    // `selectedVtxos` keeps the expiry-ordered, reserved selection.
    const txid = await withProviderTimingScope(sendScope, () =>
      ctx.wallet.send({
        recipients: [
          {
            address,
            amount: amountSats,
            // Both or neither — @see ClaimPacketStamp.
            ...(stamp
              ? { extensions: [{ type: CLAIM_PACKET_TYPE, payload: stamp.packet }], tapTree: stamp.tapTree }
              : {}),
          },
        ],
        selectedVtxos: [...inputs],
      }),
    )
    outcome = 'submitted'
    return txid
  } catch (error) {
    if (error instanceof ArkError && error.code === 15 && error.name === 'AMOUNT_TOO_LOW') {
      throw new FundNotSubmittedError('arkd rejected a sub-minimum funding output before submission', { cause: error })
    }
    throw error
  } finally {
    const sendFinished = performance.now()
    // Released whether the send landed or threw: a pin outliving its operation
    // shrinks the spendable float with nothing left to free it. If the send
    // DID land, the coins are spent and the next read will not offer them.
    release()
    if (process.env.SOLVER_LATENCY_DIAGNOSTICS === '1') {
      log(
        'wallet_send_phase_timing',
        json({
          fundRef,
          sendMs: Math.round(sendFinished - sendStarted),
          ...sendPhaseTimings(sendScope, sendStarted, sendFinished),
          outcome,
        }),
      )
    }
    log(
      'receive_fund_timing',
      json({
        addressRef: address.slice(0, 16),
        fundRef,
        readMs,
        selectMs,
        reserveMs,
        sendMs: Math.round(performance.now() - sendStarted),
        totalMs: Math.round(performance.now() - started),
        inputs: inputs.length,
        outcome,
      }),
    )
  }
}

/** The read-select-refuse half, which runs entirely before any funding request exists. */
const selectFundingInputs = async (ctx: ArkadeContext, amountSats: number, scope: string) => {
  // GATED read, not `getVtxos`. The SDK's own note on `getVtxos` is that
  // feeding it to `sendBitcoin({ selectedVtxos })` bypasses the
  // generic-spending gate — which here would mean funding one lockup out of
  // another live one's escrow, since `vhtlc-v2` is exactly what the gate hides.
  const started = performance.now()
  const spendable = await withProviderTimingScope({ fundRef: scope }, () =>
    ctx.wallet.getSpendableVtxos(LOCKUP_FUNDING_FILTER),
  )
  const readMs = Math.round(performance.now() - started)
  const selectStarted = performance.now()
  // Passed WHOLE, not mapped down: `selectedVtxos` needs the entire VTXO (script,
  // tapscripts), and a narrowed shape arrives with `script: undefined`.
  // `dustSats` is the network's own threshold, read at boot: what an asset change
  // output must carry. @see arkade/lockupFunding.ts
  const selection = selectLockupFunding({
    candidates: spendable,
    amountSats,
    horizonSeconds: MAX_REFUND_HORIZON,
    nowSeconds: nowSeconds(),
    reserved: ctx.reservations.reserved(),
    dustSats: Number(ctx.dustSats),
    vtxoMinSats: Number(ctx.vtxoMinSats),
  })
  if (!selection.ok) {
    throw new FundNotSubmittedError(`refusing to fund lockup of ${amountSats} sats: ${selection.reason}`)
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
  return { inputs: [...selection.inputs], readMs, selectMs: Math.round(performance.now() - selectStarted) }
}
