/**
 * E2E — one `ethereum:<token> -> arkade:BTC` swap, across BOTH stacks.
 *
 * The mirror of `evmSendSwap.e2e`, and worth its own file because the corridor
 * runs the other way round: here the CLIENT locks first and carries the
 * deadline, the solver funds the Arkade side out of its own float, and the
 * preimage is revealed on ARKADE rather than on the chain.
 *
 * That inversion moves the risk. On the send leg the solver's exposure ends when
 * it learns the preimage; here the solver spends its own sats BEFORE it has any
 * secret, on the strength of a lock it observed. So the observation is the money
 * decision, and the read behind it is spend-aware on purpose — a claimed lockup
 * must still count as funded, or a crash between funding and recording the txid
 * pays the client twice out of the solver's float.
 *
 * Written after the send leg turned up two bugs neither side's own tests could
 * see: a lock that could never be approved, and a preimage that could never be
 * read. Both lived exactly here, in the handoff.
 *
 * PREREQUISITES: the arkade regtest stack with `.env.regtest.lnd`, anvil, and a
 * float with spendable sats. Skipped, not failed, when any is absent.
 *
 * FAILS ON THIS BRANCH UNTIL #114 MERGES, and it is right to. Run against a
 * float whose coins carry assets, step 3 dies with
 *
 *   ASSET_VALIDATION_FAILED (33): asset packet not found in tx <txid>
 *
 * because spending an asset-bearing coin moves its asset, so the transaction
 * must carry a packet saying where that asset went — and `sendBitcoin` builds a
 * plain sats transfer with no packet. That is the defect #114 fixes, by letting
 * the SDK's `send` route the asset change and discounting each asset-bearing
 * coin by one dust of headroom.
 *
 * Worth stating because it is not a rediscovery: #114 found this on the
 * LIGHTNING receive leg. This file reproduces it on the EVM receive leg, which
 * that PR was never tested against — the fix is in shared funding code, so it
 * reaches both, and this is the evidence that it needs to.
 *
 * Observed float at the time of writing: one spendable coin, 6_992_307 sats,
 * carrying two assets — the shape issue #123 describes, where a no-arg settle
 * merges every coin into one and the assets ride along.
 *
 * VERIFIED GREEN with #114 merged: this whole corridor runs against that same
 * asset-bearing float — the client locks, the solver funds sats out of a coin
 * carrying two assets, the client claims on Arkade, and the solver reads the
 * preimage back and takes the tokens. So the fix does reach this corridor,
 * which was an inference until it was run.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { EvmReceiveSwapService } from '@arkade-os/solver-corridors-evm/receive/evmOrchestrator.js'
import { EvmReceiveSwapStore, type EvmReceiveSwapRow } from '@arkade-os/solver-corridors-evm/db/evmReceiveSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { receiveArkadeOpsFromContext } from '@arkade-os/solver-corridors/receive/arkadeOps.js'
import { evmReceiveArkadeDeps } from '@arkade-os/solver-corridors-evm/receive/evmArkadeDeps.js'
import { createEvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { createEvmBroadcaster } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createNonceSource } from '@arkade-os/solver-rails-evm/evm/nonce.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { openArkade, type E2eArkade } from './support/stack.js'
import { clientClaimLockup } from './support/clientClaim.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import {
  CLIENT_KEY,
  SOLVER_KEY,
  SWAP_ADDRESS,
  WETH,
  evmChainReady,
  evmRpc,
  fundWithWeth,
  installContracts,
  sendFrom,
  setEth,
  type EvmRpc,
} from './support/evmChain.js'

const SWAP_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/erc20swap.runtime.hex', import.meta.url)), 'utf8')
const WETH_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/weth9.runtime.hex', import.meta.url)), 'utf8')

const FEED_URL = process.env.PRICEFEED_E2E_URL ?? 'http://localhost:8088/btc-asset'
const PRICE_PATH = '/btc/asset'
/** The regtest feed answers 1 unit per sat, so this is ~100_000 sats of value. */
const EVM_AMOUNT = 100_000n
/** Fresh per run — see the note in `evmSendSwap.e2e`; a fixed one finds the previous run's Claim. */
const PREIMAGE = hex.encode(crypto.getRandomValues(new Uint8Array(32)))

