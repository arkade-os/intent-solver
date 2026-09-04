/**
 * The BTC rail as a fund source: channel liquidity and the onchain wallet
 * behind it.
 *
 * ONE source rather than two, because a rail is a PAIR — one wallet answering
 * both the Lightning and onchain ports, see ops/rails.ts — and splitting it
 * would offer an operator a "lightning" balance they cannot deposit into and an
 * "onchain" balance whose relationship to it the console never states. Both
 * halves are reported as figures on the same source, which is also what makes
 * `sharedWithLightning` expressible: on a backend that keeps one pool, two of
 * these figures are the same sats seen twice, and only a single source can say
 * so in one place.
 *
 * NO NEW PORT METHOD, and that is worth stating because it is the reason this
 * module is short. Everything here was already expressible:
 * `newReceiveAddress()` is a deposit address into that same wallet, `fund()` is
 * "pay this address n sats" and reads as swap-specific only because its one
 * previous caller was funding an HTLC with it, `settleReceiveAddress()` is the
 * credit step, and the two `getBalance()`s are the two pools an operator has to
 * be able to tell apart.
 *
 * WHAT IS NOT EXPRESSIBLE, and is therefore absent rather than approximated:
 * putting sats INTO channels. Neither port has a channel primitive and no
 * adapter implements one, so a deposit made here lands in the rail's onchain
 * wallet and whether it becomes channel liquidity is a decision taken at the
 * node, outside this service. Saying so is the point — a source labelled
 * "lightning" whose deposit silently only funded the onchain half would be read
 * as the other thing, on the screen where someone is judging whether the
 * corridor can pay.
 */

import { randomUUID } from 'node:crypto'
import { Address } from '@scure/btc-signer'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { requireLn, requireOnchain } from './rails.js'
import type { Services } from './services.js'
import type { FundBalance, FundDeposit, FundSettlement, FundSource, FundWithdrawal } from './fundSources.js'

export const RAIL_FUND_SOURCE_ID = 'rail'

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Read one side, or report why it could not be read.
 *
 * Per SIDE rather than one try around the pair, because the two are separate
 * connections and the answer an operator needs is usually about the one that DID
 * respond: "L1 holds 500k, the node is unreachable" is a decision, whereas a
 * single error for the whole read is only a shrug. Same discipline as the
 * console's overview, which must render with a backend down.
 */
const attempt = async <T>(
  read: () => Promise<T>,
): Promise<{ value: T; error: null } | { value: null; error: string }> => {
  try {
    return { value: await read(), error: null }
  } catch (error) {
    return { value: null, error: messageOf(error) }
  }
}

/** A figure that failed to read carries the reason INSTEAD of a number, never a zero beside it. */
const figure = (label: string, amount: number | null | undefined, error: string | null) =>
  error !== null
    ? { label, amount: null, note: error }
    : { label, amount: amount === null || amount === undefined ? null : String(amount) }

const railBalance = async (services: Services): Promise<FundBalance> => {
  const ln = requireLn(services.ln)
  const onchain = requireOnchain(services.onchain)
  const [lightning, chain, feeRate] = await Promise.all([
    attempt(() => ln.getBalance()),
    attempt(() => onchain.getBalance()),
    attempt(() => onchain.estimateFeeRate()),
  ])
  return {
    unit: 'sats',
    figures: [
      // Outbound and inbound answer different questions — one decides whether
      // the send corridor can pay an invoice, the other whether the receive
      // corridor can be paid one — so a rail can be healthy for one direction
      // and dead for the other. A single "lightning balance" hides exactly that.
      figure('channel out', lightning.value?.availableSats, lightning.error),
      figure('channel in', lightning.value?.incomingSats, lightning.error),
      figure('onchain confirmed', chain.value?.confirmedSats, chain.error),
      figure('onchain unconfirmed', chain.value?.unconfirmedSats, chain.error),
      // Not a balance, and deliberately here anyway: it is the difference
      // between a withdrawal that confirms and one that sits, and it is read off
      // the same backend in the same round trip.
      figure('fee rate (sat/vB)', feeRate.value, feeRate.error),
      // Only when the backend SAYS so. The flag is optional on the port and its
      // absence means "not stated", so warning on anything but an explicit
      // `true` would put this on every LND deployment, which really does keep
      // two pools.
      ...(chain.value?.sharedWithLightning === true
        ? [
            {
              label: 'pools',
              amount: null,
              note: 'This backend reports ONE pool: the channel and onchain figures above are the same sats.',
            },
          ]
        : []),
    ],
  }
}

/**
 * Where to send money so the rail can spend it.
 *
 * The address is DECODED against the configured network before it is handed
 * over. `createServices` already does that decode, but only while the
 * `arkade:BTC->onchain:BTC` corridor is enabled — so on a Lightning-only
 * deployment nothing checks it, and a rail pointed at the wrong chain would hand
 * an operator a perfectly well-formed address belonging to a wallet this solver
 * is not running. That is an irreversible send, and unlike a withdrawal the
 * operator has no reason to doubt an address the console itself gave them.
 */
