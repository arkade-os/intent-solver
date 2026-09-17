# Profit and loss

What this solver made, where, and where it went wrong — on the console's **p&l**
tab and at `GET /api/pnl`.

## Read this first: what is net and what is gross

A figure is **net** only where a rail reported what execution actually cost.
Today that is the **Lightning send leg alone**: its backend answers with the
routing fee it paid once a payment settles, and the row keeps it in
`routing_fee_paid_sats`.

Every other rail reports no realized cost at all — `OnchainTxOutcome` is a
status word, `fund()` answers `{txid, vout}`, and the Arkade lifecycle reports
no per-transaction fee. On those corridors chain fees are **missing from the
total rather than deducted from it**, and a corridor quoting 30bp into a fee
market that took 40 still shows a profit here.

So the screen carries both. `grossSats` never has anything deducted.
`netSats` is `grossSats - realizedCostSats`, and is **null rather than falling
back to the gross** wherever a cost is unknown — a net figure derived from a
missing cost is just the gross wearing a different label, which is the one
misreading this screen must not produce. `costedCount` says over how much of the
book the net figure holds, and `coverage.basis` answers `mixed` when part of the
window is net and part is gross.

Every net figure is computed over the **costed rows alone** — their own gross,
their own volume. Netting a window's whole gross against a cost drawn from part
of it overstates the margin by exactly the uncosted share.

A quote-time **budget** also exists on the send row (`quoted_routing_fee_sats`,
spent against as `maxFeeSats`). It rides along as `quotedCostSats` and is
**never deducted**: it is a ceiling, not a cost.

The realized fee is stored in whole satoshis, rounded **up** from the millisat
truth. Summed over many payments that overstates cost by up to a sat each, so
**reported net profit is a floor, not the exact figure**. Round-to-nearest would
be worse — a real sub-sat fee would read as `0`, and zero means free here.
Carrying millisats is the fix; tracked in #155.

Two other honesty rules hold throughout, and both exist because the alternative
is a number nobody can stand behind:

- **A corridor that cannot answer is UNMEASURED, never zero.** `economics` is an
  optional capability on `CorridorReader`; a corridor without one is named in
  `coverage.unmeasured` rather than averaged in at nothing. A corridor that
  **has** the capability and throws is named in `coverage.failed` instead — a
  fault is not a gap in coverage, and folding the two together made a broken
  store read as a corridor nobody had got round to instrumenting.
- **An unknown number is null, never zero.** An unfunded quote has no intake, so
  its amounts, spread and rate are all null — a quote is a set of terms, and
  reporting them as an execution gives a swap that never happened a rate that
  looks like one. Each corridor decides from its own evidence: a lockup value, a
  deposit txid, a held-HTLC deadline, or — where no column records the client's
  side — its own lifecycle. Such a row is counted in `openCount`.
- A realized fill that cannot be priced in sats — a genuine asset-to-asset one —
  is excluded from the totals and counted in `unpricedCount`, so a stablecoin
  book never reads as having made nothing.

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
>
> **That qualifier is in the API, not only here.** `atRiskUpperBound` is on each
> record, on every corridor row and on the summary, and the console prefixes the
> figure with `≤`. A caller building tooling on this endpoint never reads this
> file, and a bare number they cannot tell is a ceiling is exactly the kind of
> figure this screen exists not to publish.

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

Two benchmarks, answering different questions. Both signed so **positive is in
the solver's favour**.

- **vs peers** (`driftBps`) — against this window's volume-weighted mean rate for
  the same leg, i.e. this solver's own book. Finds a bad _fill_.
- **vs market** (`marketDriftBps`) — the price a quote FIXED, against the feed
  read again **when the fill landed**. Finds a market that _ran away_.

The second is what the first cannot give: a market that moved against every quote
in a window leaves them all looking flawless beside each other.

It must be **two observations at two times**. Snapshotting the feed at quote time
and comparing it to the quote derived from that same instant is a tautology — it
returns the configured spread on every input and can never go negative. An
earlier attempt shipped exactly that and was withdrawn.

**The spread is inside this number, so zero is the breakeven line.** A flat
market reads as roughly the margin; below zero the market has moved further than
the margin covered and the fill is under water.

"Roughly" is exact enough to rely on and is not an identity. At ordinary fees a
flat market reads exactly `feeBps` on both legs, but the buying leg is really
`feeBps / (1 − feeBps/10⁴)` — indistinguishable below 1%, `526` at `feeBps: 500`
— and a flat per-trade fee adds to it. **The zero crossing is exact on both legs
at every fee**, which is the part the screens actually lean on. On a 30bp market:

| market at fill | mark |
| --- | --- |
| +10% | `+1033bp` |
| flat | `+30bp` |
| −0.3% | `0bp` — breakeven, the move exactly ate the margin |
| −1% | `-70bp` |

The direction bit (`quote_gives_base`) is what makes it signable: the ratio is
quote-per-base either way, but paying less quote per base is good when the solver
buys base and bad when it sells, so one unnormalised subtraction would call the
same move good on one leg and bad on the other.

The comparison is exact bigint, cross-multiplied — the stored implied price and
the fill-time observation are carried at their own scales and neither is rescaled
into the other — and divides once into basis points.

**The fill-time read never blocks a fill.** It runs *after* the `filling ->
filled` transition, so a slow feed cannot widen the window in which a crash
leaves a submitted fill reading `filling` (which `recoverFilling` escalates to
`stuck`). Every failure — no market, an unreadable feed, a non-positive price —
leaves the mark null and the fill untouched, and is reported as a **price** fault
rather than a swap fault. Each leg reports `markedCount` beside its median, so a
mark covering part of a leg is never read as covering all of it.

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

## From a terminal

`pnl [1h|24h|7d|30d|90d]` prints the same figures without a browser, for a box
where `ADMIN_PORT` is not set or not reachable. It reads the same
`economics()` and runs the same pure aggregations as the screen, so the two
cannot disagree. The rendering lives in `ops/pnlReport.ts` as a pure function
because it formats money and therefore has to be testable.

## Known gaps

- **Realized cost on every rail but Lightning send.** Needs a port change per
  rail: a fee on `OnchainBackend.fund()`/`transactionOutcome`, and a per-transaction
  figure from the Arkade lifecycle. The model already carries it — those
  corridors report `realizedCostSats` null and are counted out of `costedCount`
  rather than netted at zero.
- **Feed-relative marks on corridors other than asset RFQ.** The other cross-asset
  legs (both ERC20 directions) quote against configuration rather than a live
  feed, so there is no market price to snapshot.
- **`atRiskSats` is an upper bound on the two ERC20 legs**, per the note above.
