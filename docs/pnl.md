# Profit and loss

What this solver made, where, and where it went wrong — on the console's **p&l**
tab and at `GET /api/pnl`.

## Read this first: every figure is GROSS

`ports/lightning.ts`'s `PaymentResult` carries no routing fee, so what a payment
actually cost is written down nowhere. **Chain fees and routing fees are missing
from every total on this screen rather than deducted from it.**

A corridor quoting 30bp into a fee market that took 40 shows a profit here and
lost money in fact. Netting these out means instrumenting the backends — the
Lightning port would have to report a realized fee alongside the preimage, and
each store a column to keep it in. Until then, treat these numbers as the
revenue line and not the bottom one.

A quote-time **budget** does exist on one corridor: Lightning-send persists
`quoted_routing_fee_sats` and spends against it as `maxFeeSats`. It rides along
as `quotedCostSats` and is **never deducted**, because it is a ceiling rather
than a cost — subtracting an upper bound would understate profit by an unknown
amount while looking exactly like the net figure this screen does not have.
It is there so an operator can see how much of a spread the budget could eat.

Two other honesty rules hold throughout, and both exist because the alternative
is a number nobody can stand behind:

- **A corridor that cannot answer is UNMEASURED, never zero.** `economics` is an
  optional capability on `CorridorReader`; a corridor without one is named in
  `coverage.unmeasured` rather than averaged in at nothing. A corridor that
  **has** the capability and throws is named in `coverage.failed` instead — a
  fault is not a gap in coverage, and folding the two together made a broken
  store read as a corridor nobody had got round to instrumenting.
- **An unknown number is null, never zero.** An unfunded quote has no intake. A
  genuine asset-to-asset fill has no sats spread. Both are excluded from the
  totals and counted in `unpricedCount`, so a stablecoin book never reads as
  having made nothing.

## What a swap contributes

Every corridor projects its own rows into one shape (`analytics/economics.ts`).
Only the corridor knows which of its columns the solver received and which it
paid out, and the asymmetry is real:

| corridor                    | intake                               | outlay                                |
| --------------------------- | ------------------------------------ | ------------------------------------- |
| `arkade:BTC->lightning:BTC` | `lockup_value`                       | **the invoice, re-decoded**           |
| `lightning:BTC->arkade:BTC` | `amount_sats`                        | `payout_sats`                         |
| `arkade:BTC->onchain:BTC`   | `amount_sats`                        | `payout_sats`                         |
| `onchain:BTC->arkade:BTC`   | `funded_value_sats` ?? `amount_sats` | `funded_payout_sats` ?? `payout_sats` |
| `arkade:<X>->arkade:<Y>`    | the client's deposit                 | what the covenant must deliver        |
| ERC20 send                  | `amount_sats`                        | the ERC20                             |
| ERC20 receive               | the ERC20                            | `payout_sats`                         |

**The Lightning send leg is the one worth checking twice, and not for the reason
it looks like.** `amount_sats` there is _the lockup_, not the invoice —
`send/orchestrator.ts` stores `giveSatsFor(invoice, fee)` into it — and the
funding gate then transitions only on `locked === row.amountSats`, refusing an
overfunded lockup outright because an Arkade vtxo is exact-value. So
`lockup_value` and `amount_sats` are **equal by construction** on every row that
can ever be realized, and reading them as a pair reports a flat zero for the
whole corridor at any fee setting. The outlay is the invoice, re-decoded from
the row: the orchestrator calls the persisted invoice authoritative for exactly
this question, and `wire/payloads.ts` already answers the client's `to_amount`
the same way.

`payout_sats` on the onchain-receive leg is read together with
`funded_value_sats` — mixing an amended intake with a quoted payout invents a
spread neither number describes.

**Volume** is the sats size of a trade, taken from whichever leg is sats rather
than from the intake. On the ERC20 receive direction the intake is a token and
the payout is sats, so reading the intake alone let that corridor's spread into
the numerator of a blended margin while contributing nothing to the denominator.

**`grossSats`** is the one headline figure, derived two ways. Where both legs
are sats it is `intake - outlay`. Where a corridor settles cross-asset but
persists a sats-denominated payout notional — both ERC20 legs — the corridor
supplies `amount_sats - payout_sats` itself. Where neither holds, it is null.

**`atRiskSats`** is what went out and did not come back: the payout of a row
that is terminal _and_ was exposed. A refused row is not a loss — the capital
came back. A live exposed row is not one either — it may still claim. Both are
null, because the distinction an operator acts on is "is this money gone".