const railDeposit = async (services: Services): Promise<FundDeposit> => {
  const onchain = requireOnchain(services.onchain)
  const network = services.config.network
  const address = await onchain.newReceiveAddress()
  try {
    Address(ONCHAIN_NETWORKS[network]).decode(address)
  } catch {
    throw new Error(
      `the rail handed back ${address}, which is not a ${network} address — this deployment's backend is ` +
        'pointed at a different chain. Do NOT send to it; fix LN_BACKEND / the node it points at first.',
    )
  }
  return {
    address,
    addressKind: `bitcoin ${network}`,
    settleRequired: onchain.settleReceiveAddress !== undefined,
    note: 'Lands in the rail’s onchain wallet. It does not open a channel, so inbound and outbound capacity are unchanged.',
  }
}

/**
 * A Lightning invoice, when the rail can mint one.
 *
 * The FAST option, and the one whose effect on the rail differs: sats paid over
 * Lightning arrive as outbound capacity that already exists, so this tops up a
 * balance without touching the onchain wallet at all. The onchain option adds
 * sats the node must then spend to use.
 *
 * AMOUNTLESS on purpose. The console asks for no amount before showing a deposit
 * option, and minting for a guessed one would hand an operator an invoice they
 * cannot pay what they meant to. The payer chooses.
 *
 * Never throws, and the onchain option is the reason. Two DIFFERENT ways this
 * can come back empty, and neither may cost the operator the other route:
 *
 *  - the backend does not implement `createInvoice` at all. An optional port
 *    capability, a deployment fact, and not a fault — `error` is null.
 *  - the backend implements it and the call FAILED: node down, restarting, or a
 *    macaroon without `invoices:write`. That last one is the case that makes an
 *    unguarded `await` dangerous, because such a node answers
 *    `newReceiveAddress` perfectly well while refusing to mint.
 *
 * An unguarded call rejects the whole of {@link FundSource.depositOptions} and
 * takes the onchain address down with it — on precisely the deployment where an
 * operator is trying to fund a node that is already unwell, which is when they
 * need a way in most. `attempt` is the same helper {@link railBalance} uses to
 * report the side that answered when the other is down, for the same reason.
 *
 * The reason travels back rather than being swallowed: an option that silently
 * disappears reads as "this rail cannot do Lightning deposits", which is a
 * different and permanent-sounding claim.
 */
const railInvoiceDeposit = async (
  services: Services,
): Promise<{ option: FundDeposit | null; error: string | null }> => {
  const ln = services.ln
  if (!ln?.createInvoice) return { option: null, error: null }
  const minted = await attempt(() => ln.createInvoice!({ memo: 'solver float deposit' }))
  if (minted.error !== null) return { option: null, error: minted.error }
  return {
    option: {
      address: minted.value.invoice,
      addressKind: 'lightning invoice',
      // FALSE: a settled Lightning payment is spendable balance the moment it
      // lands. Nothing to run afterwards, unlike the onchain option on a backend
      // that has a settle step.
      settleRequired: false,
      expiresAt: minted.value.expiresAt,
      note: 'Amountless — pay whatever you mean to deposit. Arrives as spendable balance; it does not add channel capacity.',
    },
    error: null,
  }
}

/**
 * Turn deposits the rail is holding into balance it can spend.
 *
 * Present only where the backend HAS the step — see `railFundSource` below,
 * which omits `settleDeposits` entirely otherwise rather than offering a button
 * whose only outcome is a refusal.
 *
 * Reachable even where the `arkade:BTC->onchain:BTC` corridor is off, which is
 * the case it exists for: the automatic sweep runs this through
 * `onchainService.settleRefundDeposits()`, and that service is only constructed
 * for an enabled corridor — so on a Lightning-only deployment a deposit would
 * otherwise strand with nothing anywhere able to claim it.
 */
const railSettle = async (services: Services): Promise<FundSettlement[]> => {
  const onchain = requireOnchain(services.onchain)
  // Non-null by construction: `railFundSource` only wires this method when the
  // backend has one.
  const settlements = (await onchain.settleReceiveAddress!()) ?? []
  return settlements.map((s) =>
    s.settled
      ? { settled: true, reference: `${s.txid}:${s.vout} (${s.reference})` }
      : { settled: false, reference: `${s.txid}:${s.vout}`, reason: s.reason },
  )
}

