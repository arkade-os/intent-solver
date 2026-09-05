/**
 * Per-corridor economic policy: what a corridor will quote, and what it charges.
 *
 * Separate from `limits.ts` because that module owns one question — how wide a
 * blast radius a single swap may have — and answers it the same way for every
 * corridor. This one owns the questions where the four corridors genuinely
 * differ: an onchain leg pays for a transaction whatever the swap is worth, and
 * a Lightning leg does not, so a single spread cannot price both correctly.
 */

/** The four directional pairs this solver serves. */
export const CORRIDORS = [
  'arkade:BTC->lightning:BTC',
  'lightning:BTC->arkade:BTC',
  'arkade:BTC->onchain:BTC',
  'onchain:BTC->arkade:BTC',
] as const

export type Corridor = (typeof CORRIDORS)[number]

export const isCorridor = (value: string): value is Corridor => (CORRIDORS as readonly string[]).includes(value)

/**
 * The env stem moved onto the corridor's descriptor (`corridorDescriptor.ts`),
 * which is the one place a stem and its pair cannot drift apart — the registry
 * refuses a duplicate at composition time.
 *
 * The corridor families the closed union cannot hold: an EVM corridor names
 * its ERC20, so it cannot be a member of {@link CORRIDORS}.
 *
 * A deployment serves whatever tokens it is configured for, and `tokenAddress`
 * is per-swap in the `ERC20Swap` binding rather than per-chain — so the set is
 * not known until runtime and a compile-time union cannot hold it.
 *
 * A TEMPLATE LITERAL TYPE rather than a bare `string`, so the two families stay
 * distinguishable to the compiler. That is what lets {@link payoutRailFor}
 * handle EVM corridors in ONE named place instead of the `split('->')` that
 * `PAYOUT_RAIL`'s comment rightly warns against — the exhaustiveness of every
 * `Record<Corridor, …>` is untouched, and adding a fifth FIXED corridor still
 * fails to compile until someone states which balance funds it.
 *
 * The token is its lowercase 0x address, for the reason `marketKey.ts` gives
 * for asset ids: a pair string is compared byte for byte elsewhere, so one
 * spelling normalised in one layer and not another derives the right key and is
 * then refused as unserved.
 */
export type EvmCorridor = `arkade:BTC->ethereum:${string}` | `ethereum:${string}->arkade:BTC`

/** Either family. Use where a corridor is carried rather than decided upon. */
export type AnyCorridor = Corridor | EvmCorridor

/** `0x` then 40 lowercase hex — the canonical spelling of an ERC20 address. */
const EVM_TOKEN = /^0x[0-9a-f]{40}$/

export const isEvmCorridor = (value: string): value is EvmCorridor => {
  const send = /^arkade:BTC->ethereum:(0x[0-9a-f]{40})$/.exec(value)
  if (send) return true
  const receive = /^ethereum:(0x[0-9a-f]{40})->arkade:BTC$/.exec(value)
  return receive !== null
}

/** The corridor a token is served on, in the given direction. */
export const evmCorridorFor = (token: string, direction: 'send' | 'receive'): EvmCorridor => {
  if (!EVM_TOKEN.test(token)) {
    throw new Error(`EVM token must be 0x then 40 LOWERCASE hex, got ${JSON.stringify(token)}`)
  }
  return direction === 'send' ? `arkade:BTC->ethereum:${token}` : `ethereum:${token}->arkade:BTC`
}

/**
 * `arkade:<asset>->ethereum:<token>` — an Arkade ASSET funds the leg the four
 * sats corridors fund with BTC.
 *
 * A third family, and deliberately NOT a member of {@link AnyCorridor}. As a
 * TYPE it would subsume {@link EvmCorridor}'s send arm — `arkade:${string}`
 * admits `arkade:BTC` and TypeScript cannot say "not BTC" — so widening
 * `AnyCorridor` with it would silently cost every existing consumer the
 * distinction it relies on. The two families are told apart at RUN TIME by the
 * anchored guards below, and any dispatch must ask {@link isEvmCorridor} first.
 *
 * NO SATS ON EITHER LEG, which is what makes this corridor different in kind
 * rather than in degree: it is invisible to the house `maxExposedSats` cap.
 * @see AssetEvmSendSwapStore.committedSats and arkade-os/intent-solver#22.
 */
export type AssetEvmCorridor = `arkade:${string}->ethereum:${string}`

/** The 68-hex serialized Arkade Asset ID of `docs/rfq-protocol.md` § 2. */
const ARKADE_ASSET_ID = /^[0-9a-f]{68}$/

const ASSET_EVM_CORRIDOR = /^arkade:([0-9a-f]{68})->ethereum:(0x[0-9a-f]{40})$/

