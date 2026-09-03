# Building a corridor

A corridor is a pair the solver quotes and settles. The four built-in ones are
implementations of the same interface you implement — nothing about them is
privileged, and a corridor this build never compiled against is served by the
same host, driven by the same sweep and answered for by the same status route.

Everything below is importable from the package entrypoint. If you find yourself
reaching into `packages/`, that is a gap worth reporting.

## The descriptor

```ts
import type { CorridorDescriptor } from '@arkade-os/solver-...'

const descriptor: CorridorDescriptor = {
  pair: 'arkade:BTC->example:BTC', // the RFQ pair, and the registry key
  envStem: 'EXAMPLE', // `EXAMPLE_MAX_SATS`; the pair is not a legal shell identifier
  payoutRail: 'arkade', // which rail's balance funds the payout
  states: {
    live: ['open'], // non-terminal
    exposed: [], // money is out; a subset of `live` by convention
    delivered: ['done'], // settled successfully
  },
}
```

`states` is what lets a host bucket your rows without knowing what any state
_means_. `exposed` is checked first by the admin console, because "money is out"
is the more urgent fact than "in flight".

Both `pair` and `envStem` must be unique. Collisions are refused at composition,
not at dispatch — a duplicate pair would let one corridor shadow another's quote
path, and a duplicate stem would make `<STEM>_ENABLED=false` dark a corridor the
operator did not name.

## The interface

Required:

| Member                     | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `descriptor`               | above                                                                        |
| `quote(payload, options?)` | validate an `rfq_request` against your own schema, and issue or refuse terms |
| `statusFor(rfqId)`         | your row as an `rfq_status` payload, or `null` if you do not hold it         |
| `tick(id)`                 | drive one swap one step                                                      |
| `tickAll()`                | drive every live swap; returns how many moved                                |
| `park(id, reason)`         | take one row out of the sweep; returns the state it landed in               |
| `findRecoverable()`        | rows whose funds are still at a script                                       |
| `committedSats()`          | sats this corridor currently has at risk                                     |
| `page(options)`            | rows for the console, as `CorridorSwapView`                                  |
| `detail(id)`               | one row's raw form and history                                               |
| `close()`                  | release your store                                                           |

Optional, and the omission **is** the contract — a corridor claiming a capability
it cannot honour is worse than one that says nothing:

`liveLockups()` · `tickHot()` · `refundSweep()` · `refundNow(id)` · `claimNow(id)`

Only Lightning-send has `tickHot`; only onchain-receive has `claimNow`.

## Quoting

`quote` returns `CorridorRfqOutcome` — core's shape, not the transport's. That is
what lets you write a corridor against core alone, with no dependency on the
host that dispatches to you.

```ts
quote: async (payload) => {
  const parsed = MyRequest.safeParse(payload)
  if (!parsed.success) {
    return { kind: 'invalid', payload: rfqRefusalPayload(extractRfqId(payload), 'unsupported_payload') }
  }
  // ... price it, write the row ...
  return { kind: 'quote', payload: myQuotePayload(row, rfqId) }
}
```

Three kinds: `quote` (terms issued), `refused` (valid request, declined),
`invalid` (unserviceable request). HTTP maps them to 201 / 422 / 400.

**The refusal vocabulary is closed and the host enforces it.** Every refusing
outcome must name a reason from the RFQ set; a free-text reason, an absent
reason, or a payload over 8 KiB is replaced with `unsupported_payload` on the way
out. Build refusals with `rfqRefusalPayload` and this is automatic.

That gate exists because a solver narrating its internals is describing its own
validation to anyone who asks. Your real reason travels in `detail`, which the
transports log and no payload builder reads.

## Storage

`BaseSwapStore` carries the lifecycle every corridor's store was duplicating —
forward-only transitions with a from-state guard, history, paging. Extend it
rather than reimplementing, and the console and status route work for free.

Transitions are guarded on the state you believe you are in, so two ticks racing
one row produce a thrown error rather than a silent double-spend.

## Registering it

```ts
const services = await createServices(config, { corridors: [myCorridor] })
```

It is now in the registry the sweep drives and both ingresses quote through.
`corridorEnabled` does **not** apply — that is keyed by the closed union of
built-in pairs and cannot name yours. You decide what to pass.

For a host without the rest of the daemon:

```ts
const app = buildApp({
  corridors: createCorridorSet([myCorridor]),
  readers: createCorridorReaderSet([myCorridor]),
  network: 'bitcoin',
})
```

Both sets, deliberately. `readers` is the wider one — it answers status for
corridors that are no longer quoting, so a corridor switched off keeps its
in-flight swaps visible. Register in only the quoting set and your swaps become
unfindable by `rfq_status_request` while still being served.

## What the host will not do for you

- **Decide your money-path invariants.** The safety gates are in each corridor's
  own state machine. Nothing generic checks that you funded before you paid.
- **Price you.** Supply a `PricingStrategy` or do it inside `quote`.
- **Bound your exposure.** `AdmissionControl` is shared and passed in; use it, or
  your corridor is uncapped while every other one is not.

## A worked one, that runs

[`examples/lib/example-corridor.mjs`](../../../examples/lib/example-corridor.mjs)
is every member above in plain code, with no state machine, no store and no
settlement in the way. [`examples/corridor-host.mjs`](../../../examples/corridor-host.mjs)
serves it:

```sh
pnpm build && node examples/corridor-host.mjs
```

No wallet, no database, no environment. It settles nothing — it issues a paper
voucher — which is the point: every line is about the interface.

## Pinning it

`test/packaging/sdkSurface.test.ts` asserts a consumer can define a corridor,
register it and serve it through the shipped host importing nothing but the
entrypoint. `test/packaging/corridorInjection.test.ts` asserts it reaches the
daemon: quotable, driven by `tickAll`, answering status, and refused at
composition on a pair or stem collision.
`test/examples/exampleCorridor.test.ts` drives the worked example above through
the real host and asserts the obligations that are documented and unenforced.

Copy any of them as the starting point for your own. What the framework costs,
counted, and the traps that have already been sprung:
[`docs/authoring.md`](../../authoring.md).
