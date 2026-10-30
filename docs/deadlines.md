# Deadlines, margins and gates

Every timing constant in this service, on one page, each stated once with the
reason it has the value it has.

This page exists because the constants are deliberately spread out. Each
`src/core/*.ts` module is self-contained — a value that coincides with another
module's is **redeclared under the same name rather than imported**, so a module
can be read on its own without chasing imports. That is a good trade for reading
one corridor and a bad one for holding all three in your head, and this page is
the other half of it.

**It is a reference, not a source of truth.** The code is. If a number here
disagrees with `src/`, the code wins and this page is stale.

---

## The one idea

Every swap has two legs, and they are paid at different moments. Whoever moves
**second** is exposed: they have parted with money and are now racing to collect
from the first leg before the first party can take theirs back.

**Every constant below answers "how much time does that race need?"**

The solver always moves second. That is deliberate — it is the party that can
carry the exposure and run the recovery machinery.

---

## Who moves first

| Corridor | Client funds | Solver then | Solver's risk window |
|---|---|---|---|
| `arkade:BTC->lightning:BTC` | the Arkade lockup | pays the invoice, claims the lockup | until the client's Arkade refund opens |
| `lightning:BTC->arkade:BTC` | pays the invoice | funds the Arkade lockup, settles the HTLC | until the held HTLC's own deadline `E` |
| `arkade:BTC->onchain:BTC` | the Arkade lockup | funds the L1 HTLC, claims the lockup | until the client's Arkade refund opens |

The pattern in one line: **the solver's own deadline must always sit a full
margin away from whatever deadline it is racing.** Which direction depends on
who funded what, which is why `arkadeRefundLocktimeFor` and
`onchainRefundLocktimeFor` are mirror images rather than the same function.

---

## The numbers, and why each is what it is

### 90 minutes — three different reasons, and they are not the same quantity

The single most confusing thing in this codebase: **90 minutes appears five
times for three unrelated reasons.** They are not aliases and must be free to
move independently.

| Constant | Where | Why 90 |
|---|---|---|
| `MIN_CLAIM_WINDOW` | `core/send.ts` | Timelocks mature against **median-time-past**, which lags wall clock by ~1 h. A margin smaller than the lag is no margin. |
| `LOCKUP_RECOVERY_MTP_MARGIN_SECONDS` | `arkade/vtxoLifecycle.ts` | The same MTP lag, applied to recovery. Deliberately the same figure. |
| `MIN_SETTLE_WINDOW` | `core/receive.ts` | Operational, not MTP: time to **notice** a preimage, settle, and retry. |
| `ONCHAIN_CLAIM_MARGIN_SECONDS` | `core/onchainSend.ts` | Mirrors the client SDK's constant **by name and value**, so the two sides visibly agree. |
| `MIN_ONCHAIN_FUND_WINDOW` | `core/onchainSend.ts` | Re-checked immediately before funding, not at quote time. |

> If you change one of these because "90 seems long", check which reason you are
> arguing with. Three of them will not care.

### The unit these are all expressed in

