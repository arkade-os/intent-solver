/**
 * The SDK surface is what `packages/solver-app/src/index.ts` exports, and nothing else.
 *
 * This exists because the gap it closes was invisible from inside the tree:
 * `Corridor`, `CorridorDescriptor`, the registry and all four policy strategies
 * were built to be implemented from OUTSIDE, were public within `src/`, and
 * were exported from the package entrypoint by none of it. Every one looked
 * reachable while being unreachable to a consumer — "anyone can build their own
 * solver" was false at the package boundary and true everywhere a maintainer
 * would have looked.
 *
 * Values are asserted at RUNTIME; types can only be asserted by compiling, so
 * the type imports below are the assertion — this file failing to typecheck is
 * the failure.
 */
import { describe, it, expect } from 'vitest'
import * as sdk from '@arkade-os/solver-app/index.js'
import type {
  Corridor,
  CorridorReader,
  CorridorDescriptor,
  CorridorRfqOutcome,
  CorridorSwapView,
  QuoteOptions,
  PricingStrategy,
  AdmissionStrategy,
  BiddingStrategy,
  Rail,
  RailId,
  CovenantScriptRow,
  StoreShape,
} from '@arkade-os/solver-app/index.js'

/** Referenced so the type imports above are load-bearing rather than elidable. */
type _Surface = [
  Corridor,
  CorridorReader,
  CorridorDescriptor,
  CorridorRfqOutcome,
  CorridorSwapView,
  QuoteOptions,
  PricingStrategy,
  AdmissionStrategy,
  BiddingStrategy,
  Rail,
  RailId,
  CovenantScriptRow,
  StoreShape<unknown, string>,
]

describe('the solver SDK surface', () => {
  it.each([
    'createCorridorSet',
    'createCorridorReaderSet',
    'createCorridorRegistry',
    'BaseSwapStore',
    'phaseOfStates',
    'diagnose',
    'fixedFeePricing',
    'defaultBidding',
    'readRails',
    'balanceOfRail',
    'createServices',
    // Bring your own BTC backend. A registry rather than an option on
    // `createServices`, because the CLI runs `main()` at module load — see
    // ops/rails.ts, and railInjection.test.ts for the claim it makes good.
    'registerLightningRail',
    'lightningRailNames',
    'lightningRailFor',
    // What a corridor's own `quote` needs to refuse an unparseable payload.
    'extractRfqId',
    'zodDetail',
    'rfqRefusalPayload',
    // The SHARED exposure cap; a corridor building its own is uncapped.
    'AdmissionControl',
  ])('exports %s, so a consumer can build against it', (name) => {
    expect(sdk[name as keyof typeof sdk]).toBeDefined()
  })

  /**
   * The registry is the one piece a corridor author cannot work around: without
   * it they can implement `Corridor` and have nowhere to put it.
   */
  it('lets a consumer register a corridor using only the entrypoint', () => {
    const descriptor: CorridorDescriptor = {
      pair: 'arkade:BTC->example:BTC',
      envStem: 'EXAMPLE',
      payoutRail: 'arkade',
      states: { live: ['open'], exposed: [], delivered: ['done'] },
    }
    const corridor = {
      descriptor,
      quote: async () => ({ kind: 'refused' as const, payload: {} }),
      statusFor: async () => null,
      tick: async () => {},
      tickAll: async () => 0,
      park: async () => ({ state: 'stuck' }),
      findRecoverable: async () => [],
      committedSats: async () => 0,
      page: async () => ({ swaps: [], nextCursor: null }),
      detail: async () => null,
      close: async () => {},
    }
    const set = sdk.createCorridorSet([corridor])
    expect(set.get('arkade:BTC->example:BTC')?.descriptor.envStem).toBe('EXAMPLE')
  })

  it('lets a consumer supply their own pricing without forking a corridor', () => {
    const flat: PricingStrategy = {
      payoutFor: ({ giveSats }) => giveSats - 7,
      giveFor: ({ payoutSats }) => payoutSats + 7,
    }
    expect(flat.payoutFor({ pair: 'a->b', giveSats: 100 })).toBe(93)
    // And the shipped default is reachable to compare against.
    expect(sdk.fixedFeePricing({ bps: 0, flatSats: 7 }).payoutFor({ pair: 'a->b', giveSats: 100 })).toBe(93)
  })
})

