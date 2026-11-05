import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { ArkAddress, Transaction } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { claimSweptSwapScript, type SweptClaimRegistration } from '@arkade-os/solver-arkade/arkade/sweptClaim.js'
import {
  parseSweptClaimJournal,
  verifySweptClaimCommitment,
  type SweptClaimJournal,
} from '@arkade-os/solver-arkade/arkade/sweptClaimEvidence.js'
import { findLockups, findSweptLockups, lockupSpendEvidence } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { relativeDelayFrom } from '@arkade-os/solver-core/core/timelocks.js'
import { mineBlocks } from './support/chain.js'
import { requireStack } from './support/preflight.js'
import { openArkade, SETUP_TIMEOUT_MS, type E2eArkade } from './support/stack.js'

const SWEEP_TIMEOUT_MS = 35 * 60_000
const SWEPT_POLL_TIMEOUT_MS = 8 * 60_000
const SWEPT_POLL_MS = 5_000
const MINE_STEP_BLOCKS = 50
const MAX_MINED_BLOCKS = 400
const SWEEP_STEP_WAIT_MS = 60_000
const LOCKUP_SATS = 2_000
const PREIMAGE = new Uint8Array(32).fill(0x6b)

let arkade: E2eArkade

const poll = async <T>(
  read: () => Promise<T>,
  enough: (value: T) => boolean,
  what: string,
  timeoutMs = SWEPT_POLL_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  let last = await read()
  while (!enough(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, SWEPT_POLL_MS))
    last = await read()
  }
  if (!enough(last)) throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last)}`)
  return last
}

describe('a swept send-leg lockup is claimed through a batch', () => {
  beforeAll(async () => {
    await requireStack('swept send claim', ['arkd', 'emulator', 'esplora'])
    arkade = await openArkade()
  }, SETUP_TIMEOUT_MS)

  afterAll(() => arkade?.close())

  it(
    'proves the preimage and pays the receiver from the swept lockup',
    async () => {
      const { ctx, emulator } = arkade
      const info = await ctx.wallet.arkProvider.getInfo()
      if (relativeDelayFrom(Number(info.unilateralExitDelay)).unit === 'seconds') {
        throw new Error('swept send claim requires the block-typed swept-refund e2e group')
      }
      const trader = schnorr.getPublicKey(new Uint8Array(32).fill(0x5a))
      const refundPkScript = Uint8Array.from([0x51, 0x20, ...trader])
      const payoutPkScript = ArkAddress.decode(await ctx.wallet.getAddress()).pkScript
      const script = new CovenantSwapScript({
        receiver: await ctx.identity.xOnlyPublicKey(),
        server: ctx.wallet.arkServerPublicKey,
        preimageHash: ripemd160(sha256(PREIMAGE)),
        refundLocktime: 10_000_000,
        claimDelay: ctx.unilateralDelays.unilateralClaimDelay,
        client: trader,
        clientRefundDelay: ctx.unilateralDelays.unilateralRefundWithoutReceiverDelay,
        refundWithoutServerDelay: ctx.unilateralDelays.unilateralRefundDelay,
        nonInteractiveParameters: {
          emulatorPubkey: hex.decode(emulator.pubkey),
          receiverPkScript: payoutPkScript,
          senderPkScript: refundPkScript,
        },
      })
      const pkScript = hex.encode(script.pkScript)
      await ctx.wallet.send({
        recipients: [{ address: script.address(ctx.hrp, ctx.wallet.arkServerPublicKey).encode(), amount: LOCKUP_SATS }],
      })
      await poll(
        () => findLockups(ctx, pkScript),
        (outputs) => outputs.length > 0,
        'funded lockup',
      )

      let swept: Awaited<ReturnType<typeof findSweptLockups>> = []
      for (let mined = 0; swept.length === 0 && mined < MAX_MINED_BLOCKS; mined += MINE_STEP_BLOCKS) {
        await mineBlocks(MINE_STEP_BLOCKS)
        swept = await poll(
          () => findSweptLockups(ctx, pkScript),
          (outputs) => outputs.length > 0,
          'batch sweep',
          SWEEP_STEP_WAIT_MS,
        ).catch(() => [])
      }
      if (swept.length === 0) throw new Error(`arkd did not sweep lockup ${pkScript}`)
      expect(await findLockups(ctx, pkScript)).toEqual([])
      expect(await lockupSpendEvidence(ctx, pkScript)).toBe('unspent')

      const canceled: string[] = []
      await expect(
        claimSweptSwapScript(
          ctx,
          script,
          swept,
          PREIMAGE,
          LOCKUP_SATS,
          async () => {
            canceled.push('registered')
            throw new Error('cancel this registered claim')
          },
          undefined,
          async () => {
            canceled.push('prepared')
          },
        ),
      ).rejects.toThrow('cancel this registered claim')
      expect(canceled).toEqual(['prepared', 'registered'])

      let registered: SweptClaimRegistration | undefined
      let journal: SweptClaimJournal | undefined
      const callbackOrder: string[] = []
      const commitmentTxid = await claimSweptSwapScript(
        ctx,
        script,
        swept,
        PREIMAGE,
        LOCKUP_SATS,
        async (record) => {
          registered = record
          if (!journal) throw new Error('batch claim registered before the prepared journal')
          journal = { ...journal, intentId: record.intentId }
          callbackOrder.push('registered')
        },
        async (evidence) => {
          if (!journal) throw new Error('batch claim commitment preceded registration')
          journal = { ...journal, commitmentTxid: evidence.commitmentTxid, payoutOutpoints: evidence.payoutOutpoints }
          callbackOrder.push('validated')
        },
        async (prepared) => {
          journal = {
            ...prepared,
            intentId: null,
            registeredAt: Math.floor(Date.now() / 1000),
            fundingOutpoints: swept.map(({ txid, vout, value }) => ({ txid, vout, value })),
            lockupPkScript: pkScript,
            recipientPkScript: hex.encode(payoutPkScript),
            expectedSats: LOCKUP_SATS,
          }
          callbackOrder.push('prepared')
        },
      )
      expect(commitmentTxid).toMatch(/^[0-9a-f]{64}$/)
      expect(callbackOrder).toEqual(['prepared', 'registered', 'validated'])
      expect(journal).toMatchObject({
        ...registered,
        commitmentTxid,
        fundingOutpoints: swept.map(({ txid, vout, value }) => ({ txid, vout, value })),
        lockupPkScript: pkScript,
        recipientPkScript: hex.encode(payoutPkScript),
        expectedSats: LOCKUP_SATS,
      })
      if (!registered) throw new Error('batch claim did not record intent registration')
      const deleteProof = Transaction.fromPSBT(base64.decode(registered.deleteProof))
      expect(deleteProof.inputsLength).toBeGreaterThan(swept.length)
      for (const output of swept) {
        expect(
          Array.from({ length: deleteProof.inputsLength }, (_, vin) => deleteProof.getInput(vin)).some(
            (input) => input.txid && hex.encode(input.txid) === output.txid && input.index === output.vout,
          ),
        ).toBe(true)
      }
      if (!journal) throw new Error('batch claim did not register a journal')
      const adopted = parseSweptClaimJournal(JSON.stringify(journal))
      const payoutOutpoints = adopted.payoutOutpoints
      if (!payoutOutpoints) throw new Error('batch claim did not validate payout outpoints')
      expect(payoutOutpoints).toHaveLength(swept.length)
      const claimed = await poll(
        async () => (await ctx.wallet.indexerProvider.getVtxos({ outpoints: payoutOutpoints })).vtxos,
        (vtxos) =>
          payoutOutpoints.every((payout) =>
            vtxos.some(
              (vtxo) =>
                vtxo.txid === payout.txid &&
                vtxo.vout === payout.vout &&
                vtxo.value === payout.value &&
                vtxo.script === hex.encode(payoutPkScript) &&
                vtxo.commitmentTxIds?.includes(commitmentTxid),
            ),
          ),
        `claim payout in ${commitmentTxid}`,
      )
      expect(claimed.reduce((sum, vtxo) => sum + vtxo.value, 0)).toBe(LOCKUP_SATS)
      const evidence = await poll(
        () => verifySweptClaimCommitment(ctx.wallet.indexerProvider, adopted),
        (result) => result.status !== 'pending',
        `verified batch claim in ${commitmentTxid}`,
      )
      expect(evidence).toEqual({ status: 'claimed', commitmentTxid })
      expect(await lockupSpendEvidence(ctx, pkScript)).toBe('spent')
    },
    SWEEP_TIMEOUT_MS,
  )
})
