/**
 * The seam every source of the solver's own liquidity hooks into.
 *
 * A solver holds money in more than one place and always has: the Arkade float
 * every corridor pays out of, the BTC rail's channel and onchain balances, and —
 * once a chain is configured — token liquidity for the EVM corridors. Until this
 * existed, the console could only READ one of them and could move none, so
 * topping any of them up meant leaving for a node's own CLI, a faucet script or
 * a vendor dashboard.
 *
 * ## Why a seam rather than a Lightning-shaped pair of buttons
 *
 * The first cut of this was "fund the Lightning backend". That is one source of
 * four, and its shape is not the general shape: an Arkade wallet has a boarding
 * address and no arbitrary-destination withdrawal, an EVM rail's deposit is a
 * plain account address and its balance is a token, and each of them splits its
 * balance into a different set of numbers. Anything the console hardcodes about
 * one of them is a thing the next source has to be bent into.
 *
 * So a source declares three things and nothing more: what it is, what it holds,
 * and which of the three operations it can perform.
 *
 * ## Capability, never requirement
 *
 * `depositOptions`, `settleDeposits` and `withdraw` are OPTIONAL, the same way
 * `SendBackend.estimateSendFee` and `OnchainBackend.settleReceiveAddress` are
 * optional on the ports below: a source that cannot do one omits it, and
 * {@link capabilitiesOf} reports what is left so the console renders only the
 * buttons that can work. A method that existed and threw would put a button in
 * front of an operator that is guaranteed to fail, and — worse on a money screen
 * — would make "this source cannot do that" indistinguishable from "the backend
 * is down".
 *
 * The absent-source case is handled the same way one layer up: a deployment with
 * no BTC rail (`Services.ln === null`) simply has no rail source in the
 * registry, exactly as it has no Lightning corridor. {@link requireFundSource}
 * is what an accidental use gets, and it names what IS available rather than
 * reporting an empty balance — which is what a source with no money looks like.
 *
 * ## Amounts are strings, in the source's own base units
 *
 * Not a number, and this is the one decision here that a JS reflex gets wrong.
 * An ERC20 amount is 256-bit and routinely past what a `number` holds exactly,
 * which is why the EVM corridor's own store declares `evm_amount` as TEXT rather
 * than INTEGER. A `number` in this interface would have worked for every BTC
 * source and forced the interface to change for the first token one — which is
 * the definition of the wrong seam.
 */

import { railFundSource } from './railFunds.js'
import { arkadeFundSource } from './arkadeFunds.js'
import type { Services } from './services.js'

/**
 * One named quantity, in the source's own vocabulary.
 *
 * A LIST rather than fixed fields, because the split is the source's to make and
 * the splits genuinely differ: a Lightning half reports outbound and inbound, an
 * onchain wallet reports confirmed and unconfirmed, an Arkade wallet reports
 * whatever the SDK's balance object carries this version. Nothing may sum them —
 * they answer different questions, and two of a source's figures can even be the
 * same sats seen twice (see the rail's `sharedWithLightning`).
 */
export interface FundFigure {
  /** Short enough for a console row: 'channel out', 'confirmed', 'unconfirmed'. */
  label: string
  /**
   * The quantity as a decimal string in {@link FundBalance.unit}, or null when
   * it could not be read.
   *
   * Null is NOT zero, and the distinction is the point: a source that cannot be
   * reached and a source that is empty look identical through a `0`, and only one
   * of them is a reason to go and fix something.
   */
  amount: string | null
  /** Why it could not be read, or a caveat that has to travel with the number. */
  note?: string
}

export interface FundBalance {
  /**
   * What every figure is denominated in — `sats` for the BTC sources, a token
   * symbol for an EVM one. Rendered beside the numbers, never assumed.
   */
  unit: string
  figures: FundFigure[]
}

