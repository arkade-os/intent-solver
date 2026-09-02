/**
 * `@noble/curves` and better-sqlite3's native addon, loaded statically in one
 * process — the condition a workaround in `src/cli.ts` used to defer around.
 *
 * That workaround replaced the module-level `import { schnorr }` with a lazy
 * `getSchnorr()`, on the stated grounds that the static form "triggers an
 * initialisation-time failure under Node.js 24 when loaded statically alongside
 * better-sqlite3's native addon". It was removed because that does not
 * reproduce — but removing it left nothing watching the condition, and the
 * review that asked for coverage was right that there was none: `src/cli.ts`'s
 * four call sites are reachable only by running the CLI by hand. No test
 * imports that module (every `test/cli/*` case reads it as TEXT and asserts
 * against the source), and no test spawns the binary.
 *
 * So this asserts the PROPERTY rather than the call sites. It is deliberately
 * not a mock: it opens a real database through the same driver the service
 * uses, which is what pulls the native addon into the process, and only then
 * exercises the curve. Both are STATIC imports above, because the claim was
 * about static loading — a dynamic import here would test the workaround
 * instead of the thing it worked around.
 *
 * CI runs this on both ends of `engines.node` (22 and 24), so if the failure is
 * real on some Node this repo supports, this is where it surfaces — with a
 * reproduction, rather than as a comment naming a cause nobody can reproduce.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'

describe('schnorr alongside the native sqlite addon', () => {
  it('signs and verifies in a process that has opened a real database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schnorr-addon-'))
    const driver = betterSqliteDriver(join(dir, 'probe.sqlite'))
    try {
      // Touch the addon rather than merely resolving it: the destructor and the
      // environment hooks the original claim was about only exist once a real
      // Database has been constructed.
      await driver.exec('create table probe (a integer)')
      await driver.run('insert into probe values (?)', [1])
      expect(await driver.all<{ a: number }>('select a from probe')).toEqual([{ a: 1 }])

      // The same shape `src/cli.ts` uses at each of its four call sites.
      const secret = schnorr.utils.randomSecretKey()
      const pub = schnorr.getPublicKey(secret)
      expect(pub).toHaveLength(32)

      const message = new Uint8Array(32).fill(9)
      expect(schnorr.verify(schnorr.sign(message, secret), message, pub)).toBe(true)
    } finally {
      await driver.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * Order matters to the claim: it named the addon as what breaks the curve.
   * Using the curve FIRST and the addon after would pass even if that were
   * true, so the case above is the load-bearing one and this is its mirror.
   */
  it('works in the other order too, so neither import poisons the other', async () => {
    const secret = schnorr.utils.randomSecretKey()
    const message = new Uint8Array(32).fill(4)
    const signature = schnorr.sign(message, secret)

    const dir = mkdtempSync(join(tmpdir(), 'schnorr-addon-'))
    const driver = betterSqliteDriver(join(dir, 'probe.sqlite'))
    try {
      await driver.exec('create table probe (a integer)')
      expect(schnorr.verify(signature, message, schnorr.getPublicKey(secret))).toBe(true)
    } finally {
      await driver.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
