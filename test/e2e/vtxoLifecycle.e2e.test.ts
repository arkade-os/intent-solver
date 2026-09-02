/**
 * E2E — the solver's OWN float, against a live regtest wallet.
 *
 * `runVtxoLifecycle` is the one money-adjacent module in `src/arkade` that no
 * corridor test touches. Every other Arkade module is about one swap's money;
 * this one is about the balance the solver claims proceeds INTO and funds
 * receive-leg lockups OUT OF. Nothing in the four corridor suites exercises it
 * because nothing in the orchestrators calls it — its only caller is
 * `packages/solver-app/src/cli.ts`'s watch loop, and the e2e harness deliberately builds services
 * without the CLI. So without this file it is reachable end to end only by
 * leaving `pnpm start` running for hours.
 *
 * IS IT E2E-REACHABLE AT ALL? Yes, and this is the demonstration. It takes its
 * dependencies as injected callbacks rather than a wallet, so the honest
 * question is not whether the pure logic works (unit tests cover the guard)
 * but whether the REAL callbacks the CLI passes it behave the way it assumes.
 * That is what is checked here, and only a live arkd can answer it:
 *
 *  - `renewExpiringVtxos()` against a real wallet and a real Arkade server,
 *    including the family of "nothing to do" outcomes it reports by THROWING —
 *    `isBenignRenewal` classifies those, and a misclassification would turn an
 *    idle wallet into a permanent stream of `failures` on the watch loop. Most
 *    of all, that it PAYS THE OPERATOR'S INTENT FEE: this is the one property
 *    no unit test can establish, because only a real arkd decides whether the
 *    fee an intent carries is enough.
 *  - `recoverableVtxosFrom(wallet)` against real VTXO state, which must be a
 *    SUPERSET of what `recoverVtxos` would sweep. Narrower is the dangerous
 *    direction: the guard would miss the very output it exists to catch.
 *  - the guard itself refusing to sweep while a lockup is still inside its
 *    CLTV — the property that makes registering lockups safe at all, since
 *    recovery reads the UNGATED VTXO set and has no timelock awareness of its
 *    own.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: force a real recovery. `recoverVtxos`
 * re-registers every recoverable coin into one settlement with no timelock
 * awareness, and on a shared regtest wallet that other tests are mid-swap
 * against, provoking one for the sake of a green tick is exactly the mistake
 * the guard exists to prevent. The pass is run for real; whether it finds
 * anything to recover is the wallet's business.
 *
 * PREREQUISITES: arkd, emulator, and the Arkade wallet from `.env.regtest.lnd`.
 *
 * Run: `pnpm test:e2e`   (never runs in CI — `pnpm test` excludes `test/e2e`)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LOCKUP_RECOVERY_MTP_MARGIN_SECONDS,
  recoverableVtxosFrom,
  RENEWAL_THRESHOLD_MS,
  renewExpiringVtxos,
  runVtxoLifecycle,
} from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { nowSeconds } from '@arkade-os/solver-core/util/poll.js'
import { requireStack } from './support/preflight.js'
import { openArkade, SETUP_TIMEOUT_MS, SWAP_TIMEOUT_MS, type E2eArkade } from './support/stack.js'

let arkade: E2eArkade

/**
 * The real callbacks, assembled exactly as `packages/solver-app/src/cli.ts`'s watch loop assembles
 * them — the point of the test is that THESE work, so a stub anywhere here
 * would test nothing.
 */
const liveDeps = async (lockupDeadlines: () => Promise<readonly { script: string; refundLocktime: number }[]>) => {
  const vtxoManager = await arkade.ctx.wallet.getVtxoManager()
  return {
    renewVtxos: () =>
      renewExpiringVtxos({
        serverInfo: async () => {
          const info = await arkade.ctx.wallet.arkProvider.getInfo()
          return { intentFee: info.fees.intentFee, vtxoMaxAmount: info.vtxoMaxAmount, dust: info.dust }
        },
        expiringVtxos: () => vtxoManager.getExpiringVtxos(RENEWAL_THRESHOLD_MS),
        destination: () => arkade.ctx.wallet.getAddress(),
        settle: (inputs, outputs) => arkade.ctx.wallet.settle({ inputs: [...inputs], outputs: [...outputs] }),
        // Exercised deliberately: without a target the renewal takes the
        // one-output path and this suite would say nothing about the split that
        // is the whole point of the change. Small rungs so a regtest float can
        // actually reach them.
        poolTarget: [{ size: 50_000, want: 3 }],
        nowMs: () => Date.now(),
      }),
    recoverVtxos: () => vtxoManager.recoverVtxos(),
    recoverableVtxos: () => recoverableVtxosFrom(arkade.ctx.wallet),
    lockupDeadlines,
    nowSeconds: () => nowSeconds(),
  }
}

