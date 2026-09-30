import { concatBytes } from '@noble/hashes/utils.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { addressWord, selectorFor, swapKey, uintWord, type Erc20SwapLock } from './erc20Swap.js'

export type IntentReceiverBinding = {
  chainId: bigint
  swapContract: Uint8Array
  activationCutoff: bigint
  lock: Erc20SwapLock
}

const nonzeroAddress = (address: Uint8Array, label: string): Uint8Array => {
  const word = addressWord(address, label)
  if (address.every((byte) => byte === 0)) throw new Error(`${label} must not be zero`)
  return word
}

export const encodeReceiverConstructor = (binding: IntentReceiverBinding): Uint8Array => {
  const { lock } = binding
  if (binding.chainId <= 0n) throw new Error('chainId must be positive')
  if (lock.amount <= 0n) throw new Error('amount must be positive')
  if (binding.activationCutoff <= 0n || binding.activationCutoff >= lock.timelock)
    throw new Error('activationCutoff must be positive and precede timelock')
  if (lock.preimageHash.length !== 32 || lock.preimageHash.every((byte) => byte === 0))
    throw new Error('preimageHash must be a nonzero bytes32')
  if (
    lock.claimAddress.length === lock.refundAddress.length &&
    lock.claimAddress.every((b, i) => b === lock.refundAddress[i])
  )
    throw new Error('claimAddress and refundAddress must differ')
  return concatBytes(
    uintWord(binding.chainId, 'chainId'),
    nonzeroAddress(binding.swapContract, 'swapContract'),
    nonzeroAddress(lock.tokenAddress, 'tokenAddress'),
    uintWord(lock.amount, 'amount'),
    lock.preimageHash,
    nonzeroAddress(lock.claimAddress, 'claimAddress'),
    nonzeroAddress(lock.refundAddress, 'refundAddress'),
    uintWord(binding.activationCutoff, 'activationCutoff'),
    uintWord(lock.timelock, 'timelock'),
  )
}

export const encodeReceiverDeployment = (creationBytecode: Uint8Array, binding: IntentReceiverBinding): Uint8Array => {
  if (creationBytecode.length === 0) throw new Error('creationBytecode must not be empty')
  return concatBytes(creationBytecode, encodeReceiverConstructor(binding))
}

export const encodeReceiverActivate = (): Uint8Array => selectorFor('activate()')
export const encodeReceiverRecover = (tokenAddress: Uint8Array): Uint8Array =>
  concatBytes(selectorFor('recover(address)'), nonzeroAddress(tokenAddress, 'tokenAddress'))

export type ReceiverImmutableName =
  | 'chainId'
  | 'swapContract'
  | 'token'
  | 'amount'
  | 'preimageHash'
  | 'claimAddress'
  | 'refundAddress'
  | 'activationCutoff'
  | 'timelock'
  | 'swapKey'
export type ReceiverImmutableReferences = Record<ReceiverImmutableName, readonly { start: number; length: number }[]>

export const receiverRuntimeHash = (
  runtimeTemplate: Uint8Array,
  references: ReceiverImmutableReferences,
  binding: IntentReceiverBinding,
): Uint8Array => {
  const words = encodeReceiverConstructor(binding)
  const names: ReceiverImmutableName[] = [
    'chainId',
    'swapContract',
    'token',
    'amount',
    'preimageHash',
    'claimAddress',
    'refundAddress',
    'activationCutoff',
    'timelock',
  ]
  const values = Object.fromEntries(names.map((name, i) => [name, words.subarray(i * 32, (i + 1) * 32)])) as Record<
    ReceiverImmutableName,
    Uint8Array
  >
  values.swapKey = swapKey(binding.lock)
  const runtime = Uint8Array.from(runtimeTemplate)
  const occupied = new Set<number>()
  for (const name of [...names, 'swapKey'] as ReceiverImmutableName[]) {
    if (!references[name]?.length) throw new Error(`missing immutable references: ${name}`)
    for (const { start, length } of references[name]) {
      if (!Number.isSafeInteger(start) || length !== 32 || start < 0 || start + length > runtime.length)
        throw new Error(`invalid immutable reference: ${name}`)
      for (let i = start; i < start + length; i++) {
        if (occupied.has(i) || runtimeTemplate[i] !== 0) throw new Error(`invalid immutable template: ${name}`)
        occupied.add(i)
      }
      runtime.set(values[name], start)
    }
  }
  return keccak_256(runtime)
}

type ReceiverRpc = (method: string, params: readonly unknown[]) => Promise<unknown>
const asHex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`
const fromHex = (value: unknown): Uint8Array => {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('invalid RPC hex')
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'))
}
const equal = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, i) => byte === right[i])

// The expected runtime hash must come from a trusted build with bound immutables, never this receiver's RPC response.
export const verifyReceiverBinding = async (
  rpc: ReceiverRpc,
  receiverAddress: Uint8Array,
  binding: IntentReceiverBinding,
  expectedRuntimeHash: Uint8Array,
): Promise<void> => {
  nonzeroAddress(receiverAddress, 'receiverAddress')
  if (expectedRuntimeHash.length !== 32) throw new Error('expectedRuntimeHash must be bytes32')
  const expected = encodeReceiverConstructor(binding)
  const chainId = BigInt((await rpc('eth_chainId', [])) as string)
  if (chainId !== binding.chainId) throw new Error('receiver chain mismatch')
  const blockTag = (await rpc('eth_blockNumber', [])) as string
  const code = fromHex(await rpc('eth_getCode', [asHex(receiverAddress), blockTag]))
  if (code.length === 0 || !equal(keccak_256(code), expectedRuntimeHash)) throw new Error('receiver runtime mismatch')
  const getters = [
    'chainId()',
    'swapContract()',
    'token()',
    'amount()',
    'preimageHash()',
    'claimAddress()',
    'refundAddress()',
    'activationCutoff()',
    'timelock()',
  ]
  for (let i = 0; i < getters.length; i++) {
    const value = fromHex(
      await rpc('eth_call', [{ to: asHex(receiverAddress), data: asHex(selectorFor(getters[i]!)) }, blockTag]),
    )
    if (!equal(value, expected.subarray(i * 32, (i + 1) * 32)))
      throw new Error(`receiver binding mismatch: ${getters[i]}`)
  }
  const active = fromHex(
    await rpc('eth_call', [{ to: asHex(receiverAddress), data: asHex(selectorFor('activated()')) }, blockTag]),
  )
  if (active.length !== 32 || active.some((b) => b !== 0)) throw new Error('receiver already activated')
  if (BigInt(blockTag) >= binding.activationCutoff) throw new Error('receiver activation closed')
}
