import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import type { JsonRpc } from '@arkade-os/solver-core/ports/evm.js'
import { EvmPayoutFundingQuarantinedError } from '@arkade-os/solver-core/ports/evmPayoutFunding.js'
import {
  addressWord,
  selectorFor,
  swapKey,
  encodeRefundFor,
  encodeRefund,
  refundEventTopic,
  claimEventTopic,
} from './erc20Swap.js'
import {
  expectedReceiverRuntimeHash,
  receiverCreation,
  encodeReceiverActivate,
  encodeReceiverRecover,
  verifyReceiverBinding,
  type IntentReceiverBinding,
} from './receiver.js'
import type { DurableEvmSender } from './durableSender.js'
import { verifyEvmClaimEvidence } from './claimEvidence.js'

type Header = { number: string; hash: string; timestamp: string }
type Receipt = {
  status: string
  blockNumber: string
  blockHash: string
  contractAddress: string | null
  transactionHash: string
}
export class ReceiverFinalityPendingError extends Error {}
export class ReceiverInvariantError extends EvmPayoutFundingQuarantinedError {
  constructor(message: string) {
    super(message)
    this.name = 'ReceiverInvariantError'
  }
}
export interface ReceiverFinalityPolicy {
  confirmations: number
  minAgeSeconds: number
  requireFinalizedTag: boolean
  nowSeconds(): number
  maxClockSkewSeconds: number
}
export interface ReceiverReadPolicy {
  confirmations?: number
  minAgeSeconds?: number
  requireFinalizedTag?: boolean
}
export interface ReceiverInspection {
  receiverAddress: Uint8Array
  runtimeHash: Uint8Array
  binding: IntentReceiverBinding
  observedBlock: bigint
  currentBlock: bigint
  observedBlockHash: string
  currentBlockHash: string
  observedTimestamp: bigint
  currentTimestamp: bigint
  confirmations: number
  ageSeconds: number
  finalized: boolean
  activated: boolean
  tokenBalance: bigint
  swapTokenBalance: bigint
  htlcPresent: boolean
}
export interface ReceiverBackendDeps {
  rpc: JsonRpc
  chainId: bigint
  finality: ReceiverFinalityPolicy
  allowedSwapCodeHashes: readonly Uint8Array[]
  allowedTokenCodeHashes: readonly Uint8Array[]
  transactions: DurableEvmSender
  minClaimWindowBlocks: bigint
}
const hx = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`
const bytes = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(value)) throw new Error('invalid RPC bytes')
  return hexToBytes(value.slice(2))
}
const quantity = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('invalid RPC quantity')
  return BigInt(value)
}
const bool = (value: bigint): boolean => {
  if (value !== 0n && value !== 1n) throw new Error('invalid contract boolean')
  return value === 1n
}

export const createReceiverBackend = (deps: ReceiverBackendDeps) => {
  const { rpc, finality } = deps
  if (
    !Number.isSafeInteger(finality.confirmations) ||
    finality.confirmations < 1 ||
    !Number.isSafeInteger(finality.minAgeSeconds) ||
    finality.minAgeSeconds < 0 ||
    !Number.isSafeInteger(finality.maxClockSkewSeconds) ||
    finality.maxClockSkewSeconds < 0 ||
    deps.minClaimWindowBlocks <= 0n ||
    deps.allowedSwapCodeHashes.length === 0 ||
    deps.allowedTokenCodeHashes.length === 0 ||
    [...deps.allowedSwapCodeHashes, ...deps.allowedTokenCodeHashes].some((hash) => hash.length !== 32)
  )
    throw new Error('invalid receiver verification policy')
  const header = async (tag: string): Promise<Header> => {
    const raw = (await rpc('eth_getBlockByNumber', [tag, false])) as Header | null
    if (!raw || bytes(raw.hash).length !== 32) throw new Error('missing canonical EVM header')
    quantity(raw.number)
    quantity(raw.timestamp)
    if (tag.startsWith('0x') && quantity(raw.number) !== quantity(tag))
      throw new Error('RPC returned the wrong block height')
    return raw
  }
  const readPolicy = (policy: ReceiverReadPolicy = {}) => {
    const confirmations = Math.max(finality.confirmations, policy.confirmations ?? finality.confirmations)
    const minAgeSeconds = Math.max(finality.minAgeSeconds, policy.minAgeSeconds ?? finality.minAgeSeconds)
    if (
      !Number.isSafeInteger(confirmations) ||
      confirmations < 1 ||
      !Number.isSafeInteger(minAgeSeconds) ||
      minAgeSeconds < 0
    )
      throw new Error('invalid quoted finality policy')
    return {
      confirmations,
      minAgeSeconds,
      requireFinalizedTag: finality.requireFinalizedTag || policy.requireFinalizedTag === true,
    }
  }
  const view = async (policy: ReceiverReadPolicy = {}) => {
    const required = readPolicy(policy)
    if (quantity(await rpc('eth_chainId', [])) !== deps.chainId) throw new Error('receiver RPC chain mismatch')
    const current = await header('latest')
    const now = finality.nowSeconds()
    if (
      !Number.isSafeInteger(now) ||
      Math.abs(now - Number(quantity(current.timestamp))) > finality.maxClockSkewSeconds
    )
      throw new Error('EVM clock is stale or outside permitted skew')
    const tip = quantity(current.number)
    let target = tip - BigInt(required.confirmations - 1)
    if (target < 0n) throw new ReceiverFinalityPendingError('insufficient chain confirmations')
    if (required.requireFinalizedTag) {
      const finalized = await header('finalized')
      const height = quantity(finalized.number)
      if (height > tip) throw new Error('invalid finalized chain head')
      if (height < target) target = height
    }
    const minimumTimestamp = BigInt(now - required.minAgeSeconds)
    let low = 0n,
      high = target
    while (low < high) {
      const mid = (low + high + 1n) / 2n
      const candidate = await header(`0x${mid.toString(16)}`)
      if (quantity(candidate.timestamp) <= minimumTimestamp) low = mid
      else high = mid - 1n
    }
    target = low
    const observed = await header(`0x${target.toString(16)}`)
    const ageSeconds = now - Number(quantity(observed.timestamp))
    if (ageSeconds < required.minAgeSeconds)
      throw new ReceiverFinalityPendingError('chain lacks sufficiently old finalized view')
    const tag = { blockHash: observed.hash, requireCanonical: true }
    return { current, observed, tip, target, tag, ageSeconds }
  }
  const stable = async (observed: Header): Promise<void> => {
    if ((await header(observed.number)).hash.toLowerCase() !== observed.hash.toLowerCase())
      throw new Error('receiver observation was reorganized')
  }
  const read = async (address: Uint8Array, signature: string, words: Uint8Array[], tag: unknown): Promise<bigint> => {
    const result = bytes(
      await rpc('eth_call', [{ to: hx(address), data: hx(concatBytes(selectorFor(signature), ...words)) }, tag]),
    )
    if (result.length !== 32) throw new Error('contract response is not one ABI word')
    return BigInt(hx(result))
  }
  const allowed = async (address: Uint8Array, hashes: readonly Uint8Array[], tag: unknown): Promise<void> => {
    const code = bytes(await rpc('eth_getCode', [hx(address), tag]))
    if (code.length === 0 || !hashes.some((hash) => hx(hash) === hx(keccak_256(code))))
      throw new Error('contract code is not allowlisted')
  }
  const inspect = async (
    receiverAddress: Uint8Array,
    binding: IntentReceiverBinding,
    policy: ReceiverReadPolicy = {},
  ): Promise<ReceiverInspection> => {
    if (binding.chainId !== deps.chainId) throw new Error('receiver binding chain mismatch')
    if (binding.lock.timelock - binding.activationCutoff < deps.minClaimWindowBlocks)
      throw new Error('receiver destination claim window is too short')
    const { current, observed, tip, target, tag, ageSeconds } = await view(policy)
    const runtimeHash = expectedReceiverRuntimeHash(binding)
    await verifyReceiverBinding(rpc, receiverAddress, binding, runtimeHash, {
      blockTag: tag,
      allowActivated: true,
      allowClosed: true,
    })
    await allowed(binding.swapContract, deps.allowedSwapCodeHashes, tag)
    await allowed(binding.lock.tokenAddress, deps.allowedTokenCodeHashes, tag)
    const tokenBalance = await read(
      binding.lock.tokenAddress,
      'balanceOf(address)',
      [addressWord(receiverAddress, 'receiver')],
      tag,
    )
    const swapTokenBalance = await read(
      binding.lock.tokenAddress,
      'balanceOf(address)',
      [addressWord(binding.swapContract, 'swap')],
      tag,
    )
    const activated = bool(await read(receiverAddress, 'activated()', [], tag))
    const htlcPresent = bool(await read(binding.swapContract, 'swaps(bytes32)', [swapKey(binding.lock)], tag))
    const invalidExactLock = htlcPresent && (!activated || swapTokenBalance < binding.lock.amount)
    await stable(observed)
    await stable(current)
    if (invalidExactLock) throw new ReceiverInvariantError('exact lock lacks receiver activation or token backing')
    return {
      receiverAddress: Uint8Array.from(receiverAddress),
      runtimeHash,
      binding,
      observedBlock: target,
      currentBlock: tip,
      observedBlockHash: observed.hash,
      currentBlockHash: current.hash,
      observedTimestamp: quantity(observed.timestamp),
      currentTimestamp: quantity(current.timestamp),
      confirmations: Number(tip - target + 1n),
      ageSeconds,
      finalized: true,
      activated,
      tokenBalance,
      swapTokenBalance,
      htlcPresent,
    }
  }
  const canonicalReceipt = async (transactionHash: string, observedBlock: bigint): Promise<Receipt | null> => {
    const receipt = (await rpc('eth_getTransactionReceipt', [transactionHash])) as Receipt | null
    if (!receipt || quantity(receipt.blockNumber) > observedBlock) return null
    if (
      receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase() ||
      (await header(receipt.blockNumber)).hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    )
      throw new Error('noncanonical transaction receipt')
    if (quantity(receipt.status) !== 1n) throw new Error('receiver transaction reverted')
    return receipt
  }
  return {
    inspect,
    async deploymentAttempt(id: string, binding: IntentReceiverBinding) {
      const attempt = await deps.transactions.getPrepared(id, { to: null, data: receiverCreation(binding) })
      if (!attempt) return null
      if (attempt.createdAddress?.length !== 20) throw new Error('deployment journal has no derived address')
      return {
        address: attempt.createdAddress,
        transactionHash: attempt.hash,
        rawTransaction: attempt.rawTransaction,
        state: attempt.state,
      }
    },
    async deploy(id: string, binding: IntentReceiverBinding) {
      if (binding.chainId !== deps.chainId) throw new Error('receiver deployment chain mismatch')
      if (binding.lock.timelock - binding.activationCutoff < deps.minClaimWindowBlocks)
        throw new Error('receiver destination claim window is too short')
      const current = await header('latest')
      if (
        binding.activationCutoff <= quantity(current.number) ||
        binding.activationCutoffTimestamp <= quantity(current.timestamp) ||
        binding.activationCutoffTimestamp <= BigInt(finality.nowSeconds())
      )
        throw new Error('receiver deployment activation window closed')
      await allowed(binding.swapContract, deps.allowedSwapCodeHashes, current.number)
      await allowed(binding.lock.tokenAddress, deps.allowedTokenCodeHashes, current.number)
      const request = { to: null, data: receiverCreation(binding) }
      const prepared = await deps.transactions.prepare(id, request)
      if (prepared.createdAddress?.length !== 20) throw new Error('receiver deployment missing derived address')
      const attempt = await deps.transactions.submit(id, request)
      if (attempt.createdAddress?.length !== 20 || hx(attempt.createdAddress) !== hx(prepared.createdAddress))
        throw new Error('receiver deployment address changed between attempts')
      let observationView: Awaited<ReturnType<typeof view>>
      try {
        observationView = await view()
      } catch (error) {
        if (error instanceof ReceiverFinalityPendingError)
          return { address: attempt.createdAddress, transactionHash: attempt.hash, verified: false }
        throw error
      }
      const receipt = await canonicalReceipt(attempt.hash, observationView.target)
      if (!receipt) return { address: attempt.createdAddress, transactionHash: attempt.hash, verified: false }
      if (receipt.contractAddress?.toLowerCase() !== hx(attempt.createdAddress))
        throw new Error('deployment receipt address mismatch')
      const observation = await inspect(attempt.createdAddress, binding)
      if (observation.activated) throw new Error('receiver already activated before quote publication')
      return { address: attempt.createdAddress, transactionHash: attempt.hash, verified: true }
    },
    async activate(id: string, address: Uint8Array, binding: IntentReceiverBinding, policy: ReceiverReadPolicy = {}) {
      const observation = await inspect(address, binding, policy)
      if (
        !observation.activated &&
        (observation.currentBlock >= binding.activationCutoff ||
          observation.currentTimestamp >= binding.activationCutoffTimestamp ||
          BigInt(finality.nowSeconds()) >= binding.activationCutoffTimestamp ||
          observation.tokenBalance < binding.lock.amount)
      )
        throw new Error('receiver is not safely activatable')
      return deps.transactions.submit(id, { to: address, data: encodeReceiverActivate() })
    },
    async prepareActivation(
      id: string,
      address: Uint8Array,
      binding: IntentReceiverBinding,
      policy: ReceiverReadPolicy = {},
    ) {
      const observation = await inspect(address, binding, policy)
      if (
        observation.activated ||
        observation.currentBlock >= binding.activationCutoff ||
        observation.currentTimestamp >= binding.activationCutoffTimestamp ||
        BigInt(finality.nowSeconds()) >= binding.activationCutoffTimestamp ||
        observation.tokenBalance < binding.lock.amount
      )
        throw new Error('receiver is not safely activatable')
      return deps.transactions.prepare(id, { to: address, data: encodeReceiverActivate() })
    },
    broadcastRawTransaction: (raw: string) => deps.transactions.broadcastRawTransaction(raw),
    pendingTransactions: () => deps.transactions.pending(),
    async resolveExpiredActivation(
      id: string,
      address: Uint8Array,
      binding: IntentReceiverBinding,
      policy: ReceiverReadPolicy = {},
    ) {
      const observation = await inspect(address, binding, policy)
      if (
        observation.currentBlock < binding.activationCutoff &&
        observation.currentTimestamp < binding.activationCutoffTimestamp
      )
        throw new Error('original activation is not guaranteed expired on chain')
      const request = { to: address, data: encodeReceiverActivate() }
      if (!(await deps.transactions.getPrepared(id, request))) return null
      return deps.transactions.replay(id, request)
    },
    async recover(id: string, address: Uint8Array, binding: IntentReceiverBinding, token = binding.lock.tokenAddress) {
      await inspect(address, binding)
      return deps.transactions.submit(id, { to: address, data: encodeReceiverRecover(token) })
    },
    async refund(id: string, binding: IntentReceiverBinding) {
      if (binding.chainId !== deps.chainId) throw new Error('receiver binding chain mismatch')
      const observed = await view()
      if (observed.target < binding.lock.timelock) throw new Error('destination refund not mature')
      await allowed(binding.swapContract, deps.allowedSwapCodeHashes, observed.tag)
      return deps.transactions.submit(id, { to: binding.swapContract, data: encodeRefundFor(binding.lock) })
    },
    async claimEvidence(
      binding: IntentReceiverBinding,
      fromBlock: bigint,
      policy: ReceiverReadPolicy = {},
    ): Promise<Uint8Array | null> {
      if (binding.chainId !== deps.chainId) throw new Error('receiver binding chain mismatch')
      const observed = await view(policy)
      const required = readPolicy(policy)
      await allowed(binding.swapContract, deps.allowedSwapCodeHashes, observed.tag)
      const logs = await rpc('eth_getLogs', [
        {
          address: hx(binding.swapContract),
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: observed.observed.number,
          topics: [hx(claimEventTopic()), hx(binding.lock.preimageHash)],
        },
      ])
      if (!Array.isArray(logs)) throw new Error('invalid claim logs')
      for (const log of logs) {
        const number = (log as { blockNumber?: unknown }).blockNumber
        if (
          typeof number !== 'string' ||
          !/^0x[0-9a-f]+$/i.test(number) ||
          quantity(number) > observed.target ||
          quantity(number) < fromBlock
        )
          continue
        const result = await verifyEvmClaimEvidence(rpc, binding.swapContract, binding.lock, log, {
          minConfirmations: required.confirmations,
          minAgeSeconds: required.minAgeSeconds,
          nowSeconds: finality.nowSeconds(),
        })
        if (result) {
          await stable(observed.observed)
          return result
        }
      }
      return null
    },
    async refundEvidence(
      binding: IntentReceiverBinding,
      fromBlock: bigint,
      policy: ReceiverReadPolicy = {},
    ): Promise<boolean> {
      if (binding.chainId !== deps.chainId) throw new Error('receiver binding chain mismatch')
      const observed = await view(policy)
      await allowed(binding.swapContract, deps.allowedSwapCodeHashes, observed.tag)
      const logs = await rpc('eth_getLogs', [
        {
          address: hx(binding.swapContract),
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: observed.observed.number,
          topics: [hx(refundEventTopic()), hx(binding.lock.preimageHash)],
        },
      ])
      if (!Array.isArray(logs)) throw new Error('invalid refund logs')
      for (const entry of logs) {
        const log = entry as {
          address: string
          transactionHash: string
          blockHash: string
          topics: string[]
          removed?: boolean
        }
        if (
          log.removed ||
          log.address?.toLowerCase() !== hx(binding.swapContract) ||
          log.topics?.[0]?.toLowerCase() !== hx(refundEventTopic()) ||
          log.topics?.[1]?.toLowerCase() !== hx(binding.lock.preimageHash)
        )
          continue
        const receipt = await canonicalReceipt(log.transactionHash, observed.target)
        if (!receipt || receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase()) continue
        const tx = (await rpc('eth_getTransactionByHash', [log.transactionHash])) as {
          to: string
          from: string
          input: string
          hash: string
        } | null
        if (
          !tx ||
          tx.hash.toLowerCase() !== log.transactionHash.toLowerCase() ||
          tx.to?.toLowerCase() !== hx(binding.swapContract)
        )
          continue
        if (
          tx.input.toLowerCase() === hx(encodeRefundFor(binding.lock)) ||
          (tx.input.toLowerCase() === hx(encodeRefund(binding.lock)) &&
            tx.from.toLowerCase() === hx(binding.lock.refundAddress))
        ) {
          await stable(observed.observed)
          return true
        }
      }
      return false
    },
  }
}