export const isAssetEvmCorridor = (value: string): value is AssetEvmCorridor => ASSET_EVM_CORRIDOR.test(value)

/** The corridor an (asset, token) pair is served on. Send only — @see AssetEvmCorridor. */
export const assetEvmCorridorFor = (assetId: string, token: string): AssetEvmCorridor => {
  if (!ARKADE_ASSET_ID.test(assetId)) {
    throw new Error(`Arkade asset id must be 68 LOWERCASE hex, got ${JSON.stringify(assetId)}`)
  }
  if (!EVM_TOKEN.test(token)) {
    throw new Error(`EVM token must be 0x then 40 LOWERCASE hex, got ${JSON.stringify(token)}`)
  }
  return `arkade:${assetId}->ethereum:${token}`
}

/** The two legs a pair string names, or null when it names no asset-EVM corridor. */
export const assetEvmLegsOf = (pair: string): { assetId: string; token: string } | null => {
  const match = ASSET_EVM_CORRIDOR.exec(pair)
  return match ? { assetId: match[1]!, token: match[2]! } : null
}

/** The ERC20 a corridor serves, or null when it is not an EVM corridor. */
export const evmTokenOf = (corridor: AnyCorridor): string | null => {
  const send = /^arkade:BTC->ethereum:(0x[0-9a-f]{40})$/.exec(corridor)
  if (send) return send[1] ?? null
  const receive = /^ethereum:(0x[0-9a-f]{40})->arkade:BTC$/.exec(corridor)
  return receive ? (receive[1] ?? null) : null
}
/**
 * Which EVM direction a pair string names, or null when it names neither.
 *
 * Exists because the RFQ ingress dispatches on pair CONSTANTS for the four BTC
 * corridors, and an EVM pair cannot be a constant - it carries the token
 * address. Without this, `arkade:BTC->ethereum:0x...` reaches the ingress's
 * fall-through case, which is the Lightning send handler, and the client gets a
 * refusal about an invoice it never mentioned.
 *
 * Takes a plain string rather than an `AnyCorridor`: this is what the wire hands
 * over, and deciding whether it IS a corridor is the job.
 */
export const evmDirectionOf = (pair: string): 'send' | 'receive' | null => {
  if (/^arkade:BTC->ethereum:0x[0-9a-f]{40}$/.test(pair)) return 'send'
  if (/^ethereum:0x[0-9a-f]{40}->arkade:BTC$/.test(pair)) return 'receive'
  return null
}

/**
 * What the solver keeps from a swap.
 *
 * Two components because one cannot express both costs a corridor has. `bps`
 * scales with the amount and covers proportional risk — capital tied up, a routing
 * fee that grows with the payment. `flatSats` covers a fixed cost the corridor pays
 * regardless of size: an onchain corridor broadcasts a transaction and pays miner
 * fees whether the swap is worth a thousand sats or a million.
 *
 * With `flatSats` at zero this is the bps-only model the two Lightning corridors
 * still want.
 */
export interface Fee {
  bps: number
  flatSats: number
}

/** No spread and no flat charge — what every corridor quoted before this existed. */
export const FREE: Fee = { bps: 0, flatSats: 0 }

/**
 * The fee in sats the solver keeps on a swap of `amountSats`.
 *
 * Rounded UP. The rounding direction is the whole point: rounding a fee down
 * means the solver eats the remainder on every swap, and at a small flat fee
 * and a small amount that remainder is most of the fee.
 */
export const feeSatsFor = (amountSats: number, fee: Fee): number =>
  Math.ceil((amountSats * fee.bps) / 10_000) + fee.flatSats

/**
 * What the taker receives when they give `giveSats`.
 *
 * May be zero or negative on a small amount against a large flat fee — the
 * caller MUST treat that as unquotable rather than as a free swap. Left to the
 * caller rather than clamped here because "the fee ate the swap" and "the swap
 * is below the minimum" want different refusal reasons, and a clamp to zero
 * would silently turn the first into a payout of nothing.
 */
export const payoutSatsFor = (giveSats: number, fee: Fee): number => giveSats - feeSatsFor(giveSats, fee)

/**
 * The smallest `give` whose payout is at least `payoutSats` — the exact-out
 * direction, for a taker who names what they want to receive.
 *
 * Solved by inverting the bps term and then correcting, rather than in closed
 * form: `feeSatsFor` rounds up, so the algebraic inverse lands one sat low
 * about as often as not. The correction loop runs at most twice.
 */
export const giveSatsFor = (payoutSats: number, fee: Fee): number => {
  let give = Math.ceil(((payoutSats + fee.flatSats) * 10_000) / (10_000 - fee.bps))
  while (payoutSatsFor(give, fee) < payoutSats) give++
  return give
}
