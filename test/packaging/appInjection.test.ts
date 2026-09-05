/**
 * A consumer writes the SOLVER ITSELF in plain code — no environment, no global
 * registry, no dynamic import of the shipped CLI.
 *
 * `corridorInjection.test.ts` proves a corridor reaches the daemon and
 * `railInjection.test.ts` proves a backend does. Both answer "how do I extend
 * the shipped app". This one answers the other question: can the app be
 * DESCRIBED rather than configured — a `Config` written as a literal, handed to
 * `createServices` as a parameter, served through `buildApp`, and driven by a
 * loop the consumer owns.
 *
 * The answer is yes for every part except the loop, and that asymmetry is the
 * point of this file. `createServices` cannot be called here — it opens an
 * Arkade wallet and reads a live emulator — so the config half is asserted by
 * COMPILING (the type import below is the assertion, as in `sdkSurface.test.ts`)
 * and the wiring half by source, exactly as the two sibling files do.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as sdk from '@arkade-os/solver-app/index.js'
import type { Config, CorridorSet } from '@arkade-os/solver-app/index.js'
// @ts-expect-error -- untyped .mjs example; the root program has no allowJs
import { voucherCorridor } from '../../examples/lib/example-corridor.mjs'

const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)

/**
 * A whole deployment, as a value. Thirty fields, no `process.env`, nothing read
 * from a file — this file compiling is the claim that `Config` is a shape a
 * consumer can write rather than only a shape `loadConfig` can produce.
 *
 * `loadConfig()` is one WAY to obtain one, not the only one: it is the env
 * adapter, and it reads `process.env` 44 times to build exactly this object.
 */
const solverConfig = (): Config => {
  const limits = sdk.resolveLimits('regtest')
  const free = { bps: 0, flatSats: 0 }
  return {
    network: 'regtest',
    profile: sdk.NETWORKS.regtest,
    limits,
    arkade: {
      mnemonic: 'test mnemonic, never a real one',
      arkServerUrl: 'http://localhost:7070',
      databasePath: ':memory:',
      isMainnet: false,
      arkadeHrp: 'tark',
      expectedArkdNetwork: 'regtest',
    },
    swapDbPath: ':memory:',
    // The four keys are written as PAIR STRINGS rather than through the union
    // that types them. `Record<Corridor, …>` cannot be written by name from the
    // entrypoint: the `Corridor` it exports is the corridor PLUGIN interface
    // (`core/corridor.ts`), while the key type is the closed pair union in
    // `core/corridorPolicy.ts`, which is not exported at all. Two different
    // types, one name — and the literal keys work, which is why this is a
    // discoverability trap rather than a wall.
    corridorLimits: {
      'arkade:BTC->lightning:BTC': limits,
      'lightning:BTC->arkade:BTC': limits,
      'arkade:BTC->onchain:BTC': limits,
      'onchain:BTC->arkade:BTC': limits,
    },
    corridorFees: {
      'arkade:BTC->lightning:BTC': free,
      'lightning:BTC->arkade:BTC': free,
      'arkade:BTC->onchain:BTC': free,
      'onchain:BTC->arkade:BTC': free,
    },
    // Null on every corridor: no live chain-cost pricing, which is what an
    // unset `<STEM>_FEE_CAP_SATS` produces and the only shape this app —
    // which serves no built-in corridor — could want.
    //
    // These three fields arrived AFTER this test was written, on a branch that
    // never touched this file, and the merge of the two failed to compile.
    // That is this test doing its job rather than a merge going wrong: a new
    // REQUIRED field on `Config` is a new question every hand-built solver has
    // to answer, and the compile is what asks it. See the header.
    corridorNetworkFees: {
      'arkade:BTC->lightning:BTC': null,
      'lightning:BTC->arkade:BTC': null,
      'arkade:BTC->onchain:BTC': null,
      'onchain:BTC->arkade:BTC': null,
    },
    onchainFeeRateRefreshMs: 60_000,
    onchainFeeRateStaleMs: 900_000,
    // Every built-in OFF: this deployment serves its own corridor and nothing
    // else, which is what makes `lnBackend: null` legal below.
    corridorEnabled: {
      'arkade:BTC->lightning:BTC': false,
      'lightning:BTC->arkade:BTC': false,
      'arkade:BTC->onchain:BTC': false,
      'onchain:BTC->arkade:BTC': false,
    },
    poolAutoMint: false,
    evmCorridors: [],
    onchainAssetMarkets: [],
    evmMarkets: [],
    // No market, so the offer-packet path is off and its bounds are unread.
    offerMarkets: [],
    offerMinFillAmount: 0n,
    offerMaxFillAmount: 0n,
    lnReceiveAcceptUnilateralGap: false,
    maxExposedSats: 1_000_000,
    contractRetentionMs: 86_400_000,
    sweepConcurrency: 4,
    lockupTimeoutSeconds: 3600,
    sendHintScidDenylist: new Set(),
    emulatorUrl: 'http://localhost:7073',
    // NO BTC RAIL. `createServices` builds one only when this is non-null, so a
    // deployment serving its own corridors never calls `registerLightningRail`
    // and never meets its ordering hazard.
    lnBackend: null,
    fakeLnStatePath: ':memory:',
    lnd: null,
    port: 8080,
    host: '127.0.0.1',
    adminPort: null,
    adminHost: '127.0.0.1',
    relayUrl: null,
    relayProtocol: 'nostr',
    openRfqMaxBidsPerMinute: 60,
    relayHealthPath: '/healthz',
    nostrAdPublish: 'off',
  }
}

