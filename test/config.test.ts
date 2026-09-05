/**
 * `LN_BACKEND`, and only it.
 *
 * Every other enum-shaped knob `loadConfig` reads refuses input it does not
 * understand — `SWAP_NETWORK` and `RELAY_PROTOCOL` throw, and the numeric ones
 * go through `intFromEnv`. `LN_BACKEND` was the exception: a chain of `===`
 * comparisons ending in a bare default, so every unrecognised value landed on
 * whichever backend that default named.
 *
 * That fall-through is why this file exists rather than a broader config suite.
 * The knob selects which BTC rail holds real money — Lightning AND onchain, one
 * wallet — so a typo that resolved to a working backend would leave every
 * component behaving correctly and simply being the wrong components. Nothing
 * downstream can catch that. There is now no default at all, for the same
 * reason: a deployment that forgets the variable must not silently come up on
 * whichever vendor this file happened to name.
 *
 * The checkpoint-exit-delay override earns a place beside it on the same
 * grounds. It lowers a fund-safety bound the SDK otherwise enforces for us
 * (`assertValidServerUnrollScript`), and nothing downstream can catch a
 * deployment that relaxes it by mistake: every component works, the bound is
 * simply gone. It is a network fact rather than an env knob precisely so that
 * mistake has no route onto mainnet — these tests pin that.
 *
 * `DB_DIR` belongs on the same grounds. It decides where the money-critical
 * swap database is opened, and every way of getting it wrong is silent: a
 * precedence slip moves an existing deployment's files and the service starts
 * cleanly on empty tables, and a blank value asks better-sqlite3 for a private
 * temporary database that is discarded at exit. Nothing downstream can tell
 * either from a first run.
 *
 * `POOL_AUTO_MINT` meets the same bar. It decides whether the daemon SPENDS the
 * float unattended, on a timer, and every way of getting it wrong is quiet: a
 * truthy coercion would turn `POOL_AUTO_MINT=false` into automated spending an
 * operator explicitly tried to decline, and nothing downstream can tell an
 * intended mint from an unintended one — both are well-formed settlements.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { basename, join } from 'node:path'
import { loadConfig } from '@arkade-os/solver-app/config.js'
import { adminDbPath } from '@arkade-os/solver-app/admin/db.js'
import { registerLightningRail, type LightningRailModule } from '@arkade-os/solver-app/ops/rails.js'
import { CORRIDORS } from '@arkade-os/solver-core/core/corridorPolicy.js'
import { descriptorFor } from '@arkade-os/solver-corridors/corridors/index.js'
import { REFUND_SAFETY_MARGIN } from '@arkade-os/solver-core/core/send.js'
import { MAX_BIP68_SECONDS } from '@arkade-os/solver-core/core/timelocks.js'

/**
 * A rail registered exactly as a consumer's private repo would register one, so
 * the assertions below run against the extension point rather than around it.
 *
 * Module scope, not `beforeEach`: registration is refused twice for the same
 * name, and `loadConfig` reads the registry when it validates — which is the
 * ordering a consumer has to get right too (register at import time, above the
 * entrypoint).
 *
 * Nothing here CONSTRUCTS it. `create` would need a wallet; what is under test
 * is whether the name is accepted, and by that point the rail has already done
 * its job.
 */
const TEST_RAIL = 'test-rail'
const unbuildableRail: LightningRailModule = {
  create: async () => {
    throw new Error('the config suite never builds services')
  },
}
registerLightningRail(TEST_RAIL, unbuildableRail)

/** The four `<STEM>_ENABLED` knobs, which together decide whether a rail is required. */
const CORRIDOR_ENABLED_KEYS = CORRIDORS.map((corridor) => `${descriptorFor(corridor).envStem}_ENABLED`)

/**
 * Everything `loadConfig` reads that could perturb these assertions. Cleared
 * per test rather than trusting the runner's environment: a developer with
 * LN_BACKEND already exported would otherwise get results that depend on their
 * shell.
 */
const CONFIG_KEYS = [
  // Listed so the save/restore above cleans them up: a leaked `EVM_TOKENS`
  // would give every later test in the run corridors it never asked for.
  'EVM_TOKENS',
  'EVM_USDC_PRICE_FEED',
  'EVM_USDC_PRICE_PATH',
  'EVM_SEND_USDC_MAX_SATS',
  'EVM_SEND_USDC_MIN_SATS',
  'EVM_SEND_USDC_FEE_BPS',
  'EVM_RECEIVE_USDC_ENABLED',
  'LN_BACKEND',
  // Listed for the same reason `EVM_TOKENS` is: a leaked `LN_SEND_ENABLED=false`
  // would silently exempt every later test from needing a rail at all.
  ...CORRIDOR_ENABLED_KEYS,
  'ARK_MNEMONIC',
  'ARK_SERVER_URL',
  'EMULATOR_URL',
  'SWAP_NETWORK',
  'MAX_EXPOSED_SATS',
  'SWEEP_CONCURRENCY',
  'LOCKUP_TIMEOUT_SECONDS',
  'NOSTR_AD_PUBLISH',
  'DB_DIR',
  'SWAP_DB_PATH',
  'ARK_DB_PATH',
  'FAKE_LN_STATE_PATH',
  'POOL_AUTO_MINT',
  'CONTRACT_RETENTION_DAYS',
  'LN_SEND_HINT_SCID_DENYLIST',
  // Listed for the same reason `EVM_TOKENS` is: a leaked `OFFER_MARKETS` would
  // give every later test in the run an offer path it never asked for, and one
  // that then demands bounds those tests do not set.
  'OFFER_MARKETS',
  'OFFER_MIN_FILL_AMOUNT',
  'OFFER_MAX_FILL_AMOUNT',
  // Same reason again: a leaked `ASSET_MARKETS` gives every later test an
  // atomic-class corridor it never asked for, and one that then demands a
  // console market row those tests do not write.
  'ASSET_MARKETS',
  'ASSET_QUOTE_VALIDITY_SECONDS',
  'ASSET_USDA_BUY_ENABLED',
  'ASSET_USDA_SELL_ENABLED',
]

