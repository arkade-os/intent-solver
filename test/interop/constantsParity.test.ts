/**
 * Every quantity this service shares with `@arkade-os/swap`, in one place.
 *
 * ## Why this file exists
 *
 * These constants are declared twice — here and in the client package — in two
 * repositories with different release cadences. That is the maintenance problem
 * this file is aimed at: not the duplication itself, which is sometimes right,
 * but the fact that nothing said which duplicates MUST agree and which are
 * allowed to differ.
 *
 * So the list below is the answer, written down once and checked by CI.
 *
 * ## Why not just import them
 *
 * Importing every shared number would look tidier and would be worse. It
 * couples this service's release to the SDK's: changing our own margin would
 * need an SDK release and a version bump here, for a value the SDK has no
 * opinion about. That cost is already visible — ts-sdk#763 merged and is not in
 * any published release, so anything gated on it waits.
 *
 * Importing is right where a value is PROTOCOL — where the two sides must agree
 * byte for byte or the corridor breaks. It is wrong where a value is OUR
 * policy. This file draws that line explicitly rather than leaving it to
 * whoever edits next.
 *
 * ## The trap this exists to prevent
 *
 * `MIN_CLAIM_WINDOW_SECONDS` (SDK, 1800) and `MIN_CLAIM_WINDOW` (ours, 5400)
 * are near-homonyms that mean different things. A sweep that "unified" them
 * would cut a money-path margin by a factor of three, below the BIP-113
 * median-time-past lag that justifies it — and every test would stay green,
 * because they would all move together. The last section pins them APART.
 */

import { describe, it, expect } from 'vitest'
import * as swap from '@arkade-os/swap'
// EVERY local copy, not one of each.
//
// `core/*.ts` modules are self-contained on purpose: a value that coincides
// with another module's is redeclared under the same name rather than imported,
// so a corridor can be read without chasing imports (docs/deadlines.md states
// the convention). Three of these quantities therefore exist TWICE in `src/`.
//
// A parity test that pinned one copy would be worse than none: it would report
// agreement with the SDK while the other copy — the one the send leg's
// `htlcLocktimeFor` actually reads — drifted underneath it. So each declaration
// is imported under its own name and checked separately, which also pins the
// two local copies to each other by transitivity.
import {
  MAX_MIN_CONFIRMATIONS as RECEIVE_MAX_MIN_CONFIRMATIONS,
  MIN_MIN_CONFIRMATIONS as RECEIVE_MIN_MIN_CONFIRMATIONS,
  ONCHAIN_SECONDS_PER_BLOCK as RECEIVE_SECONDS_PER_BLOCK,
  ONCHAIN_DUST_SATS as RECEIVE_DUST_SATS,
} from '@arkade-os/solver-core/core/onchainReceive.js'
import {
  MAX_MIN_CONFIRMATIONS as SEND_MAX_MIN_CONFIRMATIONS,
  MIN_MIN_CONFIRMATIONS as SEND_MIN_MIN_CONFIRMATIONS,
  ONCHAIN_SECONDS_PER_BLOCK as SEND_SECONDS_PER_BLOCK,
  ONCHAIN_DUST_SATS as SEND_DUST_SATS,
  ONCHAIN_CLAIM_MARGIN_SECONDS,
  ONCHAIN_ORDER_MARGIN_SECONDS,
} from '@arkade-os/solver-core/core/onchainSend.js'
import { MIN_CLAIM_WINDOW } from '@arkade-os/solver-core/core/send.js'
import { RFQ_PAIR_SEND } from '@arkade-os/solver-corridors/wire/payloads.js'
import { RFQ_PAIR_RECEIVE } from '@arkade-os/solver-corridors/wire/lightningReceivePayloads.js'
import { RFQ_PAIR_ONCHAIN_SEND } from '@arkade-os/solver-corridors/wire/onchainPayloads.js'
import { RFQ_PAIR_ONCHAIN_RECEIVE } from '@arkade-os/solver-corridors/wire/onchainReceivePayloads.js'