let arkade: E2eArkade
let rpc: EvmRpc
let service: EvmReceiveSwapService
let store: EvmReceiveSwapStore
let available = false

beforeAll(async () => {
  if (!(await evmChainReady())) return
  try {
    const feed = await fetch(FEED_URL, { signal: AbortSignal.timeout(2_000) })
    if (!feed.ok) return
    arkade = await openArkade()
  } catch {
    return
  }

  // The SOLVER funds the Arkade side out of its own float on this leg, so
  // spendable sats are not incidental — they are the thing being spent.
  const balance = await arkade.ctx.wallet.getBalance()
  if (balance.available < 200_000) {
    console.warn(
      `evmReceiveSwap e2e skipped: wallet has ${balance.available} spendable of ${balance.total} ` +
        `(recoverable ${balance.recoverable}). Run the vtxo lifecycle recovery first.`,
    )
    return
  }

  rpc = evmRpc()
  await installContracts(rpc, SWAP_RUNTIME, WETH_RUNTIME)
  const solver = addressFromPrivateKey(SOLVER_KEY)
  const client = addressFromPrivateKey(CLIENT_KEY)
  await setEth(rpc, solver, 10n ** 20n)
  await setEth(rpc, client, 10n ** 20n)
  // The CLIENT holds the tokens here — it is the one locking.
  await fundWithWeth(rpc, CLIENT_KEY, 10n ** 18n)

  const ops = await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)
  store = await EvmReceiveSwapStore.open(betterSqliteDriver(':memory:'))
  const evm = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
  const nonces = createNonceSource(async (address: Uint8Array, block: 'latest' | 'pending') =>
    BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(address)}`, block])) as string),
  )

  service = new EvmReceiveSwapService({
    store,
    evm,
    broadcast: createEvmBroadcaster({
      rpc,
      privateKey: SOLVER_KEY,
      chainId: 31337,
      gasLimit: 500_000n,
      maxFeeCeilingPerGas: 100n * 10n ** 9n,
      nonces,
      headroomSeconds: 600,
      fastestSecondsPerBlock: 1,
    }),
    ...evmReceiveArkadeDeps(ops),
    arkade: ops,
    blockHeight: async () => Number(await evm.currentBlock()),
    // Where the SOLVER claims the client's tokens.
    evmClaimAddress: `0x${hex.encode(solver)}`,
    maxExposedSats: 1_000_000_000,
    admission: new AdmissionControl(),
    totalCommitted: async () => 0,
    markets: new Map([
      [
        `0x${hex.encode(WETH)}`,
        {
          token: { symbol: 'WETH', address: `0x${hex.encode(WETH)}`, decimals: 0 },
          market: {
            token: { symbol: 'WETH', address: `0x${hex.encode(WETH)}`, decimals: 0 },
            priceFeed: FEED_URL,
            pricePath: PRICE_PATH,
          },
          limits: { minSats: 1_000, maxSats: 10_000_000 },
          fee: { bps: 100, flatSats: 0 },
        },
      ],
    ]),
    fetchPrice: createPriceFeed(),
    chain: {
      contractAddress: `0x${hex.encode(SWAP_ADDRESS)}`,
      chainId: 31337,
      minConfirmations: 1,
      minAgeSeconds: 0,
      // Anvil mines on demand; the pair only has to be ordered and positive for
      // the deadline arithmetic to be meaningful.
      cadence: { fastestSecondsPerBlock: 1, slowestSecondsPerBlock: 2 },
      quoteValiditySeconds: 60,
    },
  })
  available = true
}, 240_000)

const onBothStacks: typeof it = ((name: string, fn: any, timeout?: number) =>
  it(
    name,
    async (ctx: any) => {
      if (!available) return ctx.skip()
      await fn(ctx)
    },
    timeout,
  )) as never

/** Tick the way the daemon's watch loop would. @see evmSendSwap.e2e */
const tickUntil = async (id: string, done: (row: EvmReceiveSwapRow) => boolean, timeoutMs = 150_000) => {
  const deadline = Date.now() + timeoutMs
  let row = await store.get(id)
  while (!done(row) && Date.now() < deadline) {
    await service.tick(id)
    row = await store.get(id)
    if (!done(row)) await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return row
}

describe('e2e ethereum:<token>->arkade:BTC (receive) — both stacks', () => {
  onBothStacks(
    'takes the client’s tokens, pays sats from the float, and claims on the preimage the client revealed',
    async () => {
      const payoutPubkey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const payoutAddress = await arkade.ctx.wallet.getAddress()
      const tip = Number(await createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc }).currentBlock())

      // 1. ADMISSION. The CLIENT names the amount and carries the deadline —
      //    the inversion that defines this leg.
      const outcome = await service.quote({
        paymentHash: hex.encode(sha256(hex.decode(PREIMAGE))),
        tokenAddress: `0x${hex.encode(WETH)}`,
        evmAmount: EVM_AMOUNT.toString(),
        evmTimeout: tip + 50_000,
        evmRefundAddress: `0x${hex.encode(addressFromPrivateKey(CLIENT_KEY))}`,
        payoutAddress,
        payoutPubkey,
      })
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (!outcome.accepted) return
      const row = outcome.swap

      // 2. THE CLIENT LOCKS ITS TOKENS, approving first — the same sequence the
      //    solver needs on the other leg, done here by hand because the client
      //    is not this codebase.
      const lock = evmReceiveArkadeDeps(await receiveArkadeOpsFromContext(arkade.ctx, arkade.emulator)).lockFor(row)
      const backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
      for (const call of backend.lockCalls(lock, await backend.allowance(WETH, addressFromPrivateKey(CLIENT_KEY)))) {
        expect((await sendFrom(rpc, CLIENT_KEY, call.to, call.data, call.value)).status).toBe('0x1')
      }
      expect(await backend.isLocked(lock), 'the client’s lock is not on chain').toBe(true)

      // 3. THE SOLVER FUNDS THE ARKADE SIDE, out of its own float, on the
      //    strength of that lock alone — before it has any secret. This is the
      //    money decision on this corridor.
      await rpc('anvil_mine', ['0x5'])
      const funded = await tickUntil(row.id, (r) => r.fundArkTxid !== null || r.failureReason !== null)
      expect(funded.failureReason, `funding failed: ${funded.failureReason}`).toBeNull()
      expect(funded.fundArkTxid, 'the solver never funded the lockup').toMatch(/^[0-9a-f]{64}$/)

      // 4. THE CLIENT CLAIMS THE SATS, revealing the preimage on ARKADE. The
      //    mirror of the send leg, where it was revealed on the EVM chain.
      const claimTxid = await clientClaimLockup(
        arkade.ctx,
        {
          payoutPubkey: funded.payoutPubkey,
          // Not on the row — the client's own address, which the client knows.
          payoutAddress,
          payoutPkScript: funded.receiverPkScript,
          solverPubkey: funded.providerPubkey,
          solverRefundPkScript: funded.refundPkScript,
          serverPubkey: funded.serverPubkey,
          emulatorPubkey: funded.emulatorPubkey,
          paymentHash: funded.paymentHash,
          refundLocktime: funded.refundLocktime,
          claimDelay: funded.claimDelay,
          refundDelay: funded.refundDelay,
          refundWithoutReceiverDelay: funded.refundWithoutReceiverDelay,
          pkScript: funded.pkScript,
          nonInteractiveParameters: funded.nonInteractiveParameters ?? false,
        },
        hex.decode(PREIMAGE),
      )
      expect(claimTxid).toMatch(/^[0-9a-f]{64}$/)

      // 5. THE SOLVER READS IT OFF ARKADE and takes the tokens it is owed.
      const settled = await tickUntil(row.id, (r) => r.state === 'claimed' || r.failureReason !== null)
      expect(settled.failureReason, `evm claim failed: ${settled.failureReason}`).toBeNull()
      expect(settled.state).toBe('claimed')
      expect(settled.preimage, 'the preimage was never recorded').toBe(PREIMAGE)

      // MINED, then read. The row reaches `claimed` the moment `broadcast`
      // returns a txid — deliberately, because on this leg the preimage is the
      // solver's only means of payment and losing it between claiming and
      // recording costs the swap's whole value. So `claimed` means "sent", not
      // "confirmed", and on anvil nothing confirms until asked. Reading
      // `isLocked` straight after the transition races the mine and fails while
      // the corridor is working.
      await rpc('anvil_mine', ['0x1'])
      expect(await backend.isLocked(lock), 'the solver never claimed the tokens').toBe(false)
    },
    600_000,
  )
})
