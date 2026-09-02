/**
 * E2E — one `arkade:BTC -> ethereum:<token>` swap, across BOTH stacks.
 *
 * Everything else in this suite tests one side. `evmQuote.e2e` admits a swap
 * against the live Arkade stack with the EVM half stubbed out; `evmErc20Swap.e2e`
 * drives the contract on anvil with no Arkade at all. Neither can see the thing
 * that actually breaks a corridor: the handoff.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The solver quotes from the real key
 * set and price feed, the client funds the derived lockup with real sats, and
 * the orchestrator's own tick loop then observes that funding and locks tokens
 * on a real chain — approval included. That last step is the one the corridor
 * could not do at all until recently: `ERC20Swap.lock` moves tokens with
 * `transferFrom`, nothing in `src/` ever approved, so every lock reverted and
 * `planEvmSend` read the revert as "not landed yet" and waited out the timeout.
 *
 * The deps are the ones `cli.ts` builds. A stub anywhere here would test the
 * stub.
 *
 * PREREQUISITES, and neither is part of the arkade stack:
 *   - anvil with the ERC20Swap and WETH9 runtime injected — `scripts/e2e-stack.mjs`
 *     starts one (plus the flat regtest feed the quote fixtures read) and removes
 *     it on `down`:
 *         node scripts/e2e-stack.mjs
 *   - `.env.regtest.lnd` for the arkade side, wallet settled
 *     (`scripts/regtest-settle.mjs`)
 *
 * Skipped, not failed, when either is absent.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { EvmSendSwapService } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { EvmSendSwapStore, type EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { evmSendArkadeDeps } from '@arkade-os/solver-corridors-evm/send/evmArkadeDeps.js'
import { createEvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { encodeClaim } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { createEvmBroadcaster } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createNonceSource } from '@arkade-os/solver-rails-evm/evm/nonce.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import { openArkade, type E2eArkade } from './support/stack.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import {
  CLIENT_KEY,
  SOLVER_KEY,
  SWAP_ADDRESS,
  WETH,
  evmChainReady,
  evmRpc,
  sendFrom,
  fundWithWeth,
  installContracts,
  setEth,
  type EvmRpc,
} from './support/evmChain.js'

const SWAP_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/erc20swap.runtime.hex', import.meta.url)), 'utf8')
const WETH_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/weth9.runtime.hex', import.meta.url)), 'utf8')

const FEED_URL = process.env.PRICEFEED_E2E_URL ?? 'http://localhost:8088/btc-asset'
const PRICE_PATH = '/btc/asset'
/** The regtest feed answers 1 unit per sat, and WETH's 18 decimals are irrelevant to that. */
const AMOUNT_SATS = 100_000
/**
 * FRESH PER RUN, and not for tidiness.
 *
 * `findClaimPreimage` scans from block 0 and matches on the payment hash, which
 * is `sha256(preimage)`. A fixed preimage against a long-lived anvil therefore
 * finds the PREVIOUS run's Claim event — so the row reaches `claimed` before
 * this run's client has claimed anything, and the test passes having proven
 * nothing about this swap.
 */
const PREIMAGE = hex.encode(crypto.getRandomValues(new Uint8Array(32)))

let arkade: E2eArkade
let rpc: EvmRpc
let service: EvmSendSwapService
let store: EvmSendSwapStore
let available = false