/**
 * Pay `amount` sats out of the rail's onchain wallet to an address the operator
 * chose.
 *
 * THE MONEY PATH WITH NO PROTOCOL BEHIND IT. Every other spend this service
 * makes goes where a swap already decided — a covenant refund to the client, a
 * claim to our own script, a float settlement to ourselves — so a mistake there
 * is bounded. Here the address is typed by a human and the send is final, which
 * is why all three checks run before the backend is touched at all:
 *
 *  1. the amount is a whole positive number of sats. Parsed from the seam's
 *     string form and refused unless it round-trips EXACTLY, so `1e3`, `0.5` and
 *     a 256-bit token quantity that wandered in are all rejected rather than
 *     coerced into a number nobody typed;
 *  2. the address DECODES on this deployment's network — the guard that typing
 *     the address back cannot provide, because an operator confirming a
 *     wrong-chain address types the same wrong string a second time;
 *  3. the amount is within the CONFIRMED balance. Unconfirmed sats can still be
 *     replaced, and spending them chains this withdrawal behind whatever might
 *     be, so the refusal names both numbers rather than letting the backend fail
 *     in its own vocabulary.
 *
 * NOT REPLAY-SAFE, deliberately. `fund()` takes an idempotency key so a
 * crash-driven re-drive cannot pay an HTLC twice; nothing persists or re-drives
 * THIS call, so there is exactly one attempt per press and the honest key is one
 * unique to it. A key derived from address-and-amount would look safer and
 * behave worse: an honouring backend would answer a second, deliberate
 * withdrawal of the same amount to the same address with the FIRST txid and move
 * nothing — a silent no-op wearing a success. The shipped LND rail drops the key
 * outright (`sendToChainAddress` exposes none), so a stable key would buy
 * nothing there and mislead everywhere. A withdrawal that times out must be
 * checked against the chain before it is retried; the action's warning says so.
 */
const railWithdraw = async (
  services: Services,
  params: { address: string; amount: string },
): Promise<FundWithdrawal> => {
  const onchain = requireOnchain(services.onchain)
  const { address } = params
  const network = services.config.network

  const amountSats = Number(params.amount)
  // Round-tripped, not merely coerced: `Number('1e3')` is 1000 and
  // `Number(' 12 ')` is 12, so a lenient parse would accept strings an operator
  // did not mean as sat counts, and a 256-bit quantity would silently lose
  // precision.
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0 || String(amountSats) !== params.amount.trim()) {
    throw new Error(`amount must be a whole positive number of sats, got ${JSON.stringify(params.amount)}`)
  }
  try {
    Address(ONCHAIN_NETWORKS[network]).decode(address)
  } catch {
    throw new Error(
      `${address} is not a valid ${network} address — nothing was sent. An address for another chain is an ` +
        'irreversible send, and it is the mistake retyping the address cannot catch.',
    )
  }

  const balance = await onchain.getBalance()
  if (amountSats > balance.confirmedSats) {
    throw new Error(
      `withdrawal of ${amountSats} sats exceeds the rail's confirmed onchain balance ` +
        `[requested: ${amountSats}, confirmed: ${balance.confirmedSats}, unconfirmed: ${balance.unconfirmedSats} sats]`,
    )
  }

  // Random, not a timestamp: two presses can land in the same millisecond —
  // which is exactly the double-submit this key would otherwise be read as
  // collapsing — so a clock-derived key would be stable for the one case it must
  // not be. `randomUUID` is what every swap id in this tree is minted from.
  const idempotencyKey = `admin-withdraw-${randomUUID()}`
  const { txid, vout } = await onchain.fund({ address, amountSats, idempotencyKey })
  return { reference: txid, address, amount: String(amountSats), detail: { vout, idempotencyKey } }
}

/**
 * The rail source, or NULL on a deployment that has no BTC rail.
 *
 * Null rather than a source that refuses everything: `config.lnBackend === null`
 * is permitted only while all four BTC corridors are off, so on such a
 * deployment there is no rail to fund and a panel reporting one as unreadable
 * would be reporting a fault that is actually a configuration.
 *
 * `settleDeposits` is wired only where the backend implements the step, so its
 * ABSENCE carries the fact rather than a refusal an operator has to press a
 * button to discover — which is also the only way the console can avoid drawing
 * a button that cannot work.
 */
export const railFundSource = (services: Services): FundSource | null => {
  if (!services.ln || !services.onchain) return null
  const onchain = services.onchain
  return {
    id: RAIL_FUND_SOURCE_ID,
    label: 'lightning rail',
    unit: 'sats',
    readBalance: () => railBalance(services),
    // Lightning FIRST where the rail can mint one: it is the faster route and
    // the one that needs no settle step. The onchain option is always present,
    // so a backend that cannot mint one still has somewhere to send.
    depositOptions: async () => {
      const invoice = await railInvoiceDeposit(services)
      // AFTER the invoice attempt and unconditionally: this is the option that
      // must survive a node which cannot mint. `railDeposit` is still allowed to
      // throw, because the only thing it throws on is an address belonging to
      // another chain — a fault where handing back SOMETHING is the dangerous
      // answer, not the safe one.
      const onchain = await railDeposit(services)
      if (invoice.option) return [invoice.option, onchain]
      if (invoice.error === null) return [onchain]
      // The rail CAN mint invoices and could not this time. Said on the option
      // the operator is left with, because the alternative is a Lightning route
      // that vanishes without explanation and reads as never having existed.
      return [{ ...onchain, note: `${onchain.note} Lightning deposit unavailable: ${invoice.error}` }]
    },
    ...(onchain.settleReceiveAddress === undefined ? {} : { settleDeposits: () => railSettle(services) }),
    withdraw: (params) => railWithdraw(services, params),
  }
}
