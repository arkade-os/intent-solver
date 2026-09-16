# Profit and loss

What this solver made, where, and where it went wrong — on the console's **p&l**
tab and at `GET /api/pnl`.

## Read this first: every figure is GROSS

No corridor records what execution actually cost. `ports/lightning.ts`'s
`PaymentResult` carries no routing fee, and no swap table has a fee column, so
**chain fees and routing fees are missing from every total on this screen rather
than deducted from it.**

A corridor quoting 30bp into a fee market that took 40 shows a profit here and
lost money in fact. Netting these out means instrumenting the backends — the
Lightning port would have to report a realized fee alongside the preimage, and
each store a column to keep it in. Until then, treat these numbers as the
revenue line and not the bottom one.

Two other honesty rules hold throughout, and both exist because the alternative
is a number nobody can stand behind:

- **A corridor that cannot answer is UNMEASURED, never zero.** `economics` is an
  optional capability on `CorridorReader`; a corridor without one is named in
  `coverage.unmeasured` rather than averaged in at nothing. A corridor whose
  scan throws is reported the same way — a fault must not read as a complete
  book.
- **An unknown number is null, never zero.** An unfunded quote has no intake. A
  genuine asset-to-asset fill has no sats spread. Both are excluded from the
  totals and counted in `unpricedCount`, so a stablecoin book never reads as
  having made nothing.

## What a swap contributes

Every corridor projects its own rows into one shape (`analytics/economics.ts`).
Only the corridor knows which of its columns the solver received and which it
paid out, and the asymmetry is real:

| corridor | intake | outlay |
| --- | --- | --- |
| `arkade:BTC->lightning:BTC` | the client's **lockup** | the **invoice** |
| `lightning:BTC->arkade:BTC` | `amount_sats` | `payout_sats` |
| `arkade:BTC->onchain:BTC` | `amount_sats` | `payout_sats` |
| `onchain:BTC->arkade:BTC` | `funded_value_sats` ?? `amount_sats` | `funded_payout_sats` ?? `payout_sats` |
| `arkade:<X>->arkade:<Y>` | the client's deposit | what the covenant must deliver |
| ERC20 send | `amount_sats` | the ERC20 |
| ERC20 receive | the ERC20 | `payout_sats` |

The Lightning send leg is the one worth checking twice: it has no payout column
at all, so its two columns are the reverse of every sibling's. `payout_sats` on
the onchain-receive leg is read together with `funded_value_sats` — mixing an
amended intake with a quoted payout invents a spread neither number describes.

**`grossSats`** is the one headline figure, derived two ways. Where both legs
are sats it is `intake - outlay`. Where a corridor settles cross-asset but
persists a sats-denominated payout notional — both ERC20 legs — the corridor
supplies `amount_sats - payout_sats` itself. Where neither holds, it is null.

**`atRiskSats`** is what went out and did not come back: the payout of a row
that is terminal *and* was exposed. A refused row is not a loss — the capital
came back. A live exposed row is not one either — it may still claim. Both are
null, because the distinction an operator acts on is "is this money gone".

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

| parameter | meaning |
| --- | --- |
| `window` | `1h` `6h` `24h` `7d` (default) `30d` `90d` |
| `since` / `until` | unix seconds, half-open. Overrides `window`. |
| `bucket` | `5m` `1h` `6h` `1d`. Defaults from the window's width. |
| `limit` | rows read per corridor, 1–50,000. Default 5,000. |

Rows are windowed on `updated_at` and bucketed by settlement: a swap quoted on
Monday and filled on Tuesday belongs to Tuesday's P&L, because that is the day
the money moved and the day an operator reconciles against a wallet.

The response carries `summary`, `series`, `corridors`, `durationBands`, `fx`
and a `coverage` block naming which corridors were measured, which were not, and
which overflowed their row cap. **`coverage.truncated` is not cosmetic** — it
means the totals cover part of the book, and the console says so rather than
presenting them as all of it.

`GET /api/pnl/swaps` returns the underlying records, newest settlement first,
optionally narrowed with `corridor=`. It is the drill-down from a point on the
scatter back to the swap that made it.

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
