# Deadlines, margins and gates

Every timing constant in this service, on one page, each stated once with the
reason it has the value it has.

This page exists because the constants are deliberately spread out. Each
`src/core/*.ts` module is self-contained — a value that coincides with another
module's is **redeclared under the same name rather than imported**, so a module
can be read on its own without chasing imports. That is a good trade for reading
one corridor and a bad one for holding all four in your head, and this page is
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
| `onchain:BTC->arkade:BTC` | the L1 HTLC | funds the Arkade lockup, claims the HTLC | until the client's L1 CLTV |

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
| `MIN_SETTLE_WINDOW` | `core/receive.ts`, `core/onchainReceive.ts` | Operational, not MTP: time to **notice** a preimage, settle, and retry. |
| `ONCHAIN_CLAIM_MARGIN_SECONDS` | `core/onchainSend.ts` | Mirrors the client SDK's constant **by name and value**, so the two sides visibly agree. |
| `MIN_ONCHAIN_FUND_WINDOW` | `core/onchainSend.ts` | Re-checked immediately before funding, not at quote time. |

> If you change one of these because "90 seems long", check which reason you are
> arguing with. Three of them will not care.

### The unit these are all expressed in

Every constant on this page is **unix seconds**, and the deadline model stays
that way end to end. That is true even when the covenant's own CSV leaves count
BLOCKS, which they do against a block-typed arkd (see the runbook's "Block-typed
timelocks").

The two meet at exactly three bounds, and each converts before it adds:

| bound | where |
|---|---|
| `refundLocktimeFor`'s unilateral bound | `core/send.ts` |
| `onchainRefundLocktimeFor`'s server-independent bound | `core/onchainSend.ts` |
| `minHtlcWindowFor`'s gate (d) | `core/receive.ts` |

Conversion is at `NOMINAL_BLOCK_SECONDS` (600), the SDK's own figure — this
number's job is to agree with whoever derives the same script.

> A block delay left unconverted at any of those three does not lose precision,
> it collapses the bound: 20 blocks read as 20 seconds puts the client's refund
> essentially at `now`. That is the double-collect window the bound exists to
> close.

### 2 hours

| Constant | Where | Why |
|---|---|---|
| `REFUND_SAFETY_MARGIN` | `core/send.ts` | Margin on top of the **worst-case HTLC lifetime** before the client's refund may open. Not derived from the 90 above. |
| `MAX_LOCKUP_TIMEOUT` | `core/send.ts` | `= REFUND_SAFETY_MARGIN`. A funding window longer than the margin would quote a deadline the refund cannot sit behind. |
| `MAX_REFUND_HORIZON` | `core/receive.ts`, `core/onchainReceive.ts` | How far out the **solver's own** refund is set on a receive leg. Also the horizon `selectLockupFunding` prefers coins to outlive. |
| `ONCHAIN_ORDER_MARGIN_SECONDS` | `core/onchainSend.ts` | Ordering margin between the two legs' deadlines. |
| `EVM_ORDER_MARGIN_SECONDS` | `core/evmSend.ts` *(unmerged, #117)* | Same role on the EVM corridors. |

### 15 minutes

| Constant | Where | Why |
|---|---|---|
| `DEFAULT_LOCKUP_TIMEOUT` | `core/send.ts` | How long a send quote stays fundable. Operator-tunable via `LOCKUP_TIMEOUT_SECONDS`. |
| `DEFAULT_ONCHAIN_LOCKUP_TIMEOUT` | `core/onchainSend.ts` | The same, for the onchain send leg. |
| `DEFAULT_ONCHAIN_RECEIVE_LOCKUP_TIMEOUT` | `core/onchainReceive.ts` | The same, client-funded side. |
| `SETTLE_SAFETY_MARGIN` | `core/receive.ts`, `core/onchainReceive.ts` | Slack between the solver's Arkade refund and the cross-side deadline. |

### 2 minutes

| Constant | Where | Why |
|---|---|---|
| `MIN_INVOICE_WINDOW` | `core/send.ts` | Only asks "will the payee still accept this?". It bounds nothing about the money — that is the CLTV held against `refund_locktime`. |

### Derived, not chosen

| Constant | Formula |
|---|---|
| `MAX_LOCKUP_TIMEOUT` | `= REFUND_SAFETY_MARGIN` |
| `DEFAULT_HOLD_INVOICE_WINDOW` | `= MAX_REFUND_HORIZON - MIN_CLAIM_WINDOW` *(#137)* |
| `refundLocktimeFor(...)` | `max(worstCaseHtlcBlocks * 600 + REFUND_SAFETY_MARGIN, unilateralClaimDelay + REFUND_SAFETY_MARGIN)` |
| `htlcLocktimeFor(...)` | `now + minConfirmations * 600 + 2 * ONCHAIN_CLAIM_MARGIN_SECONDS` |

**Prefer adding to this table over adding to the ones above.** A derived value
cannot drift from the quantity it depends on; two hand-picked numbers can, and
have — see the history note at the end.

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
| `assertFundable` | its own headroom check, written in terms of `ONCHAIN_CLAIM_MARGIN_SECONDS` |

`core/onchainSend.ts` sizes `htlcLocktimeFor` against the client's guardrail
explicitly — *"passes with margin to spare, not right at the boundary"* — and
that is the discipline to copy. Nothing in this repo currently runs a client
gate against a quote we produced; that is the check that would have caught the
bug below before a user did.

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

Tunable from the admin console (`docs/environment.md` for the full env list):

- `<CORRIDOR>_MIN_SATS` / `_MAX_SATS` / `_FEE_BPS` / `_FEE_FLAT_SATS` / `_ENABLED`
- `MAX_EXPOSED_SATS`
- `LOCKUP_TIMEOUT_SECONDS`, bounded `[60, MAX_LOCKUP_TIMEOUT]` *(#138)*

Everything else on this page is a constant. Changing one is a code change, on
purpose: they are the terms on which the solver's own money is at risk.