export interface FundDeposit {
  /** Where the operator sends money so this source can use it. */
  address: string
  /**
   * What kind of address this is, in an operator's terms — 'bitcoin regtest',
   * 'bitcoin regtest (Arkade boarding)', 'ethereum'.
   *
   * Rendered next to the address because the sources do not agree on chain: the
   * same console shows a Bitcoin address and an Ethereum one, and "which network
   * is this" is not answerable from the string alone by everyone who will read
   * it.
   */
  addressKind: string
  /**
   * Whether arriving funds need {@link FundSource.settleDeposits} before this
   * source can spend them.
   *
   * Declared rather than inferred from the presence of that method: a source can
   * HAVE a settle step and still credit ordinary deposits automatically. Without
   * this the operator is left watching a balance that will never move on its own.
   */
  settleRequired: boolean
  /**
   * When this option stops being usable, unix seconds — absent for one that does
   * not expire.
   *
   * An address is good indefinitely; an invoice is not, and an operator who
   * copies one and pays it ten minutes later has sent nothing and has no error
   * to read. The console renders the time remaining rather than the timestamp,
   * because "expired 40 seconds ago" is the sentence that explains a failed
   * payment and a unix integer is not.
   */
  expiresAt?: number
  /**
   * The amount this option is bound to, in the source's own unit — absent when
   * any amount is accepted.
   *
   * An address takes whatever arrives. An invoice may be minted for a fixed
   * amount, and a payer node refuses a different one, so the number belongs
   * beside it rather than assumed.
   */
  amountSats?: number
  /** Anything that must be read before sending. Rendered verbatim. */
  note?: string
}

/** What became of ONE deposit. An outcome, never a throw — one failure must not hide the rest. */
export interface FundSettlement {
  settled: boolean
  /** The source's own id for the deposit or the credit — a txid, a transfer id. */
  reference: string
  /** Present only alongside `settled: false`. */
  reason?: string
}

export interface FundWithdrawal {
  /** The source's own id for the payment — a txid, a transfer id. */
  reference: string
  address: string
  amount: string
  /** Whatever else belongs on the audit row. Source-specific, rendered as-is. */
  detail?: Record<string, string | number>
}

/** Identity, and what the numbers mean. Everything the console needs before it reads anything. */
export interface FundSourceInfo {
  /** Stable, and what a request names. Never shown to an operator — that is {@link label}. */
  id: string
  label: string
  unit: string
}

export interface FundSource extends FundSourceInfo {
  /** What this source holds, split its own way. The one required operation. */
  readBalance(): Promise<FundBalance>

  /**
   * EVERY way an operator can put money into this source, not one.
   *
   * Plural because the sources genuinely have more than one, and choosing for
   * the operator chooses wrong half the time: the Arkade float takes a boarding
   * address (L1, and not float until it is settled) AND an Arkade address (a
   * VTXO, spendable on arrival); a Lightning rail takes an onchain address AND
   * an invoice. Those differ in speed, in fees, and in whether
   * {@link FundSource.settleDeposits} is needed afterwards — which is the whole
   * of what an operator is deciding between.
   *
   * Optional: a source may have no inbound route at all. An EMPTY array is a
   * different answer from the method being absent — "deposits are possible here
   * but none can be offered right now" — and the console says so differently.
   *
   * Implementations MUST validate what they hand back, PER OPTION. An address
   * for the wrong chain is the one mistake nobody downstream can catch, because
   * the operator never typed it and has no reason to doubt it; one bad entry in
   * a list of three is no safer than one bad entry alone.
   */
  depositOptions?(): Promise<readonly FundDeposit[]>

  /**
   * Turn what has arrived into balance this source can spend.
   *
   * Optional, and absent means "arrivals are credited without help" — not "this
   * does nothing". Sweep-shaped: no arguments, and it settles everything it
   * finds, so a deposit that fails one pass is retried by the next.
   */
  settleDeposits?(): Promise<FundSettlement[]>

  /**
   * Send `amount` out of this source to an address the operator named.
   *
   * Optional, and MOST SOURCES SHOULD OMIT IT. It is the only operation here
   * that is irreversible and the only one whose destination is not derived from
   * anything the protocol already decided, so a source offers it exactly when
   * "pay this arbitrary address" is a thing it can genuinely do — not when it
   * can be approximated by a spend that means something else.
   *
   * `amount` is a decimal string in {@link FundSourceInfo.unit}'s base units. An
   * implementation MUST refuse an amount it cannot honour EXACTLY rather than
   * rounding: this is the money path, and a rounded withdrawal is a wrong number
   * nobody typed.
   */
  withdraw?(params: { address: string; amount: string }): Promise<FundWithdrawal>
}