/**
 * The minimum that gets `loadConfig` to the end.
 *
 * `LN_BACKEND` is in here now, and has to be: the four BTC corridors default to
 * enabled and every one of them needs a rail, so an unset value is a startup
 * error rather than a default. It is the registered TEST RAIL rather than `lnd`
 * (which would demand a socket, a cert and a macaroon) or `fake` (which
 * `loadConfig` refuses on mainnet, and several tests below set
 * `SWAP_NETWORK=bitcoin`).
 */
const BASE_ENV: Record<string, string> = {
  SWAP_NETWORK: 'regtest',
  ARK_MNEMONIC: 'test mnemonic, never a real one',
  ARK_SERVER_URL: 'http://localhost:7070',
  EMULATOR_URL: 'http://localhost:7073',
  LN_BACKEND: TEST_RAIL,
}

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]]))
  for (const key of CONFIG_KEYS) delete process.env[key]
  Object.assign(process.env, BASE_ENV)
})

afterEach(() => {
  for (const key of CONFIG_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('loadConfig — LN_BACKEND', () => {
  it('accepts fake', () => {
    process.env.LN_BACKEND = 'fake'
    expect(loadConfig().lnBackend).toBe('fake')
  })

  it('tolerates surrounding whitespace rather than reading it as a typo', () => {
    // A trailing space in an env file is invisible in every editor and, before
    // the exact-match chain was replaced, silently meant the default backend.
    process.env.LN_BACKEND = ' fake '
    expect(loadConfig().lnBackend).toBe('fake')
  })

  it('refuses a value that differs only in case', () => {
    process.env.LN_BACKEND = 'LND'
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('refuses a typo instead of quietly selecting a working backend', () => {
    process.env.LN_BACKEND = 'Ind'
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('names the values it will accept, so the error is self-fixing', () => {
    process.env.LN_BACKEND = 'nonsense'
    // The built-ins AND the registry: an operator who mistyped a consumer
    // rail's name is told what this build actually has, not just what it ships.
    expect(() => loadConfig()).toThrow(/lnd.*fake.*test-rail/)
  })

  it('refuses a retired name rather than keeping it alive by accident', () => {
    // A deprecation that goes on working through a fall-through is the least
    // discoverable way for a deprecation to not happen.
    process.env.LN_BACKEND = 'real'
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('refuses LN_BACKEND=fake on mainnet — it can claim lockups without paying', () => {
    process.env.SWAP_NETWORK = 'bitcoin'
    process.env.LN_BACKEND = 'fake'
    expect(() => loadConfig()).toThrow(/LN_BACKEND=fake/)
  })

  it('carries the network the Arkade server must report from the profile', () => {
    process.env.SWAP_NETWORK = 'bitcoin'
    expect(loadConfig().arkade.expectedArkdNetwork).toBe('bitcoin')
  })
})

/**
 * A rail a consumer registered is selectable by name, and shadowing is refused.
 *
 * This is the whole reason `LN_BACKEND` is no longer a closed union: the private
 * repo that adds a custodial, an LSP or any other vendor backend must run the
 * SHIPPED cli — `packages/solver-app/src/cli.ts` calls `createServices` at sixteen sites and runs
 * `main()` at module load, so an option would have meant forking it.
 *
 * The shadow case is the money one. `LN_BACKEND=lnd` silently resolving to
 * consumer code would move a deployment onto a backend nobody chose while its
 * config file still read `lnd`.
 */
describe('loadConfig — a registered rail', () => {
  it('is accepted by name, exactly like a built-in', () => {
    process.env.LN_BACKEND = TEST_RAIL
    expect(loadConfig().lnBackend).toBe(TEST_RAIL)
  })

  it('cannot take a built-in name', () => {
    expect(() => registerLightningRail('lnd', unbuildableRail)).toThrow(/built-in/)
    expect(() => registerLightningRail('fake', unbuildableRail)).toThrow(/built-in/)
  })

  it('cannot be registered twice under one name', () => {
    // Two registrations means one of them is running and neither caller knows
    // which. Refused at the call, where it is visible.
    expect(() => registerLightningRail(TEST_RAIL, unbuildableRail)).toThrow(/already registered/)
  })
})

/**
 * `LN_BACKEND` is REQUIRED, and the one exemption.
 *
 * All four BTC corridors take BOTH their legs from the rail — the onchain pair
 * as much as the Lightning pair, since one wallet answers both ports — so the
 * exemption is not "the Lightning corridors are off", it is "no BTC corridor is
 * served at all". A deployment quoting only EVM or asset flow is the case that
 * genuinely needs no Lightning node, and demanding one from it would be
 * demanding infrastructure for corridors it does not run.
 *
 * The failure that makes this worth pinning runs the other way: an unset
 * variable that resolved to some default would put a solver's real money on a
 * vendor nobody chose, and the config file would say nothing at all.
 */
describe('loadConfig — LN_BACKEND is required unless no BTC corridor is served', () => {
  const disableAll = (): void => {
    for (const key of CORRIDOR_ENABLED_KEYS) process.env[key] = 'false'
  }

  it('refuses an unset value while any BTC corridor is enabled', () => {
    delete process.env.LN_BACKEND
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('treats set-but-empty as unset, like every other knob here', () => {
    process.env.LN_BACKEND = '   '
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('still refuses it when only the ONCHAIN corridors are left on', () => {
    // The non-obvious half. The onchain pair has no Lightning in its name and
    // takes its backend from this knob anyway, so exempting on "the Lightning
    // corridors are off" would start a solver that quotes onchain swaps with
    // nothing to fund or claim them.
    delete process.env.LN_BACKEND
    process.env.LN_SEND_ENABLED = 'false'
    process.env.LN_RECEIVE_ENABLED = 'false'
    expect(() => loadConfig()).toThrow(/LN_BACKEND/)
  })

  it('names the accepted set and the exemption, so the error is self-fixing', () => {
    delete process.env.LN_BACKEND
    expect(() => loadConfig()).toThrow(/lnd, fake/)
    expect(() => loadConfig()).toThrow(/_ENABLED=false/)
  })

  it('allows it to be unset once every BTC corridor is disabled', () => {
    delete process.env.LN_BACKEND
    disableAll()
    expect(loadConfig().lnBackend).toBeNull()
  })

  it('still honours an explicit rail on such a deployment', () => {
    // Exempt is not forbidden: an operator who leaves the variable set while
    // darkening the corridors has said something, and turning one back on must
    // not need a second edit.
    disableAll()
    process.env.LN_BACKEND = 'fake'
    expect(loadConfig().lnBackend).toBe('fake')
  })
})

describe('loadConfig — checkpoint exit delay override', () => {
  it('relaxes the floor to 4096s on mutinynet, the only network that needs it', () => {
    // Exactly what the hosted Service advertises, decoded from the
    // `checkpointTapscript` at https://mutinynet.arkade.sh/v1/info:
    // `03 080040 b2 75 20 <forfeitPubkey> ac`. The 3-byte BIP68 push is
    // little-endian 0x400008 — bit 22 set means 512s units, 8 x 512 = 4096.
    // Exact, not lower: the SDK's comparison is a strict `<`, so this accepts
    // that Service and refuses one that later shortens its delay further.
    process.env.SWAP_NETWORK = 'mutinynet'
    expect(loadConfig().arkade.minCheckpointExitDelaySeconds).toBe(4096)
  })

  it('leaves mainnet on the SDK 24h floor', () => {
    // The bound mainnet must never relax, and the reason the value belongs to
    // the network profile: there is no input to loadConfig that reaches it, so
    // a testnet env file copied toward mainnet carries nothing that can.
    process.env.SWAP_NETWORK = 'bitcoin'
    expect(loadConfig().arkade.minCheckpointExitDelaySeconds).toBeUndefined()
  })

  it('leaves regtest alone, where the SDK floor is already 1200', () => {
    process.env.SWAP_NETWORK = 'regtest'
    expect(loadConfig().arkade.minCheckpointExitDelaySeconds).toBeUndefined()
  })
})

/**
 * The Arkade wallet's own view of L1, which is NOT `LND_ESPLORA_URL`.
 *
 * Unset is a real deployment state and stays supported — the SDK falls back to
 * a per-network default. What makes the knob necessary is that the regtest
 * default is `http://localhost:3000/api`: inside a container that resolves to
 * the container itself, and the wallet degrades SILENTLY, logging "Failed to
 * fetch chain tip; height-based expiry will not be evaluated" once and then
 * leaving block-denominated VTXO expiry unwatched. A test that only covered
 * the set case would leave the fallback — the state every existing deployment
 * is in — unpinned.
 */
describe('loadConfig — ARK_ESPLORA_URL', () => {
  it('passes the operator-supplied explorer through to the wallet config', () => {
    process.env.ARK_ESPLORA_URL = 'http://mempool_web/api'
    expect(loadConfig().arkade.esploraUrl).toBe('http://mempool_web/api')
  })

  it('leaves it undefined when unset, keeping the SDK per-network default', () => {
    delete process.env.ARK_ESPLORA_URL
    expect(loadConfig().arkade.esploraUrl).toBeUndefined()
  })

  it('is independent of the Lightning side explorer', () => {
    // Two chains' worth of questions answered by one host only by coincidence.
    // Setting one must not move the other, or a deployment that points the
    // Lightning side at a private Esplora silently repoints the Arkade wallet
    // with it.
    process.env.LND_ESPLORA_URL = 'http://lightning-side/api'
    delete process.env.ARK_ESPLORA_URL
    expect(loadConfig().arkade.esploraUrl).toBeUndefined()
  })
})

/**
 * `NOSTR_AD_PUBLISH` belongs beside LN_BACKEND for the same reason the file's
 * header gives: it is enum-shaped, and the value an operator most needs it to
 * hold is the one a typo would silently produce. `off` is the default AND the
 * refusing state — `publishNow` throws under it — so a mistyped `ato` reading
 * as `off` would leave an operator who asked for automatic advertising with a
 * solver that never advertises and a console that refuses to make it, with
 * nothing anywhere saying why.
 */
describe('loadConfig — NOSTR_AD_PUBLISH', () => {
  it('defaults to off, so a deployment that sets nothing touches no relay', () => {
    expect(loadConfig().nostrAdPublish).toBe('off')
  })

  it('treats set-but-empty as unset', () => {
    process.env.NOSTR_AD_PUBLISH = '   '
    expect(loadConfig().nostrAdPublish).toBe('off')
  })

  it('accepts each mode', () => {
    for (const mode of ['off', 'manual', 'auto'] as const) {
      process.env.NOSTR_AD_PUBLISH = mode
      expect(loadConfig().nostrAdPublish).toBe(mode)
    }
  })

  it('tolerates whitespace and case rather than reading them as a typo', () => {
    // Deliberately laxer than LN_BACKEND, which refuses `LND`. That knob picks
    // which vendor holds real money; this one only decides whether to
    // advertise, so normalising costs nothing a wrong answer would cost there.
    process.env.NOSTR_AD_PUBLISH = ' Auto '
    expect(loadConfig().nostrAdPublish).toBe('auto')
  })

  it('refuses a typo instead of quietly meaning off', () => {
    process.env.NOSTR_AD_PUBLISH = 'ato'
    expect(() => loadConfig()).toThrow(/NOSTR_AD_PUBLISH/)
  })

  it('names the values it will accept, so the error is self-fixing', () => {
    process.env.NOSTR_AD_PUBLISH = 'yes'
    expect(() => loadConfig()).toThrow(/off.*manual.*auto/)
  })
})

/**
 * `DB_DIR`, and why every expectation below is built with `join` rather than
 * written as a literal.
 *
 * `dbDir` composes with `node:path`'s `join`, which emits the HOST's separator
 * — `/data/swaps.sqlite` on Linux, `\data\swaps.sqlite` on Windows. Literal
 * `/`-joined strings therefore pin the CI runner's platform rather than the
 * behaviour, and fail on a Windows checkout for a reason no test here owns.
 *
 * Building the expected value the same way loses nothing: `join` still has to
 * do the composing and the normalising, so the trailing-slash case below is
 * still a real assertion about normalisation and not a tautology — `'/data/'`
 * and `'/data'` have to arrive at the same answer.
 */
describe('loadConfig — DB_DIR', () => {
  it('defaults to .data, where every database went before it existed', () => {
    const config = loadConfig()
    expect(config.swapDbPath).toBe(join('.data', 'swaps.sqlite'))
    expect(config.arkade.databasePath).toBe(join('.data', 'ark.sqlite'))
    expect(config.fakeLnStatePath).toBe(join('.data', 'fake-ln.json'))
  })

  it('places every database file, so one variable answers the whole question', () => {
    process.env.DB_DIR = '/data'
    const config = loadConfig()
    expect(config.swapDbPath).toBe(join('/data', 'swaps.sqlite'))
    expect(config.arkade.databasePath).toBe(join('/data', 'ark.sqlite'))
    expect(config.fakeLnStatePath).toBe(join('/data', 'fake-ln.json'))
    // The four siblings are suffixed off the swap path rather than named, so
    // moving the directory has to carry them along. adminDbPath is the one that
    // is exported; the corridor stores use the identical rule in packages/solver-app/src/cli.ts.
    expect(adminDbPath(config.swapDbPath)).toBe(join('/data', 'swaps-admin.sqlite'))
  })

  it('keeps the filenames, so an existing volume is picked up rather than started fresh', () => {
    // The whole non-breaking claim in one assertion: only the directory is new.
    process.env.DB_DIR = '/data'
    expect(basename(loadConfig().swapDbPath)).toBe('swaps.sqlite')
  })

  it('yields to a path that names one file, so no deployment moves under it', () => {
    // The upgrade case: DB_DIR arrives in the image ENV while the deployment
    // still passes the two paths it always passed. Losing that argument means
    // opening an empty swap database and reporting nothing wrong.
    process.env.DB_DIR = '/somewhere/else'
    process.env.SWAP_DB_PATH = '/data/swaps.sqlite'
    process.env.ARK_DB_PATH = '/data/ark.sqlite'
    const config = loadConfig()
    expect(config.swapDbPath).toBe('/data/swaps.sqlite')
    expect(config.arkade.databasePath).toBe('/data/ark.sqlite')
  })

  it('lets the two paths disagree with each other, as they always could', () => {
    process.env.DB_DIR = '/data'
    process.env.ARK_DB_PATH = '/wallets/ark.sqlite'
    const config = loadConfig()
    // Verbatim, not joined: an explicit path is passed through untouched.
    expect(config.arkade.databasePath).toBe('/wallets/ark.sqlite')
    expect(config.swapDbPath).toBe(join('/data', 'swaps.sqlite'))
  })

  it('treats set-but-empty as unset, on the directory and on the paths', () => {
    // Not cosmetic: better-sqlite3 reads '' as "open a private temporary
    // database", so the blank form used to start a solver that wrote every swap
    // row to a file it discarded on exit.
    process.env.DB_DIR = '   '
    process.env.SWAP_DB_PATH = ''
    expect(loadConfig().swapDbPath).toBe(join('.data', 'swaps.sqlite'))
  })

  it('tolerates a trailing slash, which is how a directory is usually typed', () => {
    // The assertion is that '/data/' and '/data' land in the same place, which
    // is `join` normalising rather than the two strings being spelled alike.
    process.env.DB_DIR = '/data/'
    expect(loadConfig().swapDbPath).toBe(join('/data', 'swaps.sqlite'))
  })

  it('accepts a relative directory, for a checkout that keeps state beside it', () => {
    process.env.DB_DIR = 'var/state'
    expect(loadConfig().swapDbPath).toBe(join('var/state', 'swaps.sqlite'))
  })
})

/**
 * Both bounds on the funding window, and which reasoning each rests on.
 *
 * It earns a place here on the same grounds as the knobs above: nothing
 * downstream can catch a wrong value. The window is the gap between quoting —
 * when `refundLocktime` is fixed, absolutely — and paying, and every second of
 * it is spent out of the margin the deadline reserves for claiming.
 *
 * The ceiling is `REFUND_SAFETY_MARGIN`, DERIVED rather than chosen, and it is
 * not the 3480 that used to sit here. That one was justified by keeping a
 * quote-time invoice floor under BOLT11's 3600s default expiry, a floor that no
 * longer exists (`lockupDeadlineFor`); it was removed for that reason and the
 * removal was right on its own terms. What went unnoticed is that 3480 was ALSO
 * holding the window under this margin by accident. `payableCltvBlocks` now
 * enforces the real invariant at payment time, so this is defence in depth
 * rather than the only guard — but a window past the margin can only produce
 * swaps that refuse themselves, so refusing it at boot is the honest answer.
 */
describe('loadConfig — LOCKUP_TIMEOUT_SECONDS', () => {
  it('defaults to the 15-minute constant', () => {
    expect(loadConfig().lockupTimeoutSeconds).toBe(900)
  })

  it('accepts a window past the retired 3480s ceiling', () => {
    // The case that ceiling rejected outright, and the reason removing it was
    // right: a longer window is clipped to the invoice at quote time and the
    // CLTV ceiling is clipped to the deadline at payment time.
    process.env.LOCKUP_TIMEOUT_SECONDS = '3600'
    expect(loadConfig().lockupTimeoutSeconds).toBe(3600)
  })

  it('accepts a window at exactly the safety margin', () => {
    process.env.LOCKUP_TIMEOUT_SECONDS = String(REFUND_SAFETY_MARGIN)
    expect(loadConfig().lockupTimeoutSeconds).toBe(REFUND_SAFETY_MARGIN)
  })

  it('refuses a window past the safety margin, which would spend the whole claim budget', () => {
    // A quote funded at the end of a window this long has consumed every second
    // the deadline set aside for claiming, so `payableCltvBlocks` would clamp
    // below anything routable and the swap would refuse itself. Refusing at boot
    // says so once instead of once per swap.
    process.env.LOCKUP_TIMEOUT_SECONDS = String(REFUND_SAFETY_MARGIN + 1)
    expect(() => loadConfig()).toThrow(/LOCKUP_TIMEOUT_SECONDS/)
  })

  it('still refuses a window below the 60s floor', () => {
    // The lower bound is untouched and unrelated: a window shorter than a minute
    // is a quote nobody can fund, not a policy choice.
    process.env.LOCKUP_TIMEOUT_SECONDS = '59'
    expect(() => loadConfig()).toThrow(/LOCKUP_TIMEOUT_SECONDS/)
  })

  it('names both bounds in the error, so the error is self-fixing', () => {
    process.env.LOCKUP_TIMEOUT_SECONDS = 'soon'
    expect(() => loadConfig()).toThrow(new RegExp(`an integer between 60 and ${REFUND_SAFETY_MARGIN}`))
  })
})

/**
 * How long a disabled contract row survives before deletion. Same guard shape
 * as `MAX_EXPOSED_SATS`: a non-finite or negative value must throw rather than
 * be absorbed — `now - NaN >= NaN` is false, so NaN would silently retire
 * nothing forever, the quiet direction of wrong.
 */
describe('CONTRACT_RETENTION_DAYS', () => {
  it('defaults to 30 days', () => {
    expect(loadConfig().contractRetentionMs).toBe(30 * 86_400_000)
  })

  it.each(['0', '-1', 'abc', 'Infinity'])('rejects %s', (raw) => {
    process.env.CONTRACT_RETENTION_DAYS = raw
    expect(() => loadConfig()).toThrow(/CONTRACT_RETENTION_DAYS must be a positive finite number/)
  })

  it('accepts a fractional day, which the validator permits', () => {
    // Informational rather than prescriptive: the parse mirrors
    // `MAX_EXPOSED_SATS` exactly, so 0.5 -> 12h passes. If a fractional day is
    // ever ruled out, this test is where that decision gets recorded.
    process.env.CONTRACT_RETENTION_DAYS = '0.5'
    expect(loadConfig().contractRetentionMs).toBe(0.5 * 86_400_000)
  })
})

/**
 * The one knob that makes the daemon spend without a human.
 *
 * Absent must mean OFF: an operator who never heard of this feature has not
 * agreed to automated spending by omission. And the refusal of anything that is
 * not exactly `true`/`false` is the point — `Boolean('false')` is `true`, so a
 * coercion here would enable the very thing a mistyped `false` was declining.
 */
describe('POOL_AUTO_MINT', () => {
  it('is off when unset, so nothing spends by omission', () => {
    expect(loadConfig().poolAutoMint).toBe(false)
  })

  it.each([
    ['true', true],
    ['false', false],
  ])('reads %s literally', (raw, expected) => {
    process.env.POOL_AUTO_MINT = raw
    expect(loadConfig().poolAutoMint).toBe(expected)
  })

  it('tolerates surrounding whitespace, which a .env file adds silently', () => {
    process.env.POOL_AUTO_MINT = '  true  '
    expect(loadConfig().poolAutoMint).toBe(true)
  })

  it.each(['1', '0', 'yes', 'no', 'TRUE', 'False', 'on', 'enabled'])('refuses %s rather than guessing', (raw) => {
    process.env.POOL_AUTO_MINT = raw
    expect(() => loadConfig()).toThrow(/POOL_AUTO_MINT must be 'true' or 'false'/)
  })

  it('treats a blank value as unset rather than as an error or a yes', () => {
    // A key present with no value is what an unfilled .env template looks like.
    process.env.POOL_AUTO_MINT = '   '
    expect(loadConfig().poolAutoMint).toBe(false)
  })
})

describe('loadConfig — EVM corridors', () => {
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

  it('serves NONE unless a token is named, which is the whole default', () => {
    // The property that matters for every existing deployment: setting nothing
    // means no EVM store is opened and no EVM corridor is constructed, so
    // behaviour is what it was before this field existed.
    expect(loadConfig().evmCorridors).toEqual([])
  })

  it('serves both directions for a named token', () => {
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    process.env.EVM_USDC_PRICE_FEED = 'http://pricefeed/btc-usdc'
    process.env.EVM_USDC_PRICE_PATH = '/btc/usdc'
    const corridors = loadConfig().evmCorridors
    expect(corridors.map((c) => c.corridor)).toEqual([`arkade:BTC->ethereum:${USDC}`, `ethereum:${USDC}->arkade:BTC`])
    expect(corridors.every((c) => c.enabled)).toBe(true)
  })

  it('inherits the NARROWED house limits, not the raw environment', () => {
    // The subtle one. `limits` here is already the result of `resolveLimits`,
    // which refuses to widen — so a per-token knob inherits a bound an override
    // may have tightened rather than whatever the environment originally said.
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    process.env.EVM_USDC_PRICE_FEED = 'http://pricefeed/btc-usdc'
    process.env.EVM_USDC_PRICE_PATH = '/btc/usdc'
    const config = loadConfig()
    for (const corridor of config.evmCorridors) {
      expect(corridor.limits.maxSats).toBeLessThanOrEqual(config.limits.maxSats)
      expect(corridor.limits.minSats).toBeGreaterThanOrEqual(config.limits.minSats)
    }
  })

  it('refuses at startup when a token knob would widen the house bound', () => {
    // Loud at startup, where an operator is watching, rather than quietly
    // quoting a swap the deployment-wide bound should have refused.
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    process.env.EVM_USDC_PRICE_FEED = 'http://pricefeed/btc-usdc'
    process.env.EVM_USDC_PRICE_PATH = '/btc/usdc'
    process.env.EVM_SEND_USDC_MAX_SATS = String(Number(loadConfig().limits.maxSats) + 1)
    expect(() => loadConfig()).toThrow(/may not exceed/)
  })

  it('refuses at startup a token with no price feed', () => {
    // A token that cannot be priced cannot be quoted, so the deployment must not
    // start and advertise the pair. Loud here, where an operator is watching.
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    expect(() => loadConfig()).toThrow(/EVM_USDC_PRICE_FEED is not set/)
  })

  it('refuses at startup a feed whose pointer cannot be derived', () => {
    // The go solver fails this inside its fetch, so the pair is advertised and
    // the failure lands on a client request. Here the deployment does not start.
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    process.env.EVM_USDC_PRICE_FEED = 'http://pricefeed/btc-usdc'
    expect(() => loadConfig()).toThrow(/EVM_USDC_PRICE_PATH is required/)
  })

  it('refuses a malformed token list rather than serving nothing silently', () => {
    process.env.EVM_TOKENS = 'USDC'
    expect(() => loadConfig()).toThrow(/SYMBOL:0xaddress:decimals/)
  })

  it('switches one direction off without disturbing the other', () => {
    process.env.EVM_TOKENS = `USDC:${USDC}:6`
    process.env.EVM_USDC_PRICE_FEED = 'http://pricefeed/btc-usdc'
    process.env.EVM_USDC_PRICE_PATH = '/btc/usdc'
    process.env.EVM_RECEIVE_USDC_ENABLED = 'false'
    const corridors = loadConfig().evmCorridors
    expect(corridors.find((c) => c.direction === 'send')?.enabled).toBe(true)
    expect(corridors.find((c) => c.direction === 'receive')?.enabled).toBe(false)
  })
})

/**
 * The override for a server that advertises a longer exit delay than it enforces.
 *
 * Validation here is deliberately thin, and the tests say why: the value is an
 * assertion about a deployment this process cannot check, because the thing it
 * would check against is the advertised number being overridden.
 */
describe('ARK_UNILATERAL_EXIT_DELAY', () => {
  it('is absent when unset, so the server is believed', () => {
    expect(loadConfig().arkade.unilateralExitDelayOverride).toBeUndefined()
  })

  it('reads a whole number of seconds', () => {
    process.env.ARK_UNILATERAL_EXIT_DELAY = '259200'
    expect(loadConfig().arkade.unilateralExitDelayOverride).toBe(259_200)
  })

  it.each(['0', '-1', '1.5', 'three days', '3d', '', '  '])('refuses %s', (raw) => {
    process.env.ARK_UNILATERAL_EXIT_DELAY = raw
    // Blank reads as unset rather than as an error — an unfilled .env template.
    if (raw.trim() === '') {
      expect(loadConfig().arkade.unilateralExitDelayOverride).toBeUndefined()
      return
    }
    expect(() => loadConfig()).toThrow(/ARK_UNILATERAL_EXIT_DELAY must be a positive whole number/)
  })

  it.each([
    // 300 is no longer refused here: it is a valid BLOCK count, and whether this
    // deployment counts blocks is a fact about its arkd, not about this variable. The
    // typo that used to be caught here — seconds where the server counts blocks, or the
    // reverse — is caught in `createArkadeContext`, which holds the server's own
    // advertised delay and can say which of the two disagrees.
    [511, /beyond the 503 a ladder can carry/],
    [999_999_999, /beyond the 33553920s BIP68 can encode/],
  ])('refuses %s at loadConfig, naming the variable rather than the server', (raw, message) => {
    // Both bounds are enforced downstream by `deriveUnilateralDelays` too, and
    // that is exactly why they are repeated here: downstream runs inside
    // `createArkadeContext` and says "server exit delay", sending an operator to
    // debug arkd over a value they set themselves.
    process.env.ARK_UNILATERAL_EXIT_DELAY = String(raw)
    expect(() => loadConfig()).toThrow(message)
  })

  it.each([1, 20, 144, 503])('accepts %s as a block count, deferring the unit check to the server', (raw) => {
    process.env.ARK_UNILATERAL_EXIT_DELAY = String(raw)
    expect(loadConfig().arkade.unilateralExitDelayOverride).toBe(raw)
  })

  it('accepts the BIP68 ceiling itself, since the bound is inclusive', () => {
    process.env.ARK_UNILATERAL_EXIT_DELAY = String(MAX_BIP68_SECONDS)
    expect(loadConfig().arkade.unilateralExitDelayOverride).toBe(MAX_BIP68_SECONDS)
  })

  it('allows raising the delay as well as lowering it', () => {
    // Not constrained to sit below the advertised value. Raising is the SAFE
    // direction — the server accepts any script at or above its minimum — so a
    // deployment wanting a longer recourse than its server demands may have one.
    process.env.ARK_UNILATERAL_EXIT_DELAY = String(10 * 24 * 3600)
    expect(loadConfig().arkade.unilateralExitDelayOverride).toBe(864_000)
  })
})

/**
 * The one knob that accepts a LOSS rather than a spend.
 *
 * Same exact-`true`/`false` discipline as `POOL_AUTO_MINT` above, plus a
 * condition that knob has no reason to carry: on `bitcoin` the loss it accepts
 * is bounded by the corridor cap, so the operator has to have set that cap.
 * Inheriting the network profile's default is not the same act as choosing the
 * number you are prepared to lose.
 */
describe('LN_RECEIVE_ACCEPT_UNILATERAL_GAP', () => {
  it('is off when unset, so no deployment accepts the #69 window by omission', () => {
    expect(loadConfig().lnReceiveAcceptUnilateralGap).toBe(false)
  })

  it.each(['1', '0', 'yes', 'no', 'TRUE', 'False', 'on', 'enabled'])('refuses %s rather than guessing', (raw) => {
    process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP = raw
    expect(() => loadConfig()).toThrow(/LN_RECEIVE_ACCEPT_UNILATERAL_GAP must be 'true' or 'false'/)
  })

  it('needs no corridor cap on a test network, where nothing is at risk', () => {
    process.env.SWAP_NETWORK = 'regtest'
    process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP = 'true'
    delete process.env.LN_RECEIVE_MAX_SATS
    expect(loadConfig().lnReceiveAcceptUnilateralGap).toBe(true)
  })

  it('refuses to accept the window on bitcoin without an explicit corridor cap', () => {
    process.env.SWAP_NETWORK = 'bitcoin'
    process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP = 'true'
    delete process.env.LN_RECEIVE_MAX_SATS
    expect(() => loadConfig()).toThrow(/also needs LN_RECEIVE_MAX_SATS set explicitly/)
  })

  it('accepts the window on bitcoin once the operator has stated the bound', () => {
    process.env.SWAP_NETWORK = 'bitcoin'
    process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP = 'true'
    process.env.LN_RECEIVE_MAX_SATS = '50000'
    expect(loadConfig().lnReceiveAcceptUnilateralGap).toBe(true)
  })

  it('does not demand the cap merely for declining the window on bitcoin', () => {
    // The condition guards the ACCEPTANCE, not the variable's presence. A
    // deployment that explicitly says `false` is in the default position and
    // must not be handed a new required knob for saying so out loud.
    process.env.SWAP_NETWORK = 'bitcoin'
    process.env.LN_RECEIVE_ACCEPT_UNILATERAL_GAP = 'false'
    delete process.env.LN_RECEIVE_MAX_SATS
    expect(loadConfig().lnReceiveAcceptUnilateralGap).toBe(false)
  })
})

/**
 * The route hints this deployment refuses to price.
 *
 * On the list of knobs worth pinning at the config layer for the same reason as
 * the rest of this file: nothing downstream can catch a mistake here. A typo'd
 * scid matches no hint, so the knob reads as set and does nothing — and the
 * symptom (an invoice still refused) is indistinguishable from the denylist
 * working correctly on a different invoice. So a malformed entry refuses to
 * boot rather than being skipped.
 *
 * The opposite mistake is worse and cannot be caught here at all: a REAL
 * channel listed here is priced out of a refund deadline a route can still
 * take, which on a rail that caps nothing is the double-collect window. That
 * one is curation, documented in docs/runbook.md; this file only pins that what
 * an operator wrote is what the set contains.
 */
describe('LN_SEND_HINT_SCID_DENYLIST', () => {
  it('is empty when unset, so every hint is priced as it always was', () => {
    expect(loadConfig().sendHintScidDenylist.size).toBe(0)
  })

  it('treats a blank value as unset rather than as a one-entry list', () => {
    // What an unfilled .env template looks like. `''.split(',')` is `['']`,
    // which would otherwise be an entry that matches nothing and throws.
    process.env.LN_SEND_HINT_SCID_DENYLIST = '   '
    expect(loadConfig().sendHintScidDenylist.size).toBe(0)
  })

  it('parses a comma-separated list', () => {
    process.env.LN_SEND_HINT_SCID_DENYLIST = 'f42400f424000001,0102030405060708'
    const denylist = loadConfig().sendHintScidDenylist
    expect(denylist.has('f42400f424000001')).toBe(true)
    expect(denylist.has('0102030405060708')).toBe(true)
    expect(denylist.size).toBe(2)
  })

  it('lowercases and trims, since the decoder emits lowercase hex', () => {
    // `light-bolt11-decoder` hex-encodes the scid lowercase, so an operator who
    // pasted an uppercase scid out of a block explorer would otherwise have
    // written a list that matches nothing.
    process.env.LN_SEND_HINT_SCID_DENYLIST = ' F42400F424000001 , 0102030405060708 '
    expect(loadConfig().sendHintScidDenylist.has('f42400f424000001')).toBe(true)
  })

  it.each(['f42400f42400000', 'f42400f4240000012', 'not-hex-at-all', '0xf42400f424000001', '16000000'])(
    'refuses %s rather than keeping an entry that can never match',
    (raw) => {
      process.env.LN_SEND_HINT_SCID_DENYLIST = raw
      expect(() => loadConfig()).toThrow(/LN_SEND_HINT_SCID_DENYLIST entries must be 16 hex chars/)
    },
  )

  it('refuses the whole list when one entry of several is malformed', () => {
    // Not "keep the good ones": a list an operator wrote is one intent, and
    // silently honouring half of it is how the half that matters goes missing.
    process.env.LN_SEND_HINT_SCID_DENYLIST = 'f42400f424000001,oops'
    expect(() => loadConfig()).toThrow(/got 'oops'/)
  })
})

/**
 * The offer-packet path's switch, and the bounds it pays out under.
 *
 * `OFFER_MARKETS` earns a place here on the same grounds as `POOL_AUTO_MINT`:
 * it decides whether the daemon SPENDS unattended. An offer fill pays a maker
 * out of the float with no request from anyone — the offer is discovered on a
 * public stream, not asked for — so a market enabled by accident is money moving
 * on a pair nobody chose to serve.
 *
 * The bounds are required rather than defaulted for the reason `EMULATOR_URL`
 * has no default: a shipped `maxFillAmount` would be this repository choosing
 * how much of somebody else's float one offer may take.
 */
describe('OFFER_MARKETS', () => {
  it('serves no market when unset, which is the whole path off', () => {
    expect(loadConfig().offerMarkets).toEqual([])
  })

  it('reads BTC as the null leg and needs no bounds while it serves nothing', () => {
    const config = loadConfig()
    expect(config.offerMarkets).toEqual([])
    expect(config.offerMinFillAmount).toBe(0n)
    expect(config.offerMaxFillAmount).toBe(0n)
  })

  it('parses the markets and their bounds', () => {
    const usd = '41bcbb06921a0e9f6fe4f1b003b878cbb43d9ca3f6d14cab7940090458765a390000'
    process.env.OFFER_MARKETS = `BTC/${usd}`
    process.env.OFFER_MIN_FILL_AMOUNT = '1000'
    process.env.OFFER_MAX_FILL_AMOUNT = '500000'
    const config = loadConfig()
    expect(config.offerMarkets).toEqual([{ a: null, b: usd }])
    expect(config.offerMinFillAmount).toBe(1_000n)
    expect(config.offerMaxFillAmount).toBe(500_000n)
  })

  it('refuses a market with no bounds rather than filling at any size', () => {
    process.env.OFFER_MARKETS = 'BTC/' + '11'.repeat(34)
    expect(() => loadConfig()).toThrow(/OFFER_MIN_FILL_AMOUNT/)
  })

  it('refuses a bound that is not a whole number', () => {
    process.env.OFFER_MARKETS = 'BTC/' + '11'.repeat(34)
    process.env.OFFER_MIN_FILL_AMOUNT = '1000'
    process.env.OFFER_MAX_FILL_AMOUNT = '5e5'
    expect(() => loadConfig()).toThrow(/OFFER_MAX_FILL_AMOUNT/)
  })

  it('refuses a negative bound', () => {
    process.env.OFFER_MARKETS = 'BTC/' + '11'.repeat(34)
    process.env.OFFER_MIN_FILL_AMOUNT = '-1'
    process.env.OFFER_MAX_FILL_AMOUNT = '500000'
    expect(() => loadConfig()).toThrow(/OFFER_MIN_FILL_AMOUNT/)
  })

  it('refuses a max below the min, which could only ever refuse every offer', () => {
    process.env.OFFER_MARKETS = 'BTC/' + '11'.repeat(34)
    process.env.OFFER_MIN_FILL_AMOUNT = '5000'
    process.env.OFFER_MAX_FILL_AMOUNT = '1000'
    expect(() => loadConfig()).toThrow(/OFFER_MAX_FILL_AMOUNT/)
  })
})

/**
 * The atomic class's switch: which assets this solver QUOTES on over RFQ, and
 * under which env stems.
 *
 * Unlike `OFFER_MARKETS` this one only ever spends in answer to a request, and
 * only against a covenant the client itself funded — but it is still a decision
 * to trade a pair, so a malformed list refuses at boot rather than at the first
 * quote.
 */
describe('ASSET_MARKETS', () => {
  const USDA = '1a'.repeat(34)

  it('names no asset when unset, which is the atomic-class corridors off', () => {
    expect(loadConfig().assetRfqTokens).toEqual([])
  })

  it('parses SYMBOL:<asset id> with both directions open', () => {
    process.env.ASSET_MARKETS = `USDA:${USDA}`
    expect(loadConfig().assetRfqTokens).toEqual([
      { symbol: 'USDA', assetId: USDA, enabled: { sell_base: true, buy_base: true } },
    ])
  })

  it('ASSET_USDA_BUY_ENABLED=false closes sell_base — the client GIVES the base leg', () => {
    process.env.ASSET_MARKETS = `USDA:${USDA}`
    process.env.ASSET_USDA_BUY_ENABLED = 'false'
    expect(loadConfig().assetRfqTokens[0]!.enabled).toEqual({ sell_base: false, buy_base: true })
  })

  it('refuses a malformed entry at boot rather than at the first quote', () => {
    process.env.ASSET_MARKETS = USDA
    expect(() => loadConfig()).toThrow(/ASSET_MARKETS/)
  })

  it('defaults the quote window to seconds, not minutes', () => {
    // Every pair here is cross-asset by construction, so the window IS the
    // exposure: the solver is short the market until the client funds.
    expect(loadConfig().assetQuoteValiditySeconds).toBe(30)
  })

  it('takes an operator window inside the permitted range', () => {
    process.env.ASSET_QUOTE_VALIDITY_SECONDS = '45'
    expect(loadConfig().assetQuoteValiditySeconds).toBe(45)
  })

  it('refuses a window nobody could fund against, and one that binds for an hour', () => {
    process.env.ASSET_QUOTE_VALIDITY_SECONDS = '1'
    expect(() => loadConfig()).toThrow(/ASSET_QUOTE_VALIDITY_SECONDS/)
    process.env.ASSET_QUOTE_VALIDITY_SECONDS = '901'
    expect(() => loadConfig()).toThrow(/ASSET_QUOTE_VALIDITY_SECONDS/)
  })
})
