/**
 * A consumer's BTC rail reaches the shipped daemon, WITHOUT forking `packages/solver-app/src/cli.ts`.
 *
 * The same claim `corridorInjection.test.ts` makes for corridors, for the other
 * injectable unit — and it is the harder of the two, because the CLI is the
 * obstacle rather than the host. `packages/solver-app/src/cli.ts` calls `createServices` at sixteen
 * sites and runs `main()` at module load, so a rail passed as an OPTION could
 * only reach the daemon through a copy of that file: a consumer maintaining a
 * fork of every command in order to add one backend. A registry keyed by name
 * is what makes `LN_BACKEND=mine` enough.
 *
 * `createServices` cannot be called here — it needs an Arkade wallet, a
 * Lightning node and a chain — so the two halves are tested where they can be:
 * the registry and the config validation at RUNTIME, and the one line in
 * `createServices` that consults them by source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as sdk from '@arkade-os/solver-app/index.js'
import { lightningRailFor, lightningRailNames, registerLightningRail } from '@arkade-os/solver-app/ops/rails.js'
import type { LightningRail, LightningRailModule } from '@arkade-os/solver-app/index.js'
import { loadConfig } from '@arkade-os/solver-app/config.js'
import { valueImports } from '../support/importScan.js'

const servicesSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/services.ts', import.meta.url)),
  'utf8',
)
const configSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/config.ts', import.meta.url)),
  'utf8',
)
const railsSource = readFileSync(
  fileURLToPath(new URL('../../packages/solver-app/src/ops/rails.ts', import.meta.url)),
  'utf8',
)

/**
 * A rail with both legs, exactly as a private repo would write one: a vendor
 * wallet behind two ports. The legs are stubs because nothing here CONSTRUCTS
 * it — what is under test is whether the name is reachable.
 */
const RAIL = 'injected-rail'
const injected: LightningRailModule = {
  create: async (): Promise<LightningRail> => ({
    ln: { name: 'ln-leg' } as unknown as LightningRail['ln'],
    onchain: { name: 'onchain-leg' } as unknown as LightningRail['onchain'],
  }),
  mintPayeeInvoice: async () => 'lnbcrt1injected',
}
registerLightningRail(RAIL, injected)

/** The minimum `loadConfig` needs, plus the rail under test. */
const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  LN_BACKEND: RAIL,
}

/**
 * Cleared as well as set. The whole suite shares one process environment, so a
 * `<STEM>_ENABLED=false` or an `EVM_TOKENS` left behind by another file would
 * change what `loadConfig` does here — and the first of those would exempt this
 * deployment from needing a rail at all, which is precisely the property under
 * test.
 */
const CLEARED = [
  'LN_SEND_ENABLED',
  'LN_RECEIVE_ENABLED',
  'ONCHAIN_SEND_ENABLED',
  'ONCHAIN_RECEIVE_ENABLED',
  'EVM_TOKENS',
]

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  const keys = [...Object.keys(BASE_ENV), ...CLEARED]
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  for (const key of CLEARED) delete process.env[key]
  Object.assign(process.env, BASE_ENV)
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('a consumer rail joins the shipped daemon', () => {
  it('is selectable by LN_BACKEND, which is what avoids forking the CLI', () => {
    // The whole seam in one assertion: the operator names the rail in the
    // environment, and `loadConfig` — which every command already calls —
    // accepts it because it asks the registry what exists.
    expect(loadConfig().lnBackend).toBe(RAIL)
    expect(lightningRailNames()).toContain(RAIL)
  })

  it('is looked up by the same name createServices resolves', () => {
    expect(lightningRailFor(RAIL)).toBe(injected)
  })

  it('supplies BOTH legs, because all four BTC corridors take one from it', () => {
    // The onchain pair is the non-obvious half: it has no Lightning in its name
    // and reads its backend off this same object, so a rail that returned only
    // `ln` would leave two corridors unbuildable.
    expect(servicesSource).toContain('ln: rail!.ln')
    expect(servicesSource).toContain('onchain: rail!.onchain')
  })

  it('is what createServices falls through to, after the built-ins', () => {
    // Order is load-bearing: `lnd` and `fake` are answered directly, so a
    // consumer's rail can never shadow one. `registerLightningRail` refuses
    // those names as well — belt and braces on a money path.
    //
    // Compared by position in the whole file rather than inside a sliced
    // function body: each of these strings occurs exactly once, and a slice
    // keyed on a brace or a newline is a scan that silently matches nothing.
    const lookup = servicesSource.indexOf('lightningRailFor(')
    const fake = servicesSource.indexOf("config.lnBackend === 'fake'")
    const lnd = servicesSource.indexOf("config.lnBackend === 'lnd'")
    // Presence first, and reported together. `indexOf` answers -1 for a string
    // that is simply gone, and -1 is less than everything — so an ordering
    // assertion alone would go green on a file that no longer branches on the
    // built-ins at all.
    expect(Math.min(lookup, fake, lnd)).toBeGreaterThan(-1)
    expect(fake).toBeLessThan(lookup)
    expect(lnd).toBeLessThan(lookup)
    expect(servicesSource).toContain('rail.create(config)')
  })

  it('is admitted by the config validator, not just by the registry', () => {
    // A registry the validator does not read would accept the module and then
    // refuse the name at boot — the seam existing and being unusable.
    expect(configSource).toContain('lightningRailNames()')
  })

  it('costs `loadConfig` no runtime dependency, which is what lets config read it', () => {
    // `config.ts` value-imports the registry, and `db/driver.ts` statically
    // imports the `better-sqlite3` NATIVE binding. A value import added here
    // would be one hop from being loaded by every caller of `loadConfig()` —
    // including tests that touch no database at all. The same property
    // `test/corridors/registry.test.ts` protects for the descriptor modules,
    // and the reason this module holds only `import type`.
    expect(valueImports(railsSource)).toEqual([])
  })

  it('can mint the payee invoice the `invoice` command asks for', async () => {
    // Optional on the port, because opening a second wallet from a second seed
    // is a vendor capability rather than something the CLI can synthesise.
    expect(await lightningRailFor(RAIL)?.mintPayeeInvoice?.(loadConfig(), 1000)).toBe('lnbcrt1injected')
  })
})

describe('the rail seam is reachable from the entrypoint', () => {
  it('exports the registry, so a consumer imports nothing internal', () => {
    expect(sdk.registerLightningRail).toBeTypeOf('function')
    expect(sdk.lightningRailNames).toBeTypeOf('function')
    expect(sdk.lightningRailFor).toBeTypeOf('function')
  })

  it('names the same registry the daemon reads', () => {
    // Two module instances would give a consumer a registration the service
    // never sees — the failure this assertion exists to catch, since both look
    // identical from the caller's side.
    expect(sdk.lightningRailFor(RAIL)).toBe(injected)
  })
})
