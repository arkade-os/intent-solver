import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { schnorr } from '@noble/curves/secp256k1.js'
import { Address, OutScript } from '@scure/btc-signer'
import { hex } from '@scure/base'
import { OnchainWallet, Transaction, Unroll } from '@arkade-os/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { relativeDelayFrom } from '@arkade-os/solver-core/core/timelocks.js'
import { poll } from '@arkade-os/solver-core/util/poll.js'
import { SwapStore } from '@arkade-os/solver-corridors/db/swaps.js'
import { arkadeOpsFromContext, covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { SendSwapService } from '@arkade-os/solver-corridors/send/orchestrator.js'
import { findLockupOutpoints, findLockups } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { lockupContractRegistration } from '@arkade-os/solver-arkade/arkade/vtxoLifecycle.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { mineBlocks, regtestDir } from './support/chain.js'
import { requireStack } from './support/preflight.js'
import {
  assertArkadeSpendable,
  openArkade,
  openFakeLightning,
  SETUP_TIMEOUT_MS,
  tempStoreDir,
  type E2eArkade,
} from './support/stack.js'

const AMOUNT_SATS = 30_000
const CLIENT_REFUND_PUBKEY = hex.encode(schnorr.getPublicKey(new Uint8Array(32).fill(41)))
const RUN_TIMEOUT_MS = 15 * 60_000
const run = promisify(execFile)

let arkade: E2eArkade
let store: SwapStore

describe('an unrolled send lockup is claimed without arkd co-signing', () => {
  beforeAll(async () => {
    await requireStack('unrolled send claim', ['arkd', 'emulator', 'esplora'])
    arkade = await openArkade()
    store = await SwapStore.open(`${tempStoreDir()}/swaps.sqlite`)
  }, SETUP_TIMEOUT_MS)

  afterAll(async () => {
    await store?.close()
    arkade?.close()
  })

  it(
    'spends the exact confirmed lockup with the preimage after its claim CSV matures',
    async () => {
      const { ctx } = arkade
      const ln = openFakeLightning(tempStoreDir(), arkade.network)
      const payInvoice = ln.payInvoice.bind(ln)
      const getPayment = ln.getPayment.bind(ln)
      let revealPreimage = false
      ln.payInvoice = async (params) => {
        const paid = await payInvoice(params)
        return { id: paid.id, status: 'pending' }
      }
      ln.getPayment = async (id) => (revealPreimage ? getPayment(id) : { id, status: 'pending' })
      const service = new SendSwapService({
        store,
        ln,
        arkade: await arkadeOpsFromContext(ctx, arkade.emulator),
        network: arkade.network,
        limits: arkade.limits,
        invoicePrefix: arkade.profile.invoicePrefix,
        maxExposedSats: arkade.maxExposedSats,
        totalCommitted: () => store.committedSats(),
        admission: new AdmissionControl(),
        chainTip: { height: async () => (await ctx.wallet.onchainProvider.getChainTip()).height },
      })
      const claimDelay = relativeDelayFrom(ctx.unilateralDelays.unilateralClaimDelay)
      if (claimDelay.unit !== 'blocks') throw new Error('unrolled claim requires a block-typed arkd')

      await assertArkadeSpendable(arkade, AMOUNT_SATS + 1_000)
      const { invoice } = ln.forgeInvoice(AMOUNT_SATS)
      const quote = await service.quote(invoice, await ctx.wallet.getAddress(), {
        clientRefundPubkey: CLIENT_REFUND_PUBKEY,
      })
      if (!quote.accepted) throw new Error(`solver refused the quote: ${quote.reason}`)
      const swap = quote.swap
      await (
        await ctx.wallet.getContractManager()
      ).createContract(lockupContractRegistration(covenantScriptFromRow(swap), swap.lockupAddress))
      await ctx.wallet.send({ address: swap.lockupAddress, amount: swap.amountSats })
      const funded = await poll(
        async () => (await findLockups(ctx, swap.pkScript)).find((output) => output.value === swap.amountSats),
        { attempts: 30, intervalMs: 2000, whenExhausted: 'funded lockup did not appear' },
      )
      const key = `${funded.txid}:${funded.vout}`
      const paid = await poll(
        async () => {
          await service.tick(swap.id)
          const row = await store.get(swap.id)
          return row.state === 'paid' ? row : null
        },
        { attempts: 30, intervalMs: 2000, whenExhausted: 'Lightning payment did not enter paid state' },
      )
      expect(paid.preimage).toBeNull()
      expect(paid.lockupOutpoints).toContain(funded.txid)

      const feeWallet = await OnchainWallet.create(ctx.identity, 'regtest', ctx.wallet.onchainProvider)
      await run(process.execPath, ['regtest.mjs', 'faucet', feeWallet.address, '0.001', '--confirm'], {
        cwd: regtestDir(),
        timeout: 120_000,
      })
      await poll(async () => ((await feeWallet.getCoins()).some((coin) => coin.status.confirmed) ? true : null), {
        attempts: 30,
        intervalMs: 2000,
        whenExhausted: 'unroll fee wallet was not funded',
      })
      const session = await Unroll.sessionFor(ctx.wallet, { txid: funded.txid, vout: funded.vout }, feeWallet)
      let unrollComplete = false
      for (let stepIndex = 0; stepIndex < 20; stepIndex++) {
        const step = await session.next()
        if (step.type === Unroll.StepType.WAIT) await mineBlocks(1)
        await step.do()
        if (step.type === Unroll.StepType.UNROLL) await mineBlocks(1)
        if (step.type === Unroll.StepType.DONE) {
          unrollComplete = true
          break
        }
      }
      expect(unrollComplete).toBe(true)
      await poll(
        async () => {
          const output = (await findLockupOutpoints(ctx, swap.pkScript)).find(
            (entry) => `${entry.txid}:${entry.vout}` === key,
          )
          return output?.unrolled ? output : null
        },
        { attempts: 30, intervalMs: 2000, whenExhausted: 'funded lockup did not become unrolled' },
      )
      const parent = await ctx.wallet.onchainProvider.getTxStatus(funded.txid)
      expect(parent?.confirmed).toBe(true)
      expect(await mineBlocks(claimDelay.value + 2)).not.toBeNull()

      revealPreimage = true
      const journaled = await poll(
        async () => {
          await service.tick(swap.id)
          const row = await store.get(swap.id)
          const step = row.unrolledClaim
            ? (JSON.parse(row.unrolledClaim) as Record<string, { record?: { soloPackage?: unknown } }>)[key]
            : null
          return step?.record?.soloPackage ? row : null
        },
        { attempts: 45, intervalMs: 2000, whenExhausted: 'solo claim package was not journaled after CSV' },
      )
      expect(journaled.state).toBe('claiming')
      const spender = await poll(
        async () => {
          await service.tick(swap.id)
          const out = (await ctx.wallet.onchainProvider.getTxOutspends(funded.txid))[funded.vout]
          return out?.spent && out.txid ? out.txid : null
        },
        { attempts: 45, intervalMs: 2000, whenExhausted: 'solo claim did not spend the lockup' },
      )
      expect(await mineBlocks(1)).not.toBeNull()
      const claimed = await poll(
        async () => {
          await service.tick(swap.id)
          const row = await store.get(swap.id)
          return row.state === 'claimed' ? row : null
        },
        { attempts: 45, intervalMs: 2000, whenExhausted: 'confirmed solo claim did not settle the swap' },
      )
      const journal = JSON.parse(claimed.unrolledClaim!) as Record<
        string,
        { kind: string; record: { txid: string; confirmedTxid?: string; soloPackage?: { sweepAddress: string } } }
      >
      expect(journal[key]).toMatchObject({
        kind: 'confirmed',
        record: { txid: spender, confirmedTxid: spender, soloPackage: { sweepAddress: feeWallet.address } },
      })
      const tx = Transaction.fromRaw(await ctx.wallet.onchainProvider.getRawTransaction(spender))
      expect(tx.inputsLength).toBe(1)
      expect(tx.getInput(0).txid && hex.encode(tx.getInput(0).txid!)).toBe(funded.txid)
      expect(tx.getInput(0).index).toBe(funded.vout)
      const payoutScript = OutScript.encode(Address(ONCHAIN_NETWORKS[arkade.network]).decode(feeWallet.address))
      expect(tx.outputsLength).toBe(1)
      expect(tx.getOutput(0).script).toEqual(payoutScript)
      expect((await ctx.wallet.onchainProvider.getTxStatus(spender)).confirmed).toBe(true)
    },
    RUN_TIMEOUT_MS,
  )
})
