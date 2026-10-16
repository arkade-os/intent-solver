/**
 * E2E — the swept-lockup refund, which only a live arkd can answer: that it
 * ACCEPTS an intent whose inputs are swept with no forfeit for them, that the
 * extension at output 0 is not read as a receiver, and that the emulator runs
 * the covenant at the PROOF's input index and co-signs. In its own BLOCK-typed
 * group, so the batch expiry can be MINED past without sweeping a neighbour's
 * float. A sweep that never arrives fails this rather than passing it vacuously.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { ArkAddress } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { findLockups, findSweptLockups, lockupSpendEvidence } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { refundSweptSwapScript } from '@arkade-os/solver-arkade/arkade/sweptRefund.js'
import { relativeDelayFrom } from '@arkade-os/solver-core/core/timelocks.js'
import { mineBlocks } from './support/chain.js'
import { requireStack } from './support/preflight.js'
import { openArkade, SETUP_TIMEOUT_MS, type E2eArkade } from './support/stack.js'

const SWEEP_TIMEOUT_MS = 20 * 60_000

const SWEPT_POLL_TIMEOUT_MS = 8 * 60_000
const SWEPT_POLL_MS = 5_000

const MINE_STEP_BLOCKS = 50
const MAX_MINED_BLOCKS = 400
const SWEEP_STEP_WAIT_MS = 60_000

const LOCKUP_SATS = 2_000

let arkade: E2eArkade

const p2tr = (xonly: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...xonly])

describe('a swept send-leg lockup is refunded through a batch', () => {
  beforeAll(async () => {
    await requireStack('swept send refund', ['arkd', 'emulator', 'esplora'])
    arkade = await openArkade()
  }, SETUP_TIMEOUT_MS)

  afterAll(() => arkade?.close())

  it(
    'returns the client their sats and leaves the lockup spent',
    async () => {
      const { ctx, emulator } = arkade
      const info = await ctx.wallet.arkProvider.getInfo()
      const advertised = Number(info.unilateralExitDelay)
      if (relativeDelayFrom(advertised).unit === 'seconds') {
        // Never a silent pass: the premise is an expiry a test can MINE past.
        throw new Error(
          `this arkd advertises ${advertised}, which is SECONDS: its batch expiry cannot be reached by mining. ` +
            'Run this file in the `swept-refund` group, whose arkd is block-typed.',
        )
      }

      // A SEND-leg lockup: the sender key exists only in this test, so the leaf
      // arkd stamps on the vtxo is one we can never sign — the production shape,
      // and why recovery can never sweep it.
      // A real point: arkd refuses an offchain output whose key is off the curve.
      const traderKey = schnorr.getPublicKey(new Uint8Array(32).fill(0x5a))
      const clientRefund = p2tr(traderKey)
      const script = new CovenantSwapScript({
        receiver: await ctx.identity.xOnlyPublicKey(),
        server: ctx.wallet.arkServerPublicKey,
        preimageHash: new Uint8Array(20).fill(0x7b),
        // A HEIGHT: this arkd is block-typed. Nothing waits for it — the leaf
        // this spends carries no timelock.
        refundLocktime: 10_000_000,
        claimDelay: ctx.unilateralDelays.unilateralClaimDelay,
        client: traderKey,
        clientRefundDelay: ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: ctx.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(emulator.pubkey),
          receiverPkScript: ArkAddress.decode(await ctx.wallet.getAddress()).pkScript,
          senderPkScript: clientRefund,
        },
      })
      const pkScript = hex.encode(script.pkScript)
      const lockupAddress = script.address(ctx.hrp, ctx.wallet.arkServerPublicKey).encode()

      await ctx.wallet.send({ recipients: [{ address: lockupAddress, amount: LOCKUP_SATS }] })
      const funded = await poll(
        () => findLockups(ctx, pkScript),
        (outputs) => outputs.length > 0,
        'the lockup to be seen',
      )
      expect(funded.reduce((sum, output) => sum + output.value, 0)).toBe(LOCKUP_SATS)

      // arkd advertises no tree expiry (`vtxoTreeExpiry` is null here), so mine
      // in steps until the sweep lands instead of computing a height.
      let swept: Awaited<ReturnType<typeof findSweptLockups>> = []
      for (let mined = 0; swept.length === 0 && mined < MAX_MINED_BLOCKS; mined += MINE_STEP_BLOCKS) {
        await mineBlocks(MINE_STEP_BLOCKS)
        swept = await poll(
          () => findSweptLockups(ctx, pkScript),
          (outputs) => outputs.length > 0,
          'a sweep',
          SWEEP_STEP_WAIT_MS,
        ).catch(() => [])
      }
      if (swept.length === 0) {
        throw new Error(`arkd never swept the batch holding ${pkScript} within ${MAX_MINED_BLOCKS} mined blocks`)
      }
      // The blind spot itself: the spendable read is empty for an output still
      // unspent and still the client’s.
      expect(await findLockups(ctx, pkScript)).toEqual([])
      expect(await lockupSpendEvidence(ctx, pkScript)).toBe('unspent')

      const commitmentTxid = await refundSweptSwapScript(ctx, emulator.url, script, swept, clientRefund)
      expect(commitmentTxid).toMatch(/^[0-9a-f]{64}$/)

      const refunded = await poll(
        () => findLockups(ctx, hex.encode(clientRefund)),
        (outputs) => outputs.reduce((sum, output) => sum + output.value, 0) >= LOCKUP_SATS,
        `the refund to land at ${hex.encode(clientRefund)}`,
      )
      expect(refunded.reduce((sum, output) => sum + output.value, 0)).toBeGreaterThanOrEqual(LOCKUP_SATS)
      // A spent lockup drops out of the recoverable set on its own.
      expect(await lockupSpendEvidence(ctx, pkScript)).toBe('spent')
    },
    SWEEP_TIMEOUT_MS,
  )
})

const poll = async <T>(
  read: () => Promise<T>,
  enough: (value: T) => boolean,
  what: string,
  timeoutMs = SWEPT_POLL_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!enough(last) && Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, SWEPT_POLL_MS))
    last = await read()
  }
  if (!enough(last)) throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last)}`)
  return last
}