/**
 * Values that MUST match, because both sides compute against them and a
 * disagreement is a bug rather than a policy difference.
 *
 * The pair strings are the clearest case: they are the wire's own vocabulary,
 * matched by string equality on both sides, so a divergence does not degrade
 * anything — it makes the corridor unaddressable. The rest are quantities the
 * client checks a quote against, so a mismatch means we build quotes to a rule
 * the client is not applying.
 */
const MUST_MATCH: ReadonlyArray<{ what: string; ours: unknown; theirs: unknown; why: string }> = [
  {
    what: 'RFQ_PAIR_SEND',
    ours: RFQ_PAIR_SEND,
    theirs: swap.LIGHTNING_SEND_PAIR,
    why: 'wire vocabulary — string-matched on both sides, so drift makes the corridor unaddressable',
  },
  { what: 'RFQ_PAIR_RECEIVE', ours: RFQ_PAIR_RECEIVE, theirs: swap.LIGHTNING_RECEIVE_PAIR, why: 'as above' },
  { what: 'RFQ_PAIR_ONCHAIN_SEND', ours: RFQ_PAIR_ONCHAIN_SEND, theirs: swap.ONCHAIN_SEND_PAIR, why: 'as above' },
  {
    what: 'RFQ_PAIR_ONCHAIN_RECEIVE',
    ours: RFQ_PAIR_ONCHAIN_RECEIVE,
    theirs: swap.ONCHAIN_RECEIVE_PAIR,
    why: 'as above',
  },
  {
    what: 'ONCHAIN_SECONDS_PER_BLOCK (core/onchainReceive.ts)',
    ours: RECEIVE_SECONDS_PER_BLOCK,
    theirs: swap.ONCHAIN_SECONDS_PER_BLOCK,
    why: 'both convert blocks to seconds when sizing the same deadline',
  },
  {
    what: 'ONCHAIN_SECONDS_PER_BLOCK (core/onchainSend.ts)',
    ours: SEND_SECONDS_PER_BLOCK,
    theirs: swap.ONCHAIN_SECONDS_PER_BLOCK,
    why: "the send leg's own copy — this is the one htlcLocktimeFor reads",
  },
  {
    what: 'MAX_MIN_CONFIRMATIONS (core/onchainReceive.ts)',
    ours: RECEIVE_MAX_MIN_CONFIRMATIONS,
    theirs: swap.MAX_MIN_CONFIRMATIONS,
    why: 'we cap what a client may request; a client that believes a higher cap asks for what we refuse',
  },
  {
    what: 'MAX_MIN_CONFIRMATIONS (core/onchainSend.ts)',
    ours: SEND_MAX_MIN_CONFIRMATIONS,
    theirs: swap.MAX_MIN_CONFIRMATIONS,
    why: "the send leg's own copy — raised here, the service accepts depths the client's cap refuses",
  },
  {
    what: 'ONCHAIN_CLAIM_MARGIN_SECONDS',
    ours: ONCHAIN_CLAIM_MARGIN_SECONDS,
    theirs: swap.ONCHAIN_CLAIM_MARGIN_SECONDS,
    why: 'the client checks our htlc_locktime against this exact figure before funding',
  },
  {
    what: 'ONCHAIN_ORDER_MARGIN_SECONDS',
    ours: ONCHAIN_ORDER_MARGIN_SECONDS,
    theirs: swap.ONCHAIN_ORDER_MARGIN_SECONDS,
    why: 'the ordering margin between the two legs, applied by both sides',
  },
]

