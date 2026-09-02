/**
 * A local EVM chain for the e2e suite, built from real bytecode and nothing else.
 *
 * THE PROBLEM. The corridor's counterparties are a deployed `ERC20Swap` and an
 * ERC-20. Neither can be compiled here, and a hand-written stand-in would test
 * our code against our own idea of the contract — precisely the thing worth
 * doubting.
 *
 * THE SOLUTION, and why it is NOT a fork. Both contracts' runtime bytecode is
 * captured from mainnet once, committed as a fixture, and injected with
 * `anvil_setCode` onto an empty chain. Everything under test then talks to
 * bytecode nobody here wrote, with no network dependency at all.
 *
 * A fork was the obvious approach and it was tried first. It is unstable for a
 * test suite: anvil pins a block at startup, and as mainnet advances that block
 * ages into "archive" territory, at which point public RPCs answer state
 * queries — including the account read behind `anvil_setCode` — with a 403. The
 * suite then fails for a reason that has nothing to do with the code. Forking
 * Arbitrum, where the swap contract actually lives, fails differently and
 * immediately: anvil cannot serve `eth_call` there at all ("Excess blob gas not
 * set", because those blocks lack fields it expects).
 *
 * WHY WETH9 IS THE TOKEN. It is a plain, non-proxy ERC-20 whose `deposit()` is
 * payable — so a test account mints its own balance from the ETH anvil already
 * gives it. No whale to impersonate, no storage slots to forge, no upstream.
 */

import { hex } from '@scure/base'
import {
  addressFromPrivateKey,
  signTransaction,
  type Eip1559Fields,
} from '@arkade-os/solver-rails-evm/evm/transaction.js'

/** Where the e2e chain listens. Overridable for a differently-mapped container. */
export const evmRpcUrl = (): string => process.env.EVM_E2E_RPC_URL ?? 'http://localhost:8545'

export type EvmRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

export const evmRpc =
  (url = evmRpcUrl()): EvmRpc =>
  async (method, params) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = (await res.json()) as { result?: unknown; error?: unknown }
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).slice(0, 200)}`)
    return json.result
  }

/**
 * Where WETH9 is injected. Its real mainnet address, purely so a reader
 * recognises it; nothing depends on the value.
 */
export const WETH = hex.decode('c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')

/**
 * Where the swap contract is injected.
 *
 * Deliberately an address nothing else occupies, so a test can never
 * accidentally exercise a real deployment.
 */
export const SWAP_ADDRESS = hex.decode('00000000000000000000000000000000deadbeef')

/**
 * anvil's deterministic accounts. Fine to hard-code: they are published, hold
 * only test funds, and a fresh chain regenerates them identically.
 */
export const SOLVER_KEY = hex.decode('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
export const CLIENT_KEY = hex.decode('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

const hexOf = (bytes: Uint8Array): string => `0x${hex.encode(bytes)}`

/** A 32-byte word from a bigint, for hand-built ERC-20 calldata. */
export const word = (value: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = value
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/** `selector(args...)` where every argument is one word. Enough for ERC-20. */
export const abiCall = (selector: string, ...args: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(4 + args.length * 32)
  out.set(hex.decode(selector), 0)
  args.forEach((arg, i) => out.set(arg, 4 + i * 32 + (32 - arg.length)))
  return out
}

/**
 * anvil returns `null` for a receipt until the block is mined. Poll rather than
 * assume — an unmined receipt reads as "no status", which is indistinguishable
 * from a reverted transaction if it is not waited for.
 */
export const waitForReceipt = async (rpc: EvmRpc, hash: string): Promise<{ status: string; blockNumber: string }> => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
      status: string
      blockNumber: string
    } | null
    if (receipt) return receipt
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no receipt for ${hash} after 6s`)
}

/**
 * Sign with an EXPLICIT nonce and broadcast WITHOUT waiting for a receipt.
 *
 * `sendFrom` awaits mining, which makes back-to-back calls sequential — fine
 * for most tests and useless for the one case that matters here: two
 * transactions in flight at once. This is the primitive that lets a test put
 * both in the mempool before either is mined.
 */
