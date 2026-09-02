/**
 * E2E - the transport and the broadcaster, against a real node.
 *
 * `evmErc20Swap.e2e.test.ts` proves the CONTRACT binding: calldata the EVM
 * accepts, an event layout our reader agrees with. It reaches the chain through
 * the harness's own `rpc` helper and its own signing path, so two modules the
 * running corridor depends on are never exercised there:
 *
 *   - `src/evm/rpc.ts`       - the only place in `src/evm/` that talks to a network
 *   - `src/evm/broadcast.ts` - prices an EIP-1559 transaction, takes a nonce, signs
 *
 * Both are unit-tested against scripted responses, which proves they handle the
 * answers we imagined. It cannot prove a node accepts what they PRODUCE. A fee
 * one wei under what the chain wants, a nonce read at the wrong block tag, an
 * RLP field out of order, a `yParity` encoded the pre-1559 way - each of those
 * passes every unit test in this repo and is refused by the first real node it
 * meets. Nothing between `createJsonRpc` and the contract's own storage is a
 * stand-in here.
 *
 * PREREQUISITE, and it is not part of the arkade stack: an anvil container,
 * started and (when you are done) removed by
 *
 *   node scripts/e2e-stack.mjs        # anvil + the flat regtest feed, foreground
 *   node scripts/e2e-stack.mjs down   # remove the container again
 *
 * Skipped rather than failed when absent, for the reason the sibling file gives:
 * this corridor is not in the default local stack, and someone working on
 * Lightning should not have to run an EVM node.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { createJsonRpc } from '@arkade-os/solver-rails-evm/evm/rpc.js'
import { createEvmBroadcaster, nonceSourceFor } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createEvmHtlcBackend, type EvmCall, type EvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { encodeLock, type Erc20SwapLock } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import {
  CLIENT_KEY,
  SOLVER_KEY,
  SWAP_ADDRESS,
  WETH,
  abiCall,
  evmChainReady,
  evmRpc,
  evmRpcUrl,
  fundWithWeth,
  installContracts,
  waitForReceipt,
  word,
} from './support/evmChain.js'

const SWAP_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/erc20swap.runtime.hex', import.meta.url)), 'utf8')
const WETH_RUNTIME = readFileSync(fileURLToPath(new URL('fixtures/weth9.runtime.hex', import.meta.url)), 'utf8')

const solver = addressFromPrivateKey(SOLVER_KEY)
const client = addressFromPrivateKey(CLIENT_KEY)
const AMOUNT = 5_000_000_000_000_000n // 0.005 WETH

/** The knobs `EvmChainConfig` carries, at values a deployment would set. */
const GAS_LIMIT = 300_000n
const CEILING = 500n * 10n ** 9n // 500 gwei
const HEADROOM_SECONDS = 3600
const FASTEST_SECONDS_PER_BLOCK = 1

let rpc: ReturnType<typeof createJsonRpc>
let backend: EvmHtlcBackend
let chainId: number
let available = false

const broadcasterFor = (
  key: Uint8Array,
  over: { maxFeeCeilingPerGas?: bigint; onCappedByPolicy?: (call: EvmCall) => void } = {},
) =>
  createEvmBroadcaster({
    rpc,
    privateKey: key,
    chainId,
    nonces: nonceSourceFor(rpc),
    gasLimit: GAS_LIMIT,
    maxFeeCeilingPerGas: over.maxFeeCeilingPerGas ?? CEILING,
    headroomSeconds: HEADROOM_SECONDS,
    fastestSecondsPerBlock: FASTEST_SECONDS_PER_BLOCK,
    ...(over.onCappedByPolicy ? { onCappedByPolicy: over.onCappedByPolicy } : {}),
  })

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
  // THE TRANSPORT UNDER TEST, used for every read and write below rather than
  // the harness's helper - so the whole file is one more exercise of it.
  rpc = createJsonRpc({ url: evmRpcUrl() })
  chainId = Number(BigInt((await rpc('eth_chainId', [])) as string))
  backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
  await installContracts(evmRpc(), SWAP_RUNTIME, WETH_RUNTIME)
}, 120_000)

const itOnChain: typeof it = ((name: string, fn: any, timeout?: number) =>
  it(
    name,
    async (ctx: any) => {
      if (!available) return ctx.skip()
      await fn(ctx)
    },
    timeout,
  )) as never

