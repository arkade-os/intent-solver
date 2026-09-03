/**
 * The Arkade float as a fund source — the most-used one in the repo, and the
 * one that proves the seam is not Lightning-shaped.
 *
 * Every corridor pays out of this wallet, and until now the only way to top it
 * up was `scripts/regtest-fund.mjs` (boarding address → faucet → settle) or a
 * transfer someone made by hand. The console showed the balance and offered no
 * way to add to it.
 *
 * WHAT IT DECLARES, and why it is a different set from the rail's:
 *
 *  - `readBalance` — a completely different split. The rail reports two pools of
 *    two figures; this reports what can fund a swap RIGHT NOW versus what is
 *    boarded, waiting or stuck. A seam with fixed fields could not carry both.
 *  - `depositOptions` — an Arkade address (float on arrival) and the boarding
 *    address, an L1 address that boards into
 *    Arkade. `settleRequired` is true and there is deliberately no
 *    `settleDeposits` below; those are two different facts and this source is
 *    the reason they are separate fields.
 *  - NO `settleDeposits`. Boarded sats become a VTXO through `wallet.settle()`,
 *    which `float-lifecycle` already drives — with the CLTV guard that holds
 *    recovery back rather than failing a whole batch, and it is ARMED. A
 *    safe-tier duplicate here would be the dangerous half of a duplicated money
 *    path and a quiet downgrade of an existing gate. Worse, a bare no-arg
 *    `settle()` merges the whole float into ONE coin, flattening the very piece
 *    count `pool-mint` exists to build. The deposit's `note` names the action to
 *    use instead.
 *  - NO `withdraw`. Paying an arbitrary address out of the float means either an
 *    Arkade-address transfer or an offboard, and neither is "send n sats to this
 *    L1 address". Both would also spend float coins OUTSIDE the process-local
 *    reservation ledger, taking a coin out from under an in-flight lockup
 *    funding — the exact hazard `arkade/reservations.ts` exists for. The float's
 *    intended exits are the corridors.
 *
 * That last pair is the point of a capability seam rather than an interface
 * every source must satisfy: absent is a fact the console can render, whereas a
 * method that threw would put two buttons on the screen that can only ever fail.
 */

import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import type { Services } from './services.js'
import type { FundBalance, FundDeposit, FundSource } from './fundSources.js'

export const ARKADE_FUND_SOURCE_ID = 'arkade'

/**
 * The funding-relevant split, not the whole balance object.
 *
 * `available` is the only figure that answers "can this fund a swap", and the
 * others are here because each is a way that number can be low while the wallet
 * looks full:
 *
 *  - boarding sats have arrived on L1 and are not a VTXO yet;
 *  - `recoverable` is float the server has swept — it reads as balance and funds
 *    NOTHING until recovery runs, and a float in that state fails every corridor
 *    with a reason that names the corridor rather than the float.
 *
 * An operator looking at this panel is deciding whether to send more money. Each
 * of these is a case where the answer is "no — settle or recover what you have".
 */
const arkadeBalance = async (services: Services): Promise<FundBalance> => {
  const balance = await services.arkade.wallet.getBalance()
  const figure = (label: string, amount: number, note?: string) => ({
    label,
    amount: String(amount),
    ...(note === undefined ? {} : { note }),
  })
  return {
    unit: 'sats',
    figures: [
      figure('available', balance.available, 'What can fund a swap now.'),
      figure('boarding confirmed', balance.boarding.confirmed, 'Arrived on L1; not a VTXO until settled.'),
      figure('boarding unconfirmed', balance.boarding.unconfirmed),
      figure(
        'recoverable',
        balance.recoverable,
        'Swept by the server. Reads as balance and funds nothing until float-lifecycle recovers it.',
      ),
      figure('total', balance.total),
    ],
  }
}

/**
 * The boarding address: an L1 address whose sats become a VTXO once settled.
 *
 * Checked by BECH32 PREFIX rather than a full decode, unlike the rail's.
 * `createServices` already proves `Address(...).decode()` handles what the rail
 * hands back, and there is no equivalent proof for whatever output type the SDK
 * mints here — so a full decode would risk refusing a perfectly good boarding
 * address for a guard that is cosmetic on this path. The prefix is what actually
 * separates the chains (`bc` / `tb` / `bcrt`), which is the mistake worth
 * catching: an operator faucet-ing a mainnet address on a regtest deployment.
 */
const arkadeDeposit = async (services: Services): Promise<FundDeposit> => {
  const network = services.config.network
  const address = await services.arkade.wallet.getBoardingAddress()
  const hrp = ONCHAIN_NETWORKS[network].bech32
  if (!address.startsWith(`${hrp}1`)) {
    throw new Error(
      `the Arkade wallet handed back ${address}, which is not a ${network} address (expected the ${hrp}1… prefix) — ` +
        'the wallet is pointed at a different chain. Do NOT send to it.',
    )
  }
  return {
    address,
    addressKind: `bitcoin ${network} (Arkade boarding)`,
    // TRUE, while `settleDeposits` below is deliberately absent: sats here are
    // not float until they are settled into a VTXO, and this source is not where
    // that is done.
    settleRequired: true,
    note:
      'Boarding only: sats here are not spendable float until they are settled into a VTXO. Run the ' +
      'float-lifecycle action to do that — it carries the CLTV guard that stops one unripe lockup failing the ' +
      'whole settlement.',
  }
}

/**
 * The Arkade address: a VTXO sent here IS float on arrival.
 *
 * The other half of the answer, and usually the one an operator wants. Boarding
 * takes L1 sats and needs a settlement before they are spendable; this takes a
 * VTXO from anyone already on Arkade and needs nothing afterwards. Offering only
 * the first — which this source did — quietly told an operator already holding
 * VTXOs to go out to L1 and wait.
 *
 * NOT prefix-checked, unlike the boarding address, and the asymmetry is
 * deliberate. That one is a bech32 L1 address which would be equally valid on
 * the wrong network, so a prefix is the only thing separating a regtest faucet
 * from a mainnet loss. An Arkade address encodes the SERVER key beside the
 * wallet key and is derived from the server this wallet is connected to, so
 * there is no wrong-chain form of it for a guard to catch.
 */
const arkadeOffchainDeposit = async (services: Services): Promise<FundDeposit> => ({
  address: await services.arkade.wallet.getAddress(),
  addressKind: `arkade ${services.config.network}`,
  // FALSE, and the contrast with boarding is the whole reason both are offered:
  // a VTXO arriving here is already float. Nothing has to be run afterwards.
  settleRequired: false,
  note: 'Spendable float on arrival — no settlement step. Reachable only from a wallet already on Arkade.',
})

/**
 * Always present — unlike the rail's, which is null without `LN_BACKEND`.
 *
 * Every deployment has an Arkade wallet: `createServices` builds one
 * unconditionally, because there is no solver without a float.
 */
export const arkadeFundSource = (services: Services): FundSource => ({
  id: ARKADE_FUND_SOURCE_ID,
  label: 'arkade float',
  unit: 'sats',
  readBalance: () => arkadeBalance(services),
  // Arkade FIRST: it is the one that needs no settlement, so an operator who
  // takes the top option gets spendable float rather than a second chore.
  //
  // `Promise.all` because neither read depends on the other — same shape as
  // `railBalance`'s three concurrent reads. The ORDER of the array is the policy
  // above and is unaffected: `Promise.all` preserves it regardless of which
  // settles first.
  depositOptions: async () => Promise.all([arkadeOffchainDeposit(services), arkadeDeposit(services)]),
})