export const broadcastWithNonce = async (
  rpc: EvmRpc,
  key: Uint8Array,
  nonce: bigint,
  to: Uint8Array,
  data: Uint8Array,
  value = 0n,
): Promise<string> => {
  const tx: Eip1559Fields = {
    chainId: BigInt((await rpc('eth_chainId', [])) as string),
    nonce,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 5_000_000_000n,
    gas: 300_000n,
    to,
    value,
    data,
  }
  return (await rpc('eth_sendRawTransaction', [hexOf(signTransaction(tx, key).raw)])) as string
}

/**
 * Sign and broadcast with the service's OWN signer, then wait for the receipt.
 *
 * That is the point of these tests rather than a convenience: every transaction
 * here is built by `packages/solver-rails-evm/src/evm/transaction.ts`, so a chain that accepts them is
 * evidence the encoding is right, and one that rejects them is a failing test
 * rather than a production surprise.
 */
export const sendFrom = async (
  rpc: EvmRpc,
  key: Uint8Array,
  to: Uint8Array,
  data: Uint8Array,
  value = 0n,
): Promise<{ hash: string; status: string; blockNumber: bigint }> => {
  const from = addressFromPrivateKey(key)
  const tx: Eip1559Fields = {
    chainId: BigInt((await rpc('eth_chainId', [])) as string),
    nonce: BigInt((await rpc('eth_getTransactionCount', [hexOf(from), 'pending'])) as string),
    // Kept low deliberately: the prepay test funds a claimant with exactly the
    // gas money the contract forwarded, so an unrealistically high fee here
    // would make that test fail for a reason the corridor does not have.
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 5_000_000_000n,
    gas: 300_000n,
    to,
    value,
    data,
  }
  const signed = signTransaction(tx, key)
  const hash = (await rpc('eth_sendRawTransaction', [hexOf(signed.raw)])) as string
  const receipt = await waitForReceipt(rpc, hash)
  return { hash, status: receipt.status, blockNumber: BigInt(receipt.blockNumber) }
}

export const balanceOf = async (rpc: EvmRpc, token: Uint8Array, who: Uint8Array): Promise<bigint> =>
  BigInt((await rpc('eth_call', [{ to: hexOf(token), data: hexOf(abiCall('70a08231', who)) }, 'latest'])) as string)

/** Give an account ETH. Used to restore state a test deliberately drained. */
export const setEth = async (rpc: EvmRpc, who: Uint8Array, wei: bigint): Promise<void> => {
  await rpc('anvil_setBalance', [hexOf(who), `0x${wei.toString(16)}`])
}

/** `deposit()` — WETH9's payable mint. */
const DEPOSIT_SELECTOR = hex.decode('d0e30db0')

/**
 * Give an account `amount` of WETH by depositing its own ETH.
 *
 * The reason this file no longer forks: a token whose balance can be minted
 * from ETH needs no whale, no impersonation and no upstream node.
 */
export const fundWithWeth = async (rpc: EvmRpc, key: Uint8Array, amount: bigint): Promise<void> => {
  const receipt = await sendFrom(rpc, key, WETH, DEPOSIT_SELECTOR, amount)
  if (receipt.status !== '0x1') throw new Error('WETH deposit reverted')
}

/**
 * Put the real `ERC20Swap` runtime bytecode at {@link SWAP_ADDRESS}.
 *
 * The bytecode is captured from the live Arbitrum deployment and committed as a
 * fixture, so the suite needs no archive access and cannot silently drift onto
 * a different contract. Re-capture with:
 *
 *   eth_getCode 0x6398B76DF91C5eBe9f488e3656658E79284dDc0F
 */
export const installContracts = async (rpc: EvmRpc, swapRuntime: string, wethRuntime: string): Promise<void> => {
  await rpc('anvil_setCode', [hexOf(SWAP_ADDRESS), swapRuntime.trim()])
  await rpc('anvil_setCode', [hexOf(WETH), wethRuntime.trim()])
  for (const [label, address] of [
    ['ERC20Swap', SWAP_ADDRESS],
    ['WETH9', WETH],
  ] as const) {
    const installed = (await rpc('eth_getCode', [hexOf(address), 'latest'])) as string
    if (installed.length < 100) throw new Error(`${label} bytecode did not install`)
  }
}

/** Whether the local EVM chain is up, for the stack precondition. */
export const evmChainReady = async (): Promise<boolean> => {
  try {
    await evmRpc()('eth_chainId', [])
    return true
  } catch {
    return false
  }
}