/**
 * The end-to-end claim, from a CONSUMER's position: write a corridor, register
 * it, and serve it through the host this package ships — importing nothing but
 * the entrypoint.
 *
 * The surface test above proves the types are reachable. This proves they are
 * USABLE: it was possible to export every type, pass that test, and still have
 * a consumer unable to serve their corridor, because `buildApp` derived its
 * registry from the four built-in services and had no way to be told otherwise.
 */
describe('serving a corridor this build never compiled against', () => {
  const descriptor: CorridorDescriptor = {
    pair: 'arkade:BTC->example:BTC',
    envStem: 'EXAMPLE',
    payoutRail: 'arkade',
    states: { live: ['open'], exposed: [], delivered: ['done'] },
  }

  const corridor = (quoted: string[]) => ({
    descriptor,
    quote: async (payload: unknown) => {
      const amount = (payload as { amount?: unknown }).amount
      if (typeof amount !== 'number') {
        return { kind: 'invalid' as const, payload: { v: 1, type: 'rfq_refusal', reason: 'unsupported_payload' } }
      }
      quoted.push(`${amount}`)
      return { kind: 'quote' as const, payload: { v: 1, type: 'rfq_quote', to_amount: amount - 3 } }
    },
    statusFor: async () => null,
    tick: async () => {},
    tickAll: async () => 0,
    park: async () => ({ state: 'stuck' }),
    findRecoverable: async () => [],
    committedSats: async () => 0,
    page: async () => ({ swaps: [], nextCursor: null }),
    detail: async () => null,
    close: async () => {},
  })

  const post = async (app: ReturnType<typeof sdk.buildApp>, body: unknown) =>
    app.fetch(
      new Request('http://host/v1/swap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )

  it('quotes through the shipped HTTP host', async () => {
    const quoted: string[] = []
    const app = sdk.buildApp({
      corridors: sdk.createCorridorSet([corridor(quoted)]),
      // The four built-ins are absent entirely — no dummy stores needed, since
      // the host is handed its sets rather than deriving them from named stores.
      readers: sdk.createCorridorReaderSet([]),
      network: 'regtest',
    })
    const res = await post(app, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: 'arkade:BTC->example:BTC',
      amount: 1_000,
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ to_amount: 997 })
    expect(quoted).toEqual(['1000'])
  })

  it('refuses a pair it does not serve, by name', async () => {
    const app = sdk.buildApp({
      corridors: sdk.createCorridorSet([corridor([])]),
      readers: sdk.createCorridorReaderSet([]),
      network: 'regtest',
    })
    const res = await post(app, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'b'.repeat(64),
      pair: 'arkade:BTC->nothing:BTC',
      amount: 1_000,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: 'unsupported_pair' })
  })

  /** The host still owns the wire, even for a corridor it has never seen. */
  it('scrubs a rogue corridor’s free-text reason on the way out', async () => {
    const rogue = {
      ...corridor([]),
      quote: async () => ({ kind: 'refused' as const, payload: { reason: 'internal: float below 12000' } }),
    }
    const app = sdk.buildApp({
      corridors: sdk.createCorridorSet([rogue]),
      readers: sdk.createCorridorReaderSet([]),
      network: 'regtest',
    })
    const res = await post(app, {
      v: 1,
      type: 'rfq_request',
      rfq_id: 'c'.repeat(64),
      pair: 'arkade:BTC->example:BTC',
      amount: 1_000,
    })
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('float below')
    expect(body).toContain('unsupported_payload')
  })
})