/** Which of the three optional operations a source actually offers. */
export interface FundSourceCapabilities {
  deposit: boolean
  settle: boolean
  withdraw: boolean
}

/**
 * Read off the METHODS, never declared separately.
 *
 * Two places to state the same fact is two places to disagree, and the way they
 * would disagree here is a console offering a withdrawal button for a source
 * that cannot withdraw — a click that can only fail, on the screen where an
 * operator is moving money.
 */
export const capabilitiesOf = (source: FundSource): FundSourceCapabilities => ({
  deposit: source.depositOptions !== undefined,
  settle: source.settleDeposits !== undefined,
  withdraw: source.withdraw !== undefined,
})

/** {@link FundSourceInfo} plus what it can do — the whole of what the console needs to render. */
export interface FundSourceSummary extends FundSourceInfo {
  can: FundSourceCapabilities
}

export const summarise = (source: FundSource): FundSourceSummary => ({
  id: source.id,
  label: source.label,
  unit: source.unit,
  can: capabilitiesOf(source),
})

/**
 * How a consumer adds a source this repo has never heard of.
 *
 * The same shape and the same reasoning as `registerLightningRail`: the shipped
 * CLI runs `main()` at module load, so a source passed as an option to
 * `createServices` could only reach the daemon through a fork of that file.
 * Registering by name means importing this module, calling this once above the
 * entrypoint, and running the shipped console.
 *
 * The factory may answer NULL, which is how "this deployment does not have that
 * source" is said — the built-in rail source does exactly that when
 * `LN_BACKEND` is unset. Returning a source that throws on every read would put
 * a dead panel on the wallet page instead.
 *
 * Module-level state, which is the cost: a source registered after the console
 * has rendered is a source the console will not show until the next load. That
 * is harmless here and is not harmless for `LN_BACKEND`, which is why that one
 * is validated against its registry and this one is not.
 */
export type FundSourceFactory = (services: Services) => FundSource | null

const REGISTERED: FundSourceFactory[] = []

export const registerFundSource = (factory: FundSourceFactory): void => {
  REGISTERED.push(factory)
}

/**
 * The sources this repo ships.
 *
 * Both are factories rather than instances because both depend on the running
 * `Services`, and the rail one answers null on a deployment that has no BTC
 * rail — which is the shape a consumer's factory should copy.
 */
const BUILT_IN: readonly FundSourceFactory[] = [railFundSource, arkadeFundSource]

/**
 * Every source THIS deployment has, built-ins first.
 *
 * A source is in the list exactly when it exists — the rail one is absent
 * without `LN_BACKEND`, in the same way the four BTC corridors are — so the list
 * IS the availability decision, made once instead of re-derived at every button.
 *
 * A duplicate id is refused rather than tolerated: two sources answering to one
 * name means a withdrawal reaches whichever was built first, which is the wrong
 * wallet paying out and would look exactly like a working button.
 */
export const fundSources = (services: Services): FundSource[] => {
  const sources: FundSource[] = []
  const seen = new Set<string>()
  for (const build of [...BUILT_IN, ...REGISTERED]) {
    const source = build(services)
    if (source === null) continue
    if (seen.has(source.id)) {
      throw new Error(
        `two fund sources are registered as '${source.id}' — a withdrawal would reach whichever was built first`,
      )
    }
    seen.add(source.id)
    sources.push(source)
  }
  return sources
}

/**
 * The source this request names, or a refusal that says what IS here.
 *
 * Names the alternatives rather than answering "unknown": the id an operator
 * typed is usually right for a deployment they are thinking of, and the useful
 * answer is which deployment this one is.
 */
export const requireFundSource = (sources: readonly FundSource[], id: unknown): FundSource => {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`source is required and must be one of ${sources.map((s) => s.id).join(', ') || '(none)'}`)
  }
  const source = sources.find((s) => s.id === id)
  if (!source) {
    throw new Error(
      `no fund source '${id}' on this deployment — it has ${sources.map((s) => s.id).join(', ') || 'none'}`,
    )
  }
  return source
}

/** What an operator gets for pressing a button a source does not offer. */
export const capabilityRefusal = (source: FundSource, operation: string, because: string): Error =>
  new Error(`the ${source.label} source cannot ${operation}: ${because}`)