Every constant on this page is **unix seconds**, and the deadline model stays
that way end to end. That is true even when the covenant's own CSV leaves count
BLOCKS, which they do against a block-typed arkd (see the runbook's "Block-typed
timelocks").

The two meet at exactly four bounds, and each converts before it adds:

| bound | where |
|---|---|
| `refundLocktimeFor`'s unilateral bound | `core/send.ts` |
| `onchainRefundLocktimeFor`'s server-independent bound | `core/onchainSend.ts` |
| `minHtlcWindowFor`'s gate (d) | `core/receive.ts` |
| `evaluateReceiveFunding`'s gate (d) | `core/receive.ts` |

Conversion is at `NOMINAL_BLOCK_SECONDS` (600), the SDK's own figure — this
number's job is to agree with whoever derives the same script.

> A block delay left unconverted at any of those four does not lose precision,
> it collapses the bound: 20 blocks read as 20 seconds puts the client's refund
> essentially at `now`. That is the double-collect window the bound exists to
> close.

### 2 hours

| Constant | Where | Why |
|---|---|---|
| `REFUND_SAFETY_MARGIN` | `core/send.ts` | Margin on top of the **worst-case HTLC lifetime** before the client's refund may open. Not derived from the 90 above. |
| `MAX_LOCKUP_TIMEOUT` | `core/send.ts` | `= REFUND_SAFETY_MARGIN`. A funding window longer than the margin would quote a deadline the refund cannot sit behind. |
| `MAX_REFUND_HORIZON` | `core/receive.ts` | The **Lightning** receive leg's own refund deadline, and the horizon `selectLockupFunding` prefers that leg's coins to outlive. |
| `ONCHAIN_ORDER_MARGIN_SECONDS` | `core/onchainSend.ts` | Ordering margin between the two legs' deadlines. |
| `EVM_ORDER_MARGIN_SECONDS` | `core/evmSend.ts` | Same role on the EVM corridors. |

### 1 hour

| Constant | Where | Why |
|---|---|---|
| `CLIENT_LOCKUP_RELEASE_DELAY_SECONDS` | `core/onchainSend.ts` | Reorg depth (~6 blocks) under the solver's own L1 refund before the client's Arkade lockup is handed back. **Not a race margin**: once that refund stands the client can never reveal `P`, so the lockup is unclaimable and worth nothing to the solver. What is being waited out is a reorg replacing our refund with their claim, which would turn the release into a double payout. |

### 15 minutes

| Constant | Where | Why |
|---|---|---|
| `DEFAULT_LOCKUP_TIMEOUT` | `core/send.ts` | How long a send quote stays fundable. Operator-tunable via `LOCKUP_TIMEOUT_SECONDS`. |
| `DEFAULT_ONCHAIN_LOCKUP_TIMEOUT` | `core/onchainSend.ts` | The same, for the onchain send leg. |
| `SETTLE_SAFETY_MARGIN` | `core/receive.ts` | Slack between the solver's Arkade refund and the cross-side deadline. |

### 30 minutes

| Constant | Where | Why |
|---|---|---|
| `UNILATERAL_RECOURSE_MARGIN` | `core/receive.ts` | Room to run an on-chain unilateral exit before `E`. Reasoned, not measured — no exit has been driven to completion on any network. |

### 20 minutes

| Constant | Where | Why |
|---|---|---|
| `FEE_BUMP_INTERVAL_SECONDS` | `onchain/feeBump.ts` | How long an L1 spend of ours may sit in the mempool before it is replaced at a higher fee. About two blocks, so an ordinary confirmation beats the replacement rather than racing it. |

### The fee-bump schedule

Every version of an L1 spend of ours, the first one included, pays the rate the
time left before its deadline calls for (`urgencyFeeRate`, `onchain/feeBump.ts`):

| Time left | Rate |
|---|---|
| more than `FEE_BUMP_RAMP_SECONDS` (2 h) | the estimate |
| between the two | geometric from the estimate to the cap |
| at most `FEE_BUMP_ALL_IN_SECONDS` (40 min) | the cap: everything above dust |

A replacement goes out only when that rate beats the standing version by BIP125
rule 4's 1 sat/vB (the vsize is identical across versions). A spend that is
merely waiting far from its deadline is left alone; it is replaced only when the
estimate overtakes it.

The deadlines:

| Spend | Deadline | Why |
|---|---|---|
| send-leg refund | `onchainRefundConfirmDeadline` = `refund_locktime − ARKADE_CLAIM_WINDOW_SECONDS` | A client claim replacing an unconfirmed refund after this reveals `P` too late to claim the Arkade lockup before the client's refund opens. |

Deadline-blind compounding was wrong both ways. On mainnet the send refund's
deadline is a week out and 1.5x every interval burned the HTLC to dust within
hours. Where the exit delay is short,
it never reached the cap before the deadline.

### 2 minutes

| Constant | Where | Why |
|---|---|---|
| `MIN_INVOICE_WINDOW` | `core/send.ts` | Only asks "will the payee still accept this?". It bounds nothing about the money — that is the CLTV held against `refund_locktime`. |

### Derived, not chosen

| Constant | Formula |
|---|---|
| `MAX_LOCKUP_TIMEOUT` | `= REFUND_SAFETY_MARGIN` |
| `DEFAULT_HOLD_INVOICE_WINDOW` | `= MAX_REFUND_HORIZON - MIN_CLAIM_WINDOW`, the `core/receive.ts` copy |
| `refundLocktimeFor(...)` | `max(worstCaseHtlcBlocks * 600 + REFUND_SAFETY_MARGIN, unilateralClaimDelay + REFUND_SAFETY_MARGIN)` |
| `htlcLocktimeFor(...)`, `core/onchainSend.ts` | `now + minConfirmations * 600 + 2 * ONCHAIN_CLAIM_MARGIN_SECONDS` |

**Prefer adding to this table over adding to the ones above.** A derived value
cannot drift from the quantity it depends on; two hand-picked numbers can, and
have — see the history note at the end.

`MAX_REFUND_HORIZON` is now declared once, in `core/receive.ts`, where it is
the Lightning payer's window via `DEFAULT_HOLD_INVOICE_WINDOW` and that leg's
coin-selection horizon. Whether the Lightning
horizon should rise for payer UX is open (#161).

The evidence #161 asked for is now collected rather than argued: every Lightning
receive arm writes a `cltv headroom <E - now>s — <spare>s spare` note against its
swap, where `spare` is how much further out the horizon could have been set and
still funded that payment. A negative one is a payment gate (c) refused. Read
them with `store.history(<swap id>)`; they are notes, so `summariseLatency`
already ignores them.

---

## The gates, in firing order

1. **Admission** — amount inside the corridor's `MIN_SATS`/`MAX_SATS`; total
   in-flight under `MAX_EXPOSED_SATS`; corridor enabled.
2. **Funding window** — the client has `LOCKUP_TIMEOUT_SECONDS`, shortened when
   the invoice expires sooner. Fitted to the invoice rather than demanding an
   invoice that fits it.
3. **Payment** — the gate that guards the money: **is there still a full
   `MIN_CLAIM_WINDOW` before the client's refund opens?** If not, refuse. Paying
   and then losing the claim race means paying twice.
4. **Settle window** (receive legs) — is there still `MIN_SETTLE_WINDOW` before
   the cross-side deadline `E`? If not, decline to fund and let it lapse.
5. **Recovery** (the solver's own coins) — renew what is near expiry, recover
   what has been swept, but **skip the whole round** if a live lockup is still
   short of its CLTV: recovery settles everything at once, so one immature
   lockup fails the batch and takes unrelated coins with it.

---

## The half that is not in this repo

**Some gates live in the client.** A quote can satisfy every rule above and
still be refused by every client, because the client applies its own:

| Client gate | Demands |
|---|---|
| `assertReceivable` | `refund_locktime - min(invoice.expiresAt, valid_until) >= 1800s` |
| `assertFundable` | `refund_locktime - now >= MIN_HEADROOM_SECONDS` (90 min), plus an L1 claim-window check in terms of `ONCHAIN_CLAIM_MARGIN_SECONDS` |

`core/onchainSend.ts` sizes `htlcLocktimeFor` against the client's guardrail
explicitly — *"passes with margin to spare, not right at the boundary"* — and
that is the discipline to copy. `test/interop/clientGates.test.ts` runs the
shipped gates against quotes built by our own wire builders, on every corridor
that has one; that is the check that would have caught the bug below before a
user did, and it is why a change to any quoted deadline belongs in that file
too.

---

## What went wrong once, and why

`DEFAULT_HOLD_INVOICE_WINDOW` and `MAX_REFUND_HORIZON` were both hand-picked and
nobody owned the gap between them. At `2 * HOUR` the claim race was **zero
seconds**; at 95 minutes it was 1500s, under the client's 1800s. Either way every
client refused the receive quote before paying, deterministically — and the
corridor's own tests were green the whole time, because nothing asserted the
relationship.

The fix was to derive one from the other. **That is the general lesson: where two
constants must relate, write the relationship, not the second number.**

---

## Operator-facing

Tunable from the admin console (README § "Settings and defaults" lists every setting):

- `minSats` / `maxSats` / `feeBps` / `feeFlatSats` / `enabled` of each `corridors["<pair>"]`
- `limits.maxExposedSats`
- `rails.lightning.lockupTimeoutSeconds`, bounded `[60, MAX_LOCKUP_TIMEOUT]`

Everything else on this page is a constant. Changing one is a code change, on
purpose: they are the terms on which the solver's own money is at risk.
