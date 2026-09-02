/**
 * E2E — the EVM binding against the REAL `ERC20Swap` bytecode.
 *
 * Everything else that tests `packages/solver-rails-evm/src/evm/` reasons about the contract: it rebuilds
 * a layout by hand, pins a selector, or compares against a fixture read off the
 * chain. Useful, and all of it shares one blind spot — the contract never
 * actually runs. A field order that is wrong in a way our reconstruction is
 * also wrong about would pass every one of them.
 *
 * Here the contract runs. An empty `anvil` chain, with the REAL runtime bytecode
 * of both `ERC20Swap` and WETH9 injected via `anvil_setCode`, and every
 * transaction built and signed by
 * `packages/solver-rails-evm/src/evm/transaction.ts`. Nothing in the path is a stand-in: if the EVM
 * accepts our calldata and the contract's own storage says the lock exists,
 * that is the contract agreeing with us.
 *
 * WHAT THIS PROVES THAT NOTHING ELSE DOES. The `Claim` event's field layout.
 * Every other check confirms the event EXISTS — the topic is in the bytecode,
 * the signature is in the source — but none confirms that `preimageHash` is
 * `topics[1]` and the preimage is the whole of `data`. Reading a real emitted
 * log back through `findClaimPreimage` is the only thing that does.
 *
 * PREREQUISITE, and it is not part of the arkade stack: an anvil container,
 * started and (when you are done) removed by
 *
 *   node scripts/e2e-stack.mjs        # anvil + the flat regtest feed, foreground
 *   node scripts/e2e-stack.mjs down   # remove the container again
 *
 * No `--fork-url`, and deliberately so: `installContracts` puts both contracts
 * on an empty chain with `anvil_setCode` from a committed bytecode fixture, and
 * `fundWithWeth` mints from ETH rather than impersonating a whale. Nothing here
 * reads fork state, so forking would only cost a mainnet RPC a developer may
 * not have and change the chain id and block height out from under the tests.
 *
 * Skipped, not failed, when it is absent: this corridor is not part of the
 * default local stack and a developer working on Lightning should not have to
 * run an EVM node.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { encodeClaim, encodeLock, encodeRefund, swapKey, type Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { createEvmHtlcBackend, type EvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { createNonceSource } from '@arkade-os/solver-rails-evm/evm/nonce.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import {
  CLIENT_KEY,
  SOLVER_KEY,
  SWAP_ADDRESS,
  WETH,
  abiCall,
  balanceOf,
  evmChainReady,
  evmRpc,
  broadcastWithNonce,
  fundWithWeth,
  setEth,
  waitForReceipt,
  installContracts,
  sendFrom,
  word,
  type EvmRpc,
} from './support/evmChain.js'

const SWAP_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/erc20swap.runtime.hex', import.meta.url)), 'utf8')
const WETH_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/weth9.runtime.hex', import.meta.url)), 'utf8')

const solver = addressFromPrivateKey(SOLVER_KEY)
const client = addressFromPrivateKey(CLIENT_KEY)
const AMOUNT = 5_000_000_000_000_000n // 0.005 WETH

let rpc: EvmRpc
let backend: EvmHtlcBackend
let available = false

const lockFor = (preimage: Uint8Array, timelock: bigint): Erc20SwapLock => ({
  preimageHash: sha256(preimage),
  amount: AMOUNT,
  tokenAddress: WETH,
  claimAddress: client,
  refundAddress: solver,
  timelock,
})

beforeAll(async () => {
  available = await evmChainReady()
  if (!available) return
  rpc = evmRpc()
  backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
  await installContracts(rpc, SWAP_RUNTIME, WETH_RUNTIME)
}, 120_000)

const itOnChain: typeof it = ((name: string, fn: any, timeout?: number) =>
  it(
    name,
    async (ctx: any) => {
      // `ctx.skip()` throws vitest`s skip signal today, so the return is
      // redundant — but only by that internal detail. Explicit, so a future
      // vitest that makes skip a non-throwing flag skips instead of running the
      // body against a chain that is not there.
      if (!available) return ctx.skip()
      await fn(ctx)
    },
    timeout,
  )) as never

describe('EVM ERC20Swap — against the deployed contract`s own bytecode', () => {
  itOnChain(
    'locks, is found by our own key derivation, and pays the claimant',
    async () => {
      const preimage = hex.decode('11'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      const approve = await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))
      expect(approve.status).toBe('0x1')

      // THE LOCK, built by `encodeLock` and signed by our own signer.
      const locked = await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeLock(lock))
      expect(locked.status).toBe('0x1')

      // The contract's own `swaps` mapping, addressed by OUR `swapKey`. If the
      // derivation disagreed with `hashValues` by a byte this reads false — the
      // failure mode where a funded lock cannot be found.
      expect(await backend.isLocked(lock)).toBe(true)
      expect(swapKey(lock)).toHaveLength(32)

      const before = await balanceOf(rpc, WETH, client)
      const claimed = await sendFrom(rpc, CLIENT_KEY, SWAP_ADDRESS, encodeClaim(preimage, lock))
      expect(claimed.status).toBe('0x1')
      expect(await balanceOf(rpc, WETH, client)).toBe(before + AMOUNT)

      // THE ASSERTION NOTHING ELSE MAKES: a real emitted Claim log, read back
      // through the reader the corridor depends on for its cross-leg signal.
      // This is what confirms `preimageHash` is topics[1] and the preimage is
      // the whole of `data` — source and bytecode only ever showed the event
      // exists.
      const found = await backend.findClaimPreimage(lock, locked.blockNumber)
      expect(found).not.toBeNull()
      expect(hex.encode(found!)).toBe(hex.encode(preimage))

      // The flag is deleted on claim, so the same lock reads unfunded.
      expect(await backend.isLocked(lock)).toBe(false)
    },
    180_000,
  )

  itOnChain(
    'lockPrepayMinerfee funds the claimant with native currency, in the same transaction',
    async () => {
      // THE MECHANISM THE CONTRACT CHOICE RESTS ON, and until now the only
      // function in the binding never actually executed. A client receiving
      // tokens usually holds no native asset, so without this it cannot pay for
      // its own claim and every such swap resolves by timeout.
      const preimage = hex.decode('66'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)
      const PREPAY = 5_000_000_000_000_000n // 0.005 ETH — comfortably covers one claim

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))

      // Drain the claimant so the prepay is the ONLY thing that could fund it.
      await setEth(rpc, client, 0n)
      try {
        expect(BigInt((await rpc('eth_getBalance', [`0x${hex.encode(client)}`, 'latest'])) as string)).toBe(0n)

        const call = backend.lockPrepayCall(lock, PREPAY, solver)
        expect(call.value).toBe(PREPAY)
        const locked = await sendFrom(rpc, SOLVER_KEY, call.to, call.data, call.value)
        expect(locked.status).toBe('0x1')

        // The tokens are locked AND the claimant now holds gas money — both from
        // the one transaction.
        expect(await backend.isLocked(lock)).toBe(true)
        const claimantEth = BigInt((await rpc('eth_getBalance', [`0x${hex.encode(client)}`, 'latest'])) as string)
        expect(claimantEth).toBe(PREPAY)

        // And it is enough to actually claim with, which is the whole point.
        const claimed = await sendFrom(rpc, CLIENT_KEY, SWAP_ADDRESS, encodeClaim(preimage, lock))
        expect(claimed.status).toBe('0x1')
        expect(await backend.isLocked(lock)).toBe(false)
      } finally {
        // `finally`, not a trailing line. Anvil state is shared across every
        // test in this file, so a failure ANYWHERE above would leave the
        // claimant broke and every later test that sends from it would fail out
        // of gas — burying the one real failure under a cascade of unrelated
        // ones. This leaked once already when the restore was the last
        // statement of the body; a second failure point brought it back.
        await setEth(rpc, client, 10n ** 18n)
      }
    },
    180_000,
  )

  itOnChain(
    'the contract really does key the lock by msg.sender, which lockPrepayCall guards',
    async () => {
      // `lockPrepayMinerfee` passes five parameters — refundAddress is NOT one
      // of them; the contract fills it from msg.sender. `lockPrepayCall`
      // refuses a sender that is not `lock.refundAddress` on that basis. This
      // confirms the basis rather than trusting the source: locking from the
      // solver must produce a lock our key finds with refundAddress = solver.
      const preimage = hex.decode('77'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))
      const call = backend.lockPrepayCall(lock, 1_000_000_000_000n, solver)
      expect((await sendFrom(rpc, SOLVER_KEY, call.to, call.data, call.value)).status).toBe('0x1')

      // Found under refundAddress = solver — so msg.sender is what the contract
      // stored, and the guard protects a real invariant.
      expect(await backend.isLocked(lock)).toBe(true)
      // The same lock with any other refundAddress is a DIFFERENT key, and
      // unfunded. This is the failure the guard exists to prevent.
      expect(await backend.isLocked({ ...lock, refundAddress: client })).toBe(false)
    },
    180_000,
  )

  itOnChain(
    'two transactions in flight at once both land, on the nonces the source issued',
    async () => {
      // THE NONCE HAZARD, actually exercised. An earlier version of this test
      // fetched two nonces, ignored them, and then made two SEQUENTIAL sends —
      // which pass whether or not a nonce source exists, because `sendFrom`
      // waits for each receipt. The scenario being guarded against never
      // occurred.
      //
      // Here both transactions are signed with nonces from the source and put
      // in the mempool before either is mined. With `latest` both would carry
      // the same nonce and the second would replace the first; only one deposit
      // would land.
      const source = createNonceSource(async (address, block) =>
        BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(address)}`, block])) as string),
      )
      const DEPOSIT = hex.decode('d0e30db0') // WETH deposit()
      const each = 1_000_000_000_000n

      const wethBefore = await balanceOf(rpc, WETH, solver)
      const latestBefore = BigInt(
        (await rpc('eth_getTransactionCount', [`0x${hex.encode(solver)}`, 'latest'])) as string,
      )

      const first = await source.next(solver)
      const second = await source.next(solver)
      expect(second).toBe(first + 1n)

      // Both broadcast before either is mined — that is the whole point.
      const hashes = await Promise.all([
        broadcastWithNonce(rpc, SOLVER_KEY, first, WETH, DEPOSIT, each),
        broadcastWithNonce(rpc, SOLVER_KEY, second, WETH, DEPOSIT, each),
      ])
      expect(new Set(hashes).size).toBe(2)

      const receipts = await Promise.all(hashes.map((h) => waitForReceipt(rpc, h)))
      for (const receipt of receipts) expect(receipt.status).toBe('0x1')

      // BOTH deposits landed. Under a `latest`-based nonce the second would
      // have replaced the first and this would be one deposit's worth.
      expect(await balanceOf(rpc, WETH, solver)).toBe(wethBefore + each * 2n)
      expect(BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(solver)}`, 'latest'])) as string)).toBe(
        latestBefore + 2n,
      )
    },
    180_000,
  )

  itOnChain(
    'a FRESH source does not reissue a nonce that is still in the mempool',
    async () => {
      // The case the `pending` read exists for, and the only one that
      // distinguishes it from `latest`.
      //
      // Within one process the high-water mark already prevents reuse — which
      // is why a first attempt at this test passed even with the source
      // mutated to read `latest`. The mark is gone after a restart, though, and
      // a transaction we broadcast may still be unmined. A fresh source that
      // asked `latest` would hand out a nonce that is already occupied, and the
      // new transaction would REPLACE the pending one.
      //
      // Automine is disabled so a transaction genuinely sits in the mempool.
      const newSource = () =>
        createNonceSource(async (address, block) =>
          BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(address)}`, block])) as string),
        )
      const DEPOSIT = hex.decode('d0e30db0')
      const each = 1_000_000_000_000n

      await rpc('anvil_setAutomine', [false])
      try {
        const wethBefore = await balanceOf(rpc, WETH, solver)
        const first = await newSource().next(solver)
        const firstHash = await broadcastWithNonce(rpc, SOLVER_KEY, first, WETH, DEPOSIT, each)

        // Unmined: the two counters now disagree, which is the whole premise.
        const latest = BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(solver)}`, 'latest'])) as string)
        const pending = BigInt((await rpc('eth_getTransactionCount', [`0x${hex.encode(solver)}`, 'pending'])) as string)
        expect(pending).toBe(latest + 1n)

        // A SOURCE WITH NO MEMORY — as after a restart.
        const second = await newSource().next(solver)
        expect(second).toBe(first + 1n)
        const secondHash = await broadcastWithNonce(rpc, SOLVER_KEY, second, WETH, DEPOSIT, each)
        expect(secondHash).not.toBe(firstHash)

        await rpc('anvil_mine', ['0x1'])
        for (const h of [firstHash, secondHash]) expect((await waitForReceipt(rpc, h)).status).toBe('0x1')
        // Both landed, so neither replaced the other.
        expect(await balanceOf(rpc, WETH, solver)).toBe(wethBefore + each * 2n)
      } finally {
        await rpc('anvil_setAutomine', [true])
      }
    },
    180_000,
  )

  itOnChain(
    'refuses a claim with the wrong preimage, leaving the lock funded',
    async () => {
      // The property the whole hash-lock rests on. A revert here is the
      // contract enforcing it; the lock surviving is us reading that correctly.
      const preimage = hex.decode('22'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))
      expect((await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeLock(lock))).status).toBe('0x1')

      const wrong = await sendFrom(rpc, CLIENT_KEY, SWAP_ADDRESS, encodeClaim(hex.decode('33'.repeat(32)), lock))
      expect(wrong.status).toBe('0x0')
      expect(await backend.isLocked(lock)).toBe(true)
      expect(await backend.findClaimPreimage(lock, tip)).toBeNull()
    },
    180_000,
  )

  itOnChain(
    'refuses a refund before the timelock',
    async () => {
      // Our own recourse must not open early — the ordering gates in
      // `core/evmSend.ts` assume the contract enforces this, and here it does.
      const preimage = hex.decode('44'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 10_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))
      expect((await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeLock(lock))).status).toBe('0x1')

      const early = await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeRefund(lock))
      expect(early.status).toBe('0x0')
      expect(await backend.isLocked(lock)).toBe(true)
    },
    180_000,
  )

  itOnChain(
    'allows the refund once the timelock has passed, and returns the tokens',
    async () => {
      const preimage = hex.decode('55'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)))
      expect((await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeLock(lock))).status).toBe('0x1')

      // Past the height rather than waiting for it — the block number is what
      // the contract compares, so mining is the honest way to advance it.
      await rpc('anvil_mine', ['0x10'])

      const before = await balanceOf(rpc, WETH, solver)
      const refunded = await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeRefund(lock))
      expect(refunded.status).toBe('0x1')
      expect(await balanceOf(rpc, WETH, solver)).toBe(before + AMOUNT)
      expect(await backend.isLocked(lock)).toBe(false)
    },
    180_000,
  )

  itOnChain(
    'REVERTS when the solver has not approved — the bug lockCalls exists for',
    async () => {
      // The reason the corridor could not complete a single send swap. Every
      // test above hand-rolls an `approve` before locking; nothing in `src/`
      // did, so `lock` reverted every time. And `planEvmSend` cannot tell a
      // revert from a lock that has not landed — both read as absent — so the
      // swap waited out `evmTimeout` and then refunded a lock that never was.
      //
      // Asserted against the deployed bytecode rather than a mock, because the
      // claim being made is about what the CONTRACT does with no allowance.
      const preimage = hex.decode('cc'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      // Deliberately NO approve. The balance is there; only the allowance is not.
      expect(await balanceOf(rpc, WETH, solver)).toBeGreaterThanOrEqual(AMOUNT)
      expect(await backend.allowance(WETH, solver)).toBe(0n)

      const reverted = await sendFrom(rpc, SOLVER_KEY, SWAP_ADDRESS, encodeLock(lock))
      expect(reverted.status).toBe('0x0')
      // And the shape of the failure: nothing to find, nothing to refund.
      expect(await backend.isLocked(lock)).toBe(false)
    },
    180_000,
  )

  itOnChain(
    'lockCalls funds the lock from a standing allowance of zero',
    async () => {
      // The fix, end to end: the corridor asks `lockCalls` what a lock costs and
      // broadcasts the list. No hand-rolled approval anywhere — if the sequence
      // were wrong the lock would revert exactly as above.
      const preimage = hex.decode('dd'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      const standing = await backend.allowance(WETH, solver)
      const calls = backend.lockCalls(lock, standing)

      let last = ''
      for (const call of calls) {
        const receipt = await sendFrom(rpc, SOLVER_KEY, call.to, call.data, call.value)
        expect(receipt.status, `call to ${hex.encode(call.to)} reverted`).toBe('0x1')
        last = receipt.hash
      }
      expect(await backend.isLocked(lock)).toBe(true)

      // The allowance is spent, not left standing: the lock consumed exactly
      // what was approved, which is what per-lock approving buys.
      expect(await backend.allowance(WETH, solver)).toBe(0n)
      expect(last).not.toBe('')
    },
    180_000,
  )

  itOnChain(
    'lockCalls recovers from a STALE allowance left by a reverted lock',
    async () => {
      // The retry path: a previous swap approved and then failed to lock, so a
      // non-zero allowance for a DIFFERENT amount is standing.
      //
      // WHAT THIS DOES NOT PROVE. The token here is WETH, which permits a
      // non-zero-to-non-zero approval — so this shows the three-call sequence
      // works, not that the zero step is necessary. The tokens it is necessary
      // for (USDT) would need their own runtime bytecode injected to
      // demonstrate, and the reason to sequence it this way is that the zero
      // step is free on tokens that do not need it and load-bearing on those
      // that do.
      const preimage = hex.decode('ee'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(rpc, SOLVER_KEY, AMOUNT)
      const stale = AMOUNT / 3n
      await sendFrom(rpc, SOLVER_KEY, WETH, abiCall('095ea7b3', SWAP_ADDRESS, word(stale)))
      expect(await backend.allowance(WETH, solver)).toBe(stale)

      const calls = backend.lockCalls(lock, stale)
      // Three: zero the stale one, approve the real amount, lock.
      expect(calls).toHaveLength(3)
      for (const call of calls) {
        expect((await sendFrom(rpc, SOLVER_KEY, call.to, call.data, call.value)).status).toBe('0x1')
      }
      expect(await backend.isLocked(lock)).toBe(true)
      expect(await backend.allowance(WETH, solver)).toBe(0n)
    },
    180_000,
  )
})
