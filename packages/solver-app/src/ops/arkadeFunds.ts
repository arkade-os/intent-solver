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
 *  - `withdraw` — BOTH ways out of the float, routed by the destination's form:
 *    an Arkade address is paid offchain (`wallet.send`), a bitcoin address by
 *    collaborative exit (`wallet.settle` with an onchain output). The coins are
 *    selected HERE and pinned in the reservation ledger for the spend: the SDK's
 *    own selection cannot be told "not that one" and could take a coin out from
 *    under an in-flight lockup funding — the hazard `arkade/reservations.ts` exists for.
 *
 * The absent half of that pair is the point of a capability seam rather than an
 * interface every source must satisfy: absent is a fact the console can render,
 * whereas a method that threw would put a button on the screen that can only
 * ever fail.
 */

import { ArkAddress, Estimator, networks } from '@arkade-os/sdk'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { outpointKey, usableSatsOf } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import { offchainInputFeeParams } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import type { SwapNetwork } from '@arkade-os/solver-core/core/networks.js'
import type { Services } from './services.js'
import {
  parseWholeSats,
  type FundBalance,
  type FundDeposit,
  type FundSource,
  type FundWithdrawal,
} from './fundSources.js'

export const ARKADE_FUND_SOURCE_ID = 'arkade'

// Bounds on the fallback subset search: an unbounded one is a denial of service
// the operator inflicts on themselves, and its recursion is as deep as the coins
// it walks. 64 is the piece count `pool-mint` keeps a float at; a coin past it is
// still the first-fit scan's to take, and that scan is unbounded and iterative.
const SUBSET_SEARCH_COINS = 64
const SUBSET_SEARCH_LIMIT = 20_000

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
 * PREFIX-CHECKED, exactly like the boarding address below.
 *
 * An earlier version of this skipped the check, on the reasoning that an Arkade
 * address is derived from the server this wallet is connected to and so has no
 * wrong-chain form. That reasoning is wrong, and the SDK's own network table is
 * the proof: `hrp` is `ark` on bitcoin and `tark` on every test network, so a
 * wallet pointed at a mainnet server on a regtest-configured deployment hands
 * back a perfectly well-formed `ark1…` while this file labels it
 * `arkade regtest`. That is the identical hazard the boarding guard exists for
 * — an irreversible send to a wallet this solver is not running, against an
 * address the operator never typed and has no reason to doubt.
 *
 * The HRP comes from the SDK's `networks` rather than a table written here, for
 * the same reason the boarding check reads `ONCHAIN_NETWORKS`: a mapping
 * maintained beside the thing it describes cannot drift from it.
 *
 * In practice the misconfiguration that produces a wrong `ark1…` also produces a
 * wrong boarding address, which `arkadeDeposit` already refuses — and since
 * `depositOptions` awaits both, either refusal takes the whole answer down and
 * the operator is shown nothing rather than one good option beside one bad one.
 * This guard is therefore belt-and-braces, which is the correct posture for the
 * one mistake nobody downstream can catch.
 */
const arkadeOffchainDeposit = async (services: Services): Promise<FundDeposit> => {
  const network = services.config.network
  const address = await services.arkade.wallet.getAddress()
  const hrp = networks[network].hrp
  if (!address.startsWith(`${hrp}1`)) {
    throw new Error(
      `the Arkade wallet handed back ${address}, which is not a ${network} Arkade address (expected the ${hrp}1… ` +
        'prefix) — the wallet is pointed at a different Arkade server. Do NOT send to it.',
    )
  }
  return {
    address,
    addressKind: `arkade ${network}`,
    // FALSE, and the contrast with boarding is the whole reason both are offered:
    // a VTXO arriving here is already float. Nothing has to be run afterwards.
    settleRequired: false,
    note: 'Spendable float on arrival — no settlement step. Reachable only from a wallet already on Arkade.',
  }
}

type WithdrawRoute = { kind: 'arkade' } | { kind: 'onchain'; script: Uint8Array }

/** An Arkade address for ANOTHER network must not fall through to the onchain attempt: it decodes as Arkade, so the refusal gets to name the real mistake. */
const withdrawRoute = (address: string, network: SwapNetwork): WithdrawRoute => {
  let arkade: ArkAddress | null = null
  try {
    arkade = ArkAddress.decode(address)
  } catch {
    arkade = null
  }
  if (arkade !== null) {
    const hrp = networks[network].hrp
    if (arkade.hrp !== hrp) {
      throw new Error(
        `${address} is an Arkade address for another network (its prefix is ${arkade.hrp}1…, this deployment is ` +
          `${hrp}1…) — nothing was sent`,
      )
    }
    return { kind: 'arkade' }
  }
  try {
    return { kind: 'onchain', script: OutScript.encode(Address(ONCHAIN_NETWORKS[network]).decode(address)) }
  } catch {
    throw new Error(
      `${address} is neither a ${network} Arkade address (${networks[network].hrp}1…) nor a ${network} bitcoin ` +
        'address — nothing was sent',
    )
  }
}