beforeAll(async () => {
  // BOTH stacks, or nothing. A half-present environment would skip the half
  // this file exists for and report a pass.
  if (!(await evmChainReady())) return
  try {
    const feed = await fetch(FEED_URL, { signal: AbortSignal.timeout(2_000) })
    if (!feed.ok) return
    arkade = await openArkade()
  } catch {
    return
  }

  // SPENDABLE sats are a prerequisite too, and a less obvious one than a
  // running stack. A regtest float whose batch has expired reports its whole
  // value under `recoverable` with `available` at zero — the wallet is healthy,
  // the coins need `recoverVtxos()` first. Funding the lockup then fails deep
  // inside `selectVirtualCoins` with "Insufficient funds", which reads like a
  // corridor bug and is not one. Skip on it, the same as on an absent stack.
  const balance = await arkade.ctx.wallet.getBalance()
  if (balance.available < AMOUNT_SATS) {
    console.warn(
      `evmSendSwap e2e skipped: wallet has ${balance.available} spendable of ${balance.total} ` +
        `(recoverable ${balance.recoverable}). Run the vtxo lifecycle recovery first.`,
    )
    return
  }

  rpc = evmRpc()
  await installContracts(rpc, SWAP_RUNTIME, WETH_RUNTIME)
  const solver = addressFromPrivateKey(SOLVER_KEY)
  await setEth(rpc, solver, 10n ** 20n)
  // The CLIENT claims the lock, so it needs gas of its own — and it has to be
  // the address the lock names, or the contract refuses the claim outright.
  await setEth(rpc, addressFromPrivateKey(CLIENT_KEY), 10n ** 20n)
  // The float the solver pays out of. Locking is what this test is about, so the
  // tokens have to be there before the tick loop asks for them.
  await fundWithWeth(rpc, SOLVER_KEY, 10n ** 18n)

  const ops = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  store = await EvmSendSwapStore.open(betterSqliteDriver(':memory:'))
  const evm = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
  const nonces = createNonceSource(async (address: Uint8Array, block: 'latest' | 'pending') =>
    BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(address)}`, block])) as string),
  )

  service = new EvmSendSwapService({
    store,
    evm,
    broadcast: createEvmBroadcaster({
      rpc,
      privateKey: SOLVER_KEY,
      chainId: 31337,
      gasLimit: 500_000n,
      maxFeeCeilingPerGas: 100n * 10n ** 9n,
      nonces,
      // Anvil mines instantly, so headroom is nominal — it still has to be a
      // real number, because the fee ceiling is computed from it.
      headroomSeconds: 600,
      fastestSecondsPerBlock: 1,
    }),
    ...evmSendArkadeDeps(ops),
    arkade: ops,
    solverEvmAddress: solver,
    blockHeight: async () => Number(await evm.currentBlock()),
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
      // Anvil mines on demand, so depth and age are the test's to advance.
      minConfirmations: 1,
      minAgeSeconds: 0,
      // Anvil mines on demand; the cadence bounds only need to be honest.
      cadence: { fastestSecondsPerBlock: 1, slowestSecondsPerBlock: 1 },
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

/**
 * Tick until the row satisfies `done`, the way the daemon's watch loop would.
 *
 * One tick is the artificial part of any orchestrator test: a funding that has
 * not reached the indexer, or a lock that has not been mined, both read as
 * "nothing to do" — correctly — and are indistinguishable from a refusal if the
 * test only ever asks once.
 */
const tickUntil = async (id: string, done: (row: EvmSendSwapRow) => boolean, timeoutMs = 120_000) => {
  const deadline = Date.now() + timeoutMs
  let row = await store.get(id)
  while (!done(row) && Date.now() < deadline) {
    await service.tick(id)
    row = await store.get(id)
    if (!done(row)) await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return row
}

describe('e2e arkade:BTC->ethereum:<token> (send) — both stacks', () => {
  onBothStacks(
    'quotes, takes the client’s sats, and locks the tokens the quote promised',
    async () => {
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const refundAddress = await arkade.ctx.wallet.getAddress()

      // 1. ADMISSION, against the real key set and the real price feed.
      const outcome = await service.quote({
        paymentHash: hex.encode(sha256(hex.decode(PREIMAGE))),
        tokenAddress: `0x${hex.encode(WETH)}`,
        amountSats: AMOUNT_SATS,
        // The client's OWN address. `ERC20Swap.claim` checks `msg.sender`, so a
        // placeholder here makes the claim below unsatisfiable.
        evmClaimAddress: `0x${hex.encode(addressFromPrivateKey(CLIENT_KEY))}`,
        refundAddress,
        clientRefundPubkey: clientKey,
      })
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (!outcome.accepted) return
      const row = outcome.swap

      // The lockup is derivable and on this network — the covenant half, which
      // `evmQuote.e2e` also checks but which everything below depends on.
      expect(row.lockupAddress.startsWith(`${arkade.ctx.hrp}1`)).toBe(true)

      // 2. THE CLIENT FUNDS IT. Real sats to the address the solver derived.
      await arkade.ctx.wallet.send({ address: row.lockupAddress, amount: AMOUNT_SATS })

      // 3. THE TICK LOOP LOCKS. Nothing here tells it to — it observes the
      //    funding through the same `findLockups` read the daemon uses, and
      //    decides. This is the step that reverted for want of an approval.
      //
      //    TICKED IN A LOOP, because one tick is the artificial part. The
      //    daemon runs this on a watch loop; a funding that has not reached the
      //    indexer yet simply reads as unfunded and the row stays `quoted`,
      //    which is correct behaviour and indistinguishable from a real refusal
      //    if the test only ever asks once.
      const locked = await tickUntil(row.id, (r) => r.state !== 'quoted')
      expect(locked.state, `row did not reach locking_evm: ${JSON.stringify(locked)}`).toBe('locking_evm')
      expect(locked.evmLockTxid, 'no lock txid recorded').toMatch(/^0x[0-9a-f]+$/)

      // 4. AND THE CHAIN AGREES. The contract's own `swaps` mapping, addressed
      //    by our own key derivation — the assertion that a lock which exists
      //    but cannot be found is worth nothing.
      const lock = evmSendArkadeDeps(await arkadeOpsFromContext(arkade.ctx, arkade.emulator)).lockFor(locked)
      const backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
      expect(await backend.isLocked(lock), 'the lock is not on chain').toBe(true)

      // The amount locked is the one the quote promised, not whatever was handy.
      expect(lock.amount).toBe(BigInt(row.evmAmount))

      // 5. THE LOCK MATURES and the row moves to awaiting_claim. Depth and age
      //    are both required, and anvil only mines when asked.
      await rpc('anvil_mine', ['0x5'])
      await tickUntil(row.id, (r) => r.state !== 'locking_evm')
      expect((await store.get(row.id)).state).toBe('awaiting_claim')

      // 6. THE CLIENT CLAIMS THE TOKENS, revealing the preimage on chain. This
      //    is the cross-leg mechanism: the solver has no other way to learn it.
      const claimed = await sendFrom(rpc, CLIENT_KEY, SWAP_ADDRESS, encodeClaim(hex.decode(PREIMAGE), lock))
      expect(claimed.status, 'the client could not claim the lock').toBe('0x1')
      expect(await backend.isLocked(lock), 'the lock survived its own claim').toBe(false)

      // 7. THE SOLVER READS IT OFF THE LOG and takes the Arkade side. Nothing
      //    hands it the preimage — it scans for the Claim event, verifies the
      //    hash, and only then spends the lockup the client funded.
      const settled = await tickUntil(row.id, (r) => r.state === 'claimed' || r.failureReason !== null)
      expect(settled.failureReason, `arkade claim failed: ${settled.failureReason}`).toBeNull()
      expect(settled.state).toBe('claimed')
      expect(settled.preimage, 'the preimage was never recorded').toBe(PREIMAGE)
      expect(settled.claimArkTxid, 'no arkade claim txid').toMatch(/^[0-9a-f]{64}$/)
    },
    600_000,
  )

  onBothStacks(
    'a client that funds and never claims — the solver refunds past the on-chain timeout',
    async () => {
      // FRESH PER TEST, for the reason the module-level one is: a fixed preimage
      // against a long-lived anvil finds a PREVIOUS run's Claim event, and the
      // row would reach `claimed` without this test's client claiming anything.
      const preimage = hex.encode(crypto.getRandomValues(new Uint8Array(32)))
      const clientKey = hex.encode(await arkade.ctx.identity.xOnlyPublicKey())
      const refundAddress = await arkade.ctx.wallet.getAddress()

      const outcome = await service.quote({
        paymentHash: hex.encode(sha256(hex.decode(preimage))),
        tokenAddress: `0x${hex.encode(WETH)}`,
        amountSats: AMOUNT_SATS,
        evmClaimAddress: `0x${hex.encode(addressFromPrivateKey(CLIENT_KEY))}`,
        refundAddress,
        clientRefundPubkey: clientKey,
      })
      expect(outcome.accepted, `refused: ${JSON.stringify(outcome)}`).toBe(true)
      if (!outcome.accepted) return
      const row = outcome.swap

      // THE ROW'S TIMEOUT IS A HEIGHT, not the seconds value the acceptance gate
      // computed. The old bug stored seconds here (~1.75e9), which the contract
      // read as a block count — centuries at any real cadence — and the refund
      // branch never fired. A real EVM height is far below this bound.
      expect(row.evmTimeout).toBeLessThan(100_000_000)

      await arkade.ctx.wallet.send({ address: row.lockupAddress, amount: AMOUNT_SATS })

      // THE TICK LOOP LOCKS, and the lock matures to awaiting_claim.
      await tickUntil(row.id, (r) => r.state === 'locking_evm' || r.state === 'awaiting_claim')
      await rpc('anvil_mine', ['0x5'])
      const awaiting = await tickUntil(row.id, (r) => r.state !== 'locking_evm')
      expect(awaiting.state).toBe('awaiting_claim')

      const backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
      const lock = evmSendArkadeDeps(await arkadeOpsFromContext(arkade.ctx, arkade.emulator)).lockFor(awaiting)
      expect(await backend.isLocked(lock), 'the lock is not on chain').toBe(true)

      // THE CLIENT NEVER CLAIMS. Advancing the chain past the timelock the row
      // carries is what makes the refund legal — before it, the contract
      // rejects the call, which is why the seconds-as-height bug left the
      // tokens stranded: this mine could never catch up to 1.75e9 blocks.
      const height = Number(await backend.currentBlock())
      const remaining = row.evmTimeout - height + 1
      expect(remaining).toBeGreaterThan(0)
      await rpc('anvil_mine', ['0x' + remaining.toString(16)])

      const settled = await tickUntil(row.id, (r) => r.state === 'refunded' || r.failureReason !== null)
      expect(settled.failureReason, `refund failed: ${settled.failureReason}`).toBeNull()
      expect(settled.state, `row parked in ${settled.state}`).toBe('refunded')
      expect(settled.evmRefundTxid, 'no refund txid recorded').toMatch(/^0x[0-9a-f]+$/)

      // The broadcaster resolves once the node ACCEPTS the transaction, not once
      // it is mined — so wait for the receipt before asserting the on-chain
      // effect. A reverted refund would leave the row reading `refunded` with
      // the lock still funded; the receipt is what rules that out.
      let receipt: { status: string } | null = null
      for (let attempt = 0; attempt < 30 && receipt === null; attempt += 1) {
        receipt = (await rpc('eth_getTransactionReceipt', [settled.evmRefundTxid])) as { status: string } | null
        if (receipt === null) await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      expect(receipt, 'refund transaction never mined').not.toBeNull()
      expect(receipt!.status, 'the refund reverted on-chain').toBe('0x1')
      expect(await backend.isLocked(lock), 'the lock survived its own refund').toBe(false)
    },
    600_000,
  )
})