describe('a deployment described in code rather than in the environment', () => {
  it('is a plain object, built without reading a single environment variable', () => {
    // The compile is the real assertion; this pins that the value exists and
    // that nothing in building it needed a process environment.
    const config = solverConfig()
    expect(config.network).toBe('regtest')
    expect(config.limits.maxSats).toBeGreaterThan(0)
  })

  /**
   * `loadConfig` enforces this and a hand-built `Config` bypasses it entirely.
   *
   * The rule is `lnBackend` may be null only while all four BTC corridors are
   * off — with it null and one of them on, `createServices` builds no rail and
   * that corridor is simply never constructed, so the pair is refused as
   * unsupported by a solver whose operator believes it is serving.
   */
  it('upholds the rail invariant that only loadConfig would have checked', () => {
    const config = solverConfig()
    expect(config.lnBackend).toBeNull()
    expect(Object.values(config.corridorEnabled).some(Boolean)).toBe(false)
  })

  it('is the same shape createServices takes as a parameter', () => {
    // A type-level claim, so the useful half is the compile. At runtime all that
    // can be said is that the entrypoint exposes the function the config goes to.
    const accepts: (config: Config) => unknown = (config) => sdk.createServices(config, { corridors: [] })
    expect(accepts).toBeTypeOf('function')
  })

  it('needs no rail, because createServices only builds one for a named backend', () => {
    // The branch that makes `lnBackend: null` a supported deployment rather than
    // a crash. Without it the registry would be mandatory for everyone, and with
    // it a consumer serving their own corridors never mutates module state.
    expect(servicesSource).toContain('config.lnBackend === null ? null : await createRail(config)')
  })

  it('takes corridors as a PARAMETER, with no global to mutate first', () => {
    // The contrast worth pinning. A rail is registered by NAME into module-level
    // state that `loadConfig` reads once, so registration has to happen before
    // the entrypoint runs. Corridors have no such ordering hazard: they are
    // arguments.
    expect(servicesSource).toContain('corridorSetFromDeps(corridorDeps, opts?.corridors ?? [])')
    expect(sdk.createServices.length).toBeGreaterThanOrEqual(1)
  })
})

/**
 * The one piece that is NOT describable from outside: the loop.
 *
 * `cli.ts`'s `watchUntilStopped` is a module-private const — four cadences, the
 * boot recovery pass, the lockup watcher, the contract lifecycle and the refund
 * sweep — and `cli.ts` runs `main()` at module load, so importing it to reach
 * the loop runs the CLI instead. A consumer therefore writes their own, and the
 * minimum honest one is small enough to show here.
 *
 * This asserts the SHAPE works, not that it replaces the shipped loop. It has
 * one cadence where the daemon has four and no lockup watcher at all, so it
 * advances a row waiting on a deadline and would be slow to notice funding.
 */
describe('the sweep a consumer has to write themselves', () => {
  /** Every corridor, driven once. The whole contract of `tickAll`. */
  const sweepOnce = async (corridors: CorridorSet): Promise<number> => {
    let driven = 0
    for (const corridor of corridors) driven += await corridor.tickAll()
    return driven
  }

  it('drives an injected corridor to a terminal state', async () => {
    const corridor = voucherCorridor({ now: () => 1_700_000_000 })
    const corridors = sdk.createCorridorSet([corridor])
    const quoted = await corridor.quote({
      v: 1,
      type: 'rfq_request',
      rfq_id: 'a'.repeat(64),
      pair: 'arkade:BTC->voucher:BTC',
      amount: 10_000,
    })
    expect(quoted.kind).toBe('quote')

    // Two passes to terminal, then the loop goes quiet — the condition a
    // consumer's `while (running)` would idle on.
    expect(await sweepOnce(corridors)).toBe(1)
    expect(await sweepOnce(corridors)).toBe(1)
    expect(await sweepOnce(corridors)).toBe(0)
    expect((await corridor.page({})).swaps[0]?.phase).toBe('done')
  })

  it('is what the shipped loop does at boot, over exactly the same set', () => {
    // `services.corridors` is a `CorridorSet`, and the daemon's recovery pass is
    // this loop verbatim. A consumer reproducing the cadences is reproducing
    // policy; reproducing this is reproducing the contract.
    const cliSource = readFileSync(
      fileURLToPath(new URL('../../packages/solver-app/src/cli.ts', import.meta.url)),
      'utf8',
    )
    expect(cliSource).toContain('for (const corridor of services.corridors) recovered += await corridor.tickAll()')
  })
})