/**
 * Pay `amount` sats out of the float to an address the operator chose. The
 * destination receives EXACTLY `amount` on both routes: the exit's intent fees
 * are paid out of the change, never out of what the operator typed.
 */
const arkadeWithdraw = async (
  services: Services,
  params: { address: string; amount: string },
): Promise<FundWithdrawal> => {
  const { wallet } = services.arkade
  const { address } = params
  const amountSats = parseWholeSats(params.amount)
  const route = withdrawRoute(address, services.config.network)

  const balance = await wallet.getBalance()
  // Advisory: `available` still counts coins the reservation ledger has pinned, so the selection below is the gate.
  if (amountSats > balance.available) {
    throw new Error(
      `withdrawal of ${amountSats} sats exceeds the float's available balance ` +
        `[requested: ${amountSats}, available: ${balance.available}, total: ${balance.total} sats]`,
    )
  }

  // `available` counts no swept coins, so neither does the selection — so `offchainInputFeeParams` never sees `isSwept`.
  const [spendable, info, changeAddress] = await Promise.all([
    wallet.getSpendableVtxos({ withRecoverable: false }),
    wallet.arkProvider.getInfo(),
    wallet.getAddress(),
  ])
  const dust = BigInt(info.dust)

  // No await between this read and the `reserve` below: the filter and the pin
  // are one synchronous section, or the ledger arbitrates nothing.
  const reserved = services.arkade.reservations.reserved()
  const candidates = spendable.filter((vtxo) => !reserved.has(outpointKey(vtxo.txid, vtxo.vout)))
  // Soonest-expiry first, the inverse of lockup funding's rule: a coin spent here
  // is a renewal fee nobody has to pay.
  const ordered = [...candidates].sort((a, b) => {
    const byExpiry = (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity)
    return byExpiry !== 0 ? byExpiry : b.value - a.value
  })

  if (route.kind === 'arkade') {
    const selected: typeof ordered = []
    let covered = 0
    for (const coin of ordered) {
      const usable = usableSatsOf(coin, Number(dust))
      if (usable <= 0) continue
      selected.push(coin)
      covered += usable
      if (covered >= amountSats) break
    }
    if (covered < amountSats) {
      throw new Error(
        `the float's unreserved coins cover ${covered} of ${amountSats} sats — a live swap's funding pins the ` +
          'rest, or the float needs topping up',
      )
    }
    const release = services.arkade.reservations.reserve(selected)
    try {
      // number, not bigint: `Recipient.amount` is a number, unlike the exit route's `settle` outputs below.
      const txid = await wallet.send({ recipients: [{ address, amount: amountSats }], selectedVtxos: [...selected] })
      return { reference: txid, address, amount: String(amountSats), detail: { route: 'arkade' } }
    } finally {
      release()
    }
  }

  if (BigInt(amountSats) < dust) {
    throw new Error(`amount ${amountSats} is below the ${dust} sat dust floor — an onchain output cannot carry it`)
  }
  const estimator = new Estimator(info.fees.intentFee)
  const outputFee = BigInt(
    estimator.evalOnchainOutput({ amount: BigInt(amountSats), script: hex.encode(route.script) }).satoshis,
  )
  const needed = BigInt(amountSats) + outputFee
  const changeScript = hex.encode(ArkAddress.decode(changeAddress).pkScript)
  // Fee and amount define each other; unsettled underfunds the exit, so refuse rather than ship one.
  const changeAfterFee = (left: bigint): bigint => {
    let net = left
    for (let i = 0; i < 8; i += 1) {
      const next = left - BigInt(estimator.evalOffchainOutput({ amount: net, script: changeScript }).satoshis)
      if (next === net) return net
      net = next
    }
    throw new Error(
      `the change fee does not settle after 8 rounds on ${left} sats of change — withdraw the whole float instead`,
    )
  }

  const economic = ordered.flatMap((coin) => {
    const fee = BigInt(estimator.evalOffchainInput(offchainInputFeeParams(coin)).satoshis)
    const value = BigInt(coin.value)
    return fee >= value ? [] : [{ coin, fee, net: value - fee, asset: (coin.assets?.length ?? 0) > 0 }]
  })
  // The change must be an output the server accepts: exactly nothing — and then
  // only when no asset rides it — or at least dust, under the per-output ceiling.
  const changeOf = (gross: bigint, carriesAsset: boolean): bigint | null => {
    const left = gross - needed
    if (left === 0n && !carriesAsset) return 0n
    const net = left > 0n ? changeAfterFee(left) : left
    if (net < dust) return null
    return info.vtxoMaxAmount >= 0n && net > info.vtxoMaxAmount ? null : net
  }

  // First-fit over the expiry order, unchanged: what selected before selects the
  // same coins, and only a refusal goes on to look for another subset.
  const selected: (typeof economic)[number][] = []
  let gross = 0n
  let carriesAsset = false
  let change: bigint | null = null
  for (const candidate of economic) {
    selected.push(candidate)
    gross += candidate.net
    carriesAsset = carriesAsset || candidate.asset
    change = changeOf(gross, carriesAsset)
    if (change !== null) break
  }

  let exhausted = false
  if (change === null && gross >= needed) {
    // Depth-first from the soonest expiry, so a coin is dropped only once nothing
    // containing it fits.
    selected.length = 0
    const searchable = Math.min(economic.length, SUBSET_SEARCH_COINS)
    let examined = 0
    const search = (from: number, sum: bigint, asset: boolean): bigint | null => {
      if (examined >= SUBSET_SEARCH_LIMIT) {
        exhausted = true
        return null
      }
      examined += 1
      const found = changeOf(sum, asset)
      if (found !== null) return found
      for (let i = from; i < searchable; i += 1) {
        const candidate = economic[i]!
        selected.push(candidate)
        const deeper = search(i + 1, sum + candidate.net, asset || candidate.asset)
        if (deeper !== null) return deeper
        selected.pop()
        if (exhausted) return null
      }
      return null
    }
    change = search(0, 0n, false)
  }

  if (change === null) {
    if (gross < needed) {
      throw new Error(
        `the float's unreserved coins net ${gross} sats against the ${needed} needed ` +
          `(${amountSats} + a ${outputFee} sat exit fee) — a live swap's funding pins the rest, or the float ` +
          'needs topping up',
      )
    }
    if (exhausted) {
      throw new Error(
        `no subset of the float's ${economic.length} unreserved coins funds ${amountSats} sats within the ` +
          `${dust} sat dust floor and the ${info.vtxoMaxAmount} sat per-output ceiling — the search stopped at ` +
          `${SUBSET_SEARCH_LIMIT} combinations; withdraw a different amount, or split the float first (pool-mint)`,
      )
    }
    const whole = changeAfterFee(gross - needed)
    if (whole < dust) {
      throw new Error(
        `withdrawing ${amountSats} sats leaves ${whole} sats of change, below the ${dust} ` +
          `sat dust floor` +
          (carriesAsset ? ' that the selection’s asset must ride on' : '') +
          ' — withdraw a little less, so the change clears it',
      )
    }
    throw new Error(
      `the change of ${whole} sats would come back as one coin above the server's ${info.vtxoMaxAmount} sat ` +
        'per-output ceiling — withdraw more, or split the float first (pool-mint)',
    )
  }

  const inputs = selected.map((c) => c.coin)
  const inputFees = selected.reduce((sum, c) => sum + c.fee, 0n)
  const changeFee = selected.reduce((sum, c) => sum + c.net, 0n) - needed - change
  const release = services.arkade.reservations.reserve(inputs)
  try {
    const outputs = [{ address, amount: BigInt(amountSats) }]
    if (change > 0n) outputs.push({ address: changeAddress, amount: change })
    const txid = await wallet.settle({ inputs, outputs })
    return {
      reference: txid,
      address,
      amount: String(amountSats),
      detail: { route: 'onchain', feeSats: (inputFees + outputFee + changeFee).toString() },
    }
  } finally {
    release()
  }
}

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
  withdraw: (params) => arkadeWithdraw(services, params),
  // Arkade FIRST: it is the one that needs no settlement, so an operator who
  // takes the top option gets spendable float rather than a second chore.
  //
  // `Promise.all` because neither read depends on the other — same shape as
  // `railBalance`'s three concurrent reads. The ORDER of the array is the policy
  // above and is unaffected: `Promise.all` preserves it regardless of which
  // settles first.
  depositOptions: async () => Promise.all([arkadeOffchainDeposit(services), arkadeDeposit(services)]),
})