Where a row IS a loss but its size cannot be said in sats — a token payout on a
corridor with no sats notional — it is counted in `atRiskUnknownCount` rather
than folded into the total as a zero. That counter is the at-risk side's answer
to `unpricedCount`: without it, "nothing is outstanding" and "something is
outstanding and nobody can price it" render as the same reassuring zero.

> On the two ERC20 legs this is an **upper bound**. Their stores' `fail()`
> transitions to `stuck` unconditionally, unlike the four BTC stores, which
> route a failure by exposure. Narrowing it means changing a money path and
> belongs in its own commit.

## The FX question

> "drawn-out swaps that ruin the FX"

A quote commits this solver to a price for its validity window while the market
keeps moving. A fill that took two hours was priced against a two-hour-old view,
so the spread can be textbook and the trade still a loss. Two panels answer it:

- **margin by time to fill** — realized margin banded by duration
  (`<1m`, `1–5m`, `5–30m`, `30m–2h`, `>2h`). If the bottom band is materially
  worse than the top, that gap is what a slow fill costs. It is invisible in any
  total that does not split on time. Unfilled quotes are excluded: their
  "duration" is a validity window, not an execution.
- **rate drift** — one point per cross-asset fill, time-to-fill on a log x-axis
  against how far its executed rate sat from the window's volume-weighted mean
  for the same directional leg. Positive is in the solver's favour. The shape
  worth looking for is points below the line drifting rightward.

The benchmark is **this solver's own book**, not a price feed, and that limit
changes the reading: it answers "was this fill worse than the ones around it",
never "was it worse than the market". A feed-relative mark needs the feed price
at quote time, which nothing records today — that is the other half of the
instrumentation the gross caveat above asks for.

Legs are grouped by corridor **and** direction. `A->B` and `B->A` are
reciprocals, so pooling them would average a rate against its own inverse and
produce a benchmark no fill was ever near.

## The API

`GET /api/pnl` answers the whole screen in one response. That is deliberate:
every panel is a different aggregation of the same scan, and split across five
endpoints a single console refresh would re-read every swap table five times.

| parameter         | meaning                                                |
| ----------------- | ------------------------------------------------------ |
| `window`          | `1h` `6h` `24h` `7d` (default) `30d` `90d`             |
| `since` / `until` | unix seconds, half-open. Overrides `window`.           |
| `bucket`          | `5m` `1h` `6h` `1d`. Defaults from the window's width. |
| `limit`           | rows read per corridor, 1–50,000. Default 5,000.       |

Numeric parameters are parsed from the string, not coerced: `since=` (empty),
`0x10` and `1e18` are all refused rather than silently read as 0, 16 and a
window nobody could mean. A window and bucket that together exceed 5,000 buckets
is refused with the fix named, because `series` allocates one object per bucket
across the whole span and both ends of that quotient come from the request.

Rows are narrowed to their own corridor **in SQL**. That matters on the stores
shared by several markets or tokens: filtering after the row cap would let a
busy market's rows evict a quiet one's from the window, and the quiet corridor
would report no profit for a window in which it settled fills.

Rows are windowed on `updated_at` and bucketed by settlement: a swap quoted on
Monday and filled on Tuesday belongs to Tuesday's P&L, because that is the day
the money moved and the day an operator reconciles against a wallet.

The response carries `summary`, `series`, `corridors`, `durationBands`, `fx` and
a `coverage` block. That block names which corridors were measured, which have
no `economics` capability (`unmeasured`), which **have** it and threw
(`failed`), and which overflowed their row cap (`truncated`).

`unmeasured` and `failed` are separate lists on purpose: a corridor that never
claimed to answer is a gap in coverage, while one that claimed to and failed is
a fault someone should go and look at. **`coverage.truncated` is not cosmetic**
either — it means the totals cover part of the book, and the console says so
rather than presenting them as all of it.

`GET /api/pnl/swaps` returns the underlying records, newest settlement first,
optionally narrowed with `corridor=`. It is the drill-down from a point on the
scatter back to the swap that made it. The body is capped at 2,000 records with
`matchedCount` alongside, so a truncated list can never read as the whole set —
the per-corridor cap bounds each scan, not their concatenation.

Both routes are read-only, like everything on the console but `actions.ts`, and
both sit behind the same deployment assumption as the rest of this port: no
authentication, a reverse proxy in front. See [runbook.md](./runbook.md).

## Known gaps

- **Net-of-fees P&L.** Needs a realized fee on the Lightning port and a column
  per store. The largest single improvement available to this screen.
- **Feed-relative FX marks.** Needs the feed price snapshotted at quote time on
  the asset RFQ row.
- **No CLI equivalent.** The console and the API have it; `cli.ts` does not.
- **Exposure-routed failures on the ERC20 legs**, per the note above.