describe('quantities this service shares with @arkade-os/swap', () => {
  it.each(MUST_MATCH.map((c) => [c.what, c] as const))('%s agrees with the SDK', (_what, c) => {
    expect(c.ours).toBe(c.theirs)
  })

  /**
   * The control, for the same reason `onchainHtlcParity.test.ts` carries one:
   * every assertion above is an equality against an imported namespace. If that
   * import resolved to nothing, `c.theirs` would be `undefined` on every row and
   * the failures would at least be loud — but a partially-shaped stub would not
   * be. Pinning one known value proves the namespace is the real package.
   */
  it('is reading the real package, not an empty namespace', () => {
    expect(swap.LIGHTNING_SEND_PAIR).toBe('arkade:BTC->lightning:BTC')
    expect(Object.keys(swap).length).toBeGreaterThan(20)
  })

  /**
   * `ONCHAIN_DUST_SATS` agrees on the VALUE and disagrees on the TYPE: 330 here,
   * 330n there. It is in its own case because `toBe` fails on that pair — `330
   * === 330n` is false — and rolling it into the table above would either force
   * a cast that hides the difference or a looser matcher for every row.
   *
   * Worth pinning rather than papering over. This boundary already carries a
   * type disagreement in the other direction (the SDK's own sources differ on
   * whether an asset amount is a `bigint` or a decimal `string`), and dust is a
   * quantity both sides compare a payout against. A comparison written the
   * obvious way — `payout > ONCHAIN_DUST_SATS` with one of each — throws at
   * runtime rather than answering wrongly, which is the better failure but only
   * if someone is expecting it.
   *
   * Asserted through an explicit widening so the equality is about the number
   * and the type difference stays visible in the test rather than being
   * silently absorbed.
   */
  it.each([
    ['core/onchainReceive.ts', RECEIVE_DUST_SATS],
    ['core/onchainSend.ts', SEND_DUST_SATS],
  ])('agrees with the SDK on the dust value in %s, across a type boundary', (_where, ours) => {
    expect(typeof ours).toBe('number')
    expect(typeof swap.ONCHAIN_DUST_SATS).toBe('bigint')
    expect(BigInt(ours)).toBe(swap.ONCHAIN_DUST_SATS)
  })
})

/**
 * Values that must NOT be unified, stated as assertions so a future "cleanup"
 * has to argue with a test rather than with a comment.
 */
describe('quantities that look shared and are not', () => {
  it('keeps our claim margin distinct from the client’s claim-window floor', () => {
    // The SDK's is the CLIENT's minimum: the least it will accept between the
    // last moment a payer can arm a swap and the solver's own refund, below
    // which it refuses the quote. Ours is the SOLVER's margin before paying
    // out, set to 90 minutes because a BIP-113 timelock matures against
    // median-time-past, which lags wall clock by about an hour — a margin
    // smaller than the lag is not a margin.
    //
    // Same subject, different party, different job. Unifying them under the
    // shorter name would cut ours to 1800s, below the lag it exists to cover,
    // and no test would notice because they would move together.
    // `toBeGreaterThan` already implies they differ, so the separate `not.toBe`
    // it replaced was noise rather than a second guarantee.
    expect(MIN_CLAIM_WINDOW).toBeGreaterThan(swap.MIN_CLAIM_WINDOW_SECONDS)
  })

  /**
   * The relationship that DOES have to hold between them, which is the reason
   * the difference above is safe rather than merely tolerated.
   *
   * Ours being the larger of the two means any quote satisfying our own rule
   * satisfies the client's as well. If that ever inverts, we would be building
   * quotes the shipped client refuses — the outage `clientGates.test.ts` exists
   * to prevent, arriving through the constants instead of through a derivation.
   */
  it('is strictly more conservative than the client requires, never less', () => {
    expect(MIN_CLAIM_WINDOW).toBeGreaterThanOrEqual(swap.MIN_CLAIM_WINDOW_SECONDS)
  })
})

/**
 * Our OWN two copies, which is a different hazard from SDK parity.
 *
 * `core/onchainReceive.ts` redeclares the confirmation-depth constants rather
 * than importing them, deliberately and for the reason its header gives. That
 * makes drift between the two legs possible in a way the SDK comparison above
 * would never catch — both legs could agree with the SDK on the ceiling and
 * still disagree with each other on the floor.
 */
describe('the two onchain legs agree with each other', () => {
  it('shares one confirmation floor, so neither leg can be quoted at zero-conf alone', () => {
    // The floor is TLA+ finding F2's fix. A leg that lost it would fund against
    // a replaceable transaction while the other refused — and the refusal would
    // look like the bug.
    expect(RECEIVE_MIN_MIN_CONFIRMATIONS).toBe(SEND_MIN_MIN_CONFIRMATIONS)
    expect(RECEIVE_MIN_MIN_CONFIRMATIONS).toBeGreaterThan(0)
  })

  it('shares one ceiling too, which the SDK checks separately but never against each other', () => {
    expect(RECEIVE_MAX_MIN_CONFIRMATIONS).toBe(SEND_MAX_MIN_CONFIRMATIONS)
  })
})