describe('the JSON-RPC transport against a real node', () => {
  itOnChain('reads the chain tip', async () => {
    // Proves the envelope, the headers and the result unwrapping match what a
    // node actually answers - not merely what the unit tests scripted.
    const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
    expect(tip).toBeGreaterThanOrEqual(0n)
  })

  itOnChain('surfaces a JSON-RPC error rather than resolving it away', async () => {
    // The refusal that matters most: swallowed, this reaches the backend as
    // "the lock is not funded", which reads as an ordinary chain state.
    await expect(rpc('eth_getBlockByNumber', ['not-a-block', false])).rejects.toThrow()
  })

  itOnChain('answers null for an unknown block rather than throwing', async () => {
    // The other half of that rule: `result: null` is legitimate and must pass
    // through. Only the ABSENCE of the member is refused.
    expect(await rpc('eth_getBlockByNumber', ['0xfffffff', false])).toBeNull()
  })
})

describe('the broadcaster against a real node', () => {
  itOnChain(
    'produces a transaction the node accepts and mines',
    async () => {
      // The claim no unit test can make. If the fee is under what the chain
      // wants, the nonce is stale, the RLP is misordered, or the signature
      // recovers to another account, this is where it shows.
      const broadcast = broadcasterFor(SOLVER_KEY)
      const hash = await broadcast({ to: WETH, data: abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)) })
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
      expect((await waitForReceipt(evmRpc(), hash)).status).toBe('0x1')
    },
    120_000,
  )

  itOnChain(
    'advances the nonce across consecutive sends, so neither is dropped',
    async () => {
      // Two transactions from one key in one pass is the ordinary case here -
      // approve, then lock. A nonce source answering the same number twice has
      // the node silently drop one, and the swap simply never settles.
      const broadcast = broadcasterFor(SOLVER_KEY)
      const first = await broadcast({ to: WETH, data: abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)) })
      const second = await broadcast({ to: WETH, data: abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT + 1n)) })
      expect(first).not.toBe(second)
      expect((await waitForReceipt(evmRpc(), first)).status).toBe('0x1')
      expect((await waitForReceipt(evmRpc(), second)).status).toBe('0x1')
    },
    120_000,
  )

  itOnChain(
    'funds a real lock end to end, config values through to contract storage',
    async () => {
      // The whole path the corridor runs: our transport, our fee pricing, our
      // nonce, our signer, our calldata - and then the CONTRACT's own `swaps`
      // mapping asked whether the lock exists.
      const preimage = hex.decode('22'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(evmRpc(), SOLVER_KEY, AMOUNT)
      const broadcast = broadcasterFor(SOLVER_KEY)
      const approved = await broadcast({ to: WETH, data: abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)) })
      expect((await waitForReceipt(evmRpc(), approved)).status).toBe('0x1')

      expect(await backend.isLocked(lock)).toBe(false)
      const locked = await broadcast({ to: SWAP_ADDRESS, data: encodeLock(lock) })
      expect((await waitForReceipt(evmRpc(), locked)).status).toBe('0x1')
      expect(await backend.isLocked(lock)).toBe(true)
    },
    120_000,
  )

  itOnChain(
    'drives the backend calldata the orchestrator hands it, not a hand-built one',
    async () => {
      // `lockCall` is what the orchestrator passes the broadcaster. Pinning the
      // two together here catches a change to either side on chain, rather than
      // at the first live swap.
      const preimage = hex.decode('33'.repeat(32))
      const tip = BigInt((await rpc('eth_blockNumber', [])) as string)
      const lock = lockFor(preimage, tip + 5_000n)

      await fundWithWeth(evmRpc(), SOLVER_KEY, AMOUNT)
      const broadcast = broadcasterFor(SOLVER_KEY)
      const approved = await broadcast({ to: WETH, data: abiCall('095ea7b3', SWAP_ADDRESS, word(AMOUNT)) })
      expect((await waitForReceipt(evmRpc(), approved)).status).toBe('0x1')

      const locked = await broadcast(backend.lockCall(lock))
      expect((await waitForReceipt(evmRpc(), locked)).status).toBe('0x1')
      expect(await backend.isLocked(lock)).toBe(true)
    },
    120_000,
  )
})
