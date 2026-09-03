// Serve a corridor this build was never compiled against — a whole solver in
// forty lines, with no wallet, no database and no environment.
//
//   pnpm build && node examples/corridor-host.mjs
//   curl -s localhost:8080/v1/swap -H 'content-type: application/json' \
//     -d '{"v":1,"type":"rfq_request","rfq_id":"'$(printf 'a%.0s' {1..64})'",
//          "pair":"arkade:BTC->voucher:BTC","amount":10000}'
//
// The corridor is `examples/lib/example-corridor.mjs`; everything else here is
// the shipped host, unmodified. That is the claim worth demonstrating: serving
// a new corridor needs no edit under `solver-core/core/`, `solver-app/admin/`
// or `solver-transport/ingress/` — if it ever does, the interface is incomplete
// and the fix is to extend `Corridor`, never to special-case the host.
//
// `createServices(config, { corridors: [mine] })` is the OTHER way in, and the
// one a production deployment uses: it joins the same registry beside the four
// built-ins and is driven by the shipped `watch` loop. It needs an Arkade
// wallet and a configured environment, which is why this file uses `buildApp`
// instead — nothing here is a reason to prefer one over the other.

import { serve } from '@hono/node-server'
import { buildApp, createCorridorReaderSet, createCorridorSet } from '../packages/solver-app/dist/index.js'
import { voucherCorridor } from './lib/example-corridor.mjs'

const corridor = voucherCorridor()

const app = buildApp({
  // BOTH sets, deliberately. `readers` is the wider one: it answers
  // `rfq_status_request` for corridors that are no longer quoting, so a
  // corridor an operator switched off keeps its in-flight swaps visible.
  // Register in the quoting set alone and your swaps become unfindable by
  // status while still being served.
  corridors: createCorridorSet([corridor]),
  readers: createCorridorReaderSet([corridor]),
  network: process.env.SWAP_NETWORK ?? 'regtest',
  // What a refusal cost, for the log only. The wire answer stays the coarse
  // closed-set reason; this is the half an operator needs to tell six distinct
  // faults apart.
  onRefusal: (context, detail) => console.error(`${context}: ${detail}`),
})

const port = Number(process.env.PORT ?? 8080)

// `overrideGlobalObjects: false` is MANDATORY, not tidiness. By default
// `@hono/node-server` replaces `globalThis.Request` and `globalThis.Response`
// with its own classes the moment a listener is created. Any HTTP client in the
// same process that tests a result with a bare `instanceof Response` — a Rust
// SDK compiled to WebAssembly does exactly this, resolved from global scope at
// call time — then measures a genuine undici `Response` against Hono's
// replacement and gets false. On mainnet that read as an outage at a payment
// provider for most of a day. See `HONO_SERVE_OPTIONS` in solver-app's cli.ts.
serve({ fetch: app.fetch, port, overrideGlobalObjects: false })

console.log(`serving ${corridor.descriptor.pair} on http://localhost:${port}`)
console.log(`  POST /v1/swap          rfq_request — 201 quoted, 422 refused, 400 unserviceable`)
console.log(`  GET  /v1/rfq/<rfq_id>  rfq_status — 404 when no corridor holds it`)
console.log(`  GET  /healthz          liveness`)