describe('e2e vtxo lifecycle — the solver’s own float', () => {
  beforeAll(async () => {
    await requireStack('vtxo lifecycle', ['arkd', 'emulator'])
    arkade = await openArkade()
  }, SETUP_TIMEOUT_MS)

  afterAll(() => {
    arkade?.close()
  })

  it(
    'contains a live renewal failure inside the report instead of throwing out of the pass',
    async () => {
      // Resolving at all is the first assertion. This runs on a watch loop
      // whose other entries are unguarded money-path work, so a settlement
      // that throws THROUGH this function ends the loop and takes every live
      // swap's ticking with it.
      const report = await runVtxoLifecycle(await liveDeps(async () => []))

      // THE REGRESSION THIS FILE EXISTS TO CATCH. Until `renewExpiringVtxos`
      // replaced it, this line ran `IVtxoManager.renewVtxos()` and came back
      //
      //   INTENT_INSUFFICIENT_FEE (31): got 0 min expected 3679
      //
      // every single time. That method asks for an output equal to the GROSS
      // sum of its inputs, so the fee the intent implies (`inputs - outputs`)
      // is always zero, and arkade-regtest charges 1% of every offchain input
      // by default (`ARK_OFFCHAIN_INPUT_FEE`). The float was never renewed at
      // all. It was read at the time as an SDK-vs-arkd version mismatch; it is
      // not — the SDK's own `Wallet.settle()` and `runPeriodicSettle` price
      // their outputs correctly, and ts-sdk master carries the identical
      // defect, so no pin fixes it.
      //
      // "got 0" is the signature, and nothing about a healthy pass produces
      // it: renewal either finds no coin due yet, or it runs having paid the
      // fee. Asserting its ABSENCE is therefore deterministic regardless of
      // how recently the wallet was funded, which asserting a txid would not
      // be.
      const feeRejections = report.failures.filter((f) => f.includes('INTENT_INSUFFICIENT_FEE'))
      expect(feeRejections, 'renewal must pay the operator’s intent fee').toEqual([])

      // The containment property the module promises on top of that: whatever
      // renewal does, it lands in `failures` as text and the pass still
      // returns a report rather than throwing through the watch loop.
      for (const failure of report.failures) {
        expect(failure.startsWith('renew: '), `only renewal is expected to fail on this stack; got ${failure}`).toBe(
          true,
        )
      }

      // Renewal either settled something or reported why it could not. Both
      // are correct; asserting a txid would make this a function of how
      // recently the wallet happened to be funded.
      expect(report.renewed === null || typeof report.renewed === 'string').toBe(true)

      // With no lockups declared, nothing can be held back.
      expect(report.recoverySkipped).toBeNull()
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'reads the same recoverable set the sweep would, and holds recovery back while a lockup is inside its CLTV',
    async () => {
      const recoverable = await recoverableVtxosFrom(arkade.ctx.wallet)
      // Shape, not contents: every entry has to carry the outpoint and script
      // the guard matches lockups on. A read that dropped `script` would make
      // the guard silently match nothing.
      for (const vtxo of recoverable) {
        expect(typeof vtxo.txid).toBe('string')
        expect(typeof vtxo.vout).toBe('number')
        expect(typeof vtxo.script).toBe('string')
      }

      if (recoverable.length === 0) {
        // Nothing recoverable, so the guard has nothing to guard and the pass
        // returns before ever asking for deadlines. Asserting that explicitly
        // beats skipping: it is the ordinary state of a healthy wallet, and it
        // still proves the early return does not report a spurious failure.
        const report = await runVtxoLifecycle(await liveDeps(async () => []))
        expect(report.recovered).toBeNull()
        expect(report.recoverySkipped).toBeNull()
        // Recovery specifically — renewal's own live failure is the subject of
        // the test above and is not this one's business.
        expect(report.failures.filter((f) => f.startsWith('recover: '))).toEqual([])
        return
      }

      // Something IS recoverable. Declare it as a lockup whose CLTV has not
      // matured — the shape `registerLiveLockups` produces for a live swap —
      // and the pass must decline to sweep rather than pull a counterparty's
      // escrow into a settlement.
      const blocked = await runVtxoLifecycle(
        await liveDeps(async () =>
          recoverable.map((vtxo) => ({
            script: vtxo.script,
            // Comfortably inside the margin the guard adds for MTP lag.
            refundLocktime: nowSeconds() + LOCKUP_RECOVERY_MTP_MARGIN_SECONDS,
          })),
        ),
      )
      expect(blocked.recovered).toBeNull()
      expect(blocked.recoverySkipped).toContain('not yet safely past CLTV')
      expect(blocked.failures.filter((f) => f.startsWith('recover: '))).toEqual([])
    },
    SWAP_TIMEOUT_MS,
  )

  it(
    'lands every output the split asked for as its own spendable VTXO',
    async () => {
      // WHAT THE TESTS ABOVE DO NOT COVER. `poolTarget` makes the renewal
      // produce several outputs, and nothing checks they SURVIVE the batch: a
      // settle that quietly consolidated them back to one would leave every
      // assertion above green, because none of them reads the resulting float.
      // That is the whole point of the change, so it needs an eye on the chain.
      //
      // FORCED, not opportunistic. `renewExpiringVtxos` filters candidates
      // through `isRenewalDue`, which measures each coin against its own expiry
      // — so on a float renewed five minutes ago there is nothing due and the
      // shape assertion would silently have nothing to assert. `nowMs` is the
      // module's own injection seam; moving it a year forward makes every coin
      // due and the settle deterministic.
      //
      // It costs a real intent fee (a live regtest server charges 1% of every
      // offchain input) and reshapes the solver's float. That is what this file
      // is for, but it is why this runs behind `pnpm test:e2e` and never in CI.
      const A_YEAR_MS = 365 * 24 * 60 * 60 * 1000
      const vtxoManager = await arkade.ctx.wallet.getVtxoManager()
      const target = [{ size: 50_000, want: 3 }]

      // The float as it stands, keyed by outpoint. Comparing before against
      // after is what makes this independent of WHICH id a settlement reports:
      // `settle` resolves to the commitment txid, while the VTXOs it creates
      // carry the batch output's txid and reference the commitment only through
      // `commitmentTxIds`. Joining on the wrong one of those silently matches
      // nothing, which reads exactly like a split that did not land.
      const outpoint = (vtxo: { txid: string; vout: number }) => `${vtxo.txid}:${vtxo.vout}`
      const spendable = async () => [
        ...(await arkade.ctx.wallet.getVtxos({ withRecoverable: false, withUnrolled: false })),
      ]
      const before = new Set((await spendable()).map(outpoint))

      const asked: bigint[] = []
      const settled = await renewExpiringVtxos({
        serverInfo: async () => {
          const info = await arkade.ctx.wallet.arkProvider.getInfo()
          return { intentFee: info.fees.intentFee, vtxoMaxAmount: info.vtxoMaxAmount, dust: info.dust }
        },
        expiringVtxos: () => vtxoManager.getExpiringVtxos(A_YEAR_MS),
        destination: () => arkade.ctx.wallet.getAddress(),
        settle: (inputs, outputs) => {
          asked.push(...outputs.map((output) => output.amount))
          return arkade.ctx.wallet.settle({ inputs: [...inputs], outputs: [...outputs] })
        },
        poolTarget: target,
        nowMs: () => Date.now() + A_YEAR_MS,
      })

      // The split ran at all: a float big enough for one rung plus a remainder
      // must be asked for as more than one output.
      expect(asked.length, `settle was asked for ${JSON.stringify(asked.map(String))}`).toBeGreaterThan(1)
      expect(asked.filter((amount) => amount === 50_000n).length).toBeGreaterThan(0)

      // AND IT LANDED. The coins the float gained are exactly the outputs we
      // named — not one consolidated coin carrying their sum, which is what a
      // settlement that flattened the split would leave behind and what every
      // assertion above would still call a success.
      expect(settled, 'settle must report an id').toMatch(/^[0-9a-f]{64}$/)
      const landed = (await spendable()).filter((vtxo) => !before.has(outpoint(vtxo)))
      const sort = (amounts: bigint[]) => [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      expect(sort(landed.map((vtxo) => BigInt(vtxo.value)))).toEqual(sort(asked))
      // One settlement, so one transaction: several outputs of the same batch
      // rather than several batches that each produced one.
      expect(new Set(landed.map((vtxo) => vtxo.txid)).size).toBe(1)
    },
    SWAP_TIMEOUT_MS,
  )
})
