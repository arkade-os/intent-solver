import { concatBytes } from '@noble/hashes/utils.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { addressWord, selectorFor, uintWord, type Erc20SwapLock } from './erc20Swap.js'
import { receiverArtifact } from './receiverArtifact.js'

export type IntentReceiverBinding = {
  chainId: bigint
  swapContract: Uint8Array
  activationCutoff: bigint
  activationCutoffTimestamp: bigint
  lock: Erc20SwapLock
}

const nonzeroAddress = (address: Uint8Array, label: string): Uint8Array => {
  const word = addressWord(address, label)
  if (address.every((byte) => byte === 0)) throw new Error(`${label} must not be zero`)
  return word
}
const fromArtifact = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))
const create2Address = (deployer: Uint8Array, initcode: Uint8Array): Uint8Array =>
  keccak_256(concatBytes(Uint8Array.of(0xff), deployer, new Uint8Array(32), keccak_256(initcode))).subarray(12)

/** The clone's immutable args: the ten binding words, in the order `IntentReceiver.Binding` declares them. */
export const encodeReceiverArgs = (binding: IntentReceiverBinding): Uint8Array => {
  const { lock } = binding
  if (binding.chainId <= 0n) throw new Error('chainId must be positive')
  if (lock.amount <= 0n) throw new Error('amount must be positive')
  if (binding.activationCutoff <= 0n || binding.activationCutoff >= lock.timelock)
    throw new Error('activationCutoff must be positive and precede timelock')
  if (binding.activationCutoffTimestamp <= 0n) throw new Error('activationCutoffTimestamp must be positive')
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
    uintWord(binding.activationCutoffTimestamp, 'activationCutoffTimestamp'),
  )
}

// Arachnid's keyless deterministic-deployment-proxy (not EIP-2470). This runtime, keccak256
// 0x2fa86add…7e4989, matches eth_getCode at that address on Ethereum, Arbitrum and Base.
export const RECEIVER_DEPLOYER = fromArtifact('4e59b44847b379578588920ca78fbf26c0b4956c')
export const RECEIVER_DEPLOYER_RUNTIME = fromArtifact(
  '7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3',
)
const FACTORY_CREATION = fromArtifact(receiverArtifact.factoryCreationBytecode)
export const receiverFactoryDeploymentCall = (): Uint8Array => concatBytes(new Uint8Array(32), FACTORY_CREATION)
export const RECEIVER_FACTORY = create2Address(RECEIVER_DEPLOYER, FACTORY_CREATION)
// The factory's constructor is its first CREATE, so the implementation sits at nonce 1.
export const RECEIVER_IMPLEMENTATION = keccak_256(
  concatBytes(Uint8Array.of(0xd6, 0x94), RECEIVER_FACTORY, Uint8Array.of(0x01)),
).subarray(12)

const cloneRuntime = (args: Uint8Array): Uint8Array =>
  concatBytes(
    fromArtifact('363d3d373d3d3d363d73'),
    RECEIVER_IMPLEMENTATION,
    fromArtifact('5af43d82803e903d91602b57fd5bf3'),
    args,
  )
const cloneInitcode = (args: Uint8Array): Uint8Array => {
  const length = args.length + 0x2d
  return concatBytes(
    Uint8Array.of(0x61, length >> 8, length & 0xff),
    fromArtifact('3d81600a3d39f3'),
    cloneRuntime(args),
  )
}

export const receiverAddress = (binding: IntentReceiverBinding): Uint8Array =>
  create2Address(RECEIVER_FACTORY, cloneInitcode(encodeReceiverArgs(binding)))
export const expectedReceiverRuntimeHash = (binding: IntentReceiverBinding): Uint8Array =>
  keccak_256(cloneRuntime(encodeReceiverArgs(binding)))

export type ImplementationImmutableReferences = Record<'self', readonly { start: number; length: number }[]>

export const implementationRuntimeHash = (
  runtimeTemplate: Uint8Array,
  references: ImplementationImmutableReferences,
  implementation: Uint8Array,
): Uint8Array => {
  if (!references.self?.length) throw new Error('missing immutable references: self')
  const runtime = Uint8Array.from(runtimeTemplate)
  for (const { start, length } of references.self) {
    if (!Number.isSafeInteger(start) || length !== 32 || start < 0 || start + length > runtime.length)
      throw new Error('invalid immutable reference: self')
    if (runtimeTemplate.subarray(start, start + length).some((byte) => byte !== 0))
      throw new Error('invalid immutable template: self')
    runtime.set(addressWord(implementation, 'implementation'), start)
  }
  return keccak_256(runtime)
}
export const expectedImplementationRuntimeHash = (): Uint8Array =>
  implementationRuntimeHash(
    fromArtifact(receiverArtifact.implementationRuntimeTemplate),
    receiverArtifact.implementationImmutableReferences,
    RECEIVER_IMPLEMENTATION,
  )

const factoryCall = (signature: string, binding: IntentReceiverBinding, ...tail: Uint8Array[]): Uint8Array => {
  const args = encodeReceiverArgs(binding)
  const head = uintWord(BigInt(32 * (1 + tail.length)), 'args offset')
  return concatBytes(selectorFor(signature), head, ...tail, uintWord(BigInt(args.length), 'args length'), args)
}
export const encodeFactoryDeploy = (binding: IntentReceiverBinding): Uint8Array => factoryCall('deploy(bytes)', binding)
export const encodeFactoryDeployAndActivate = (binding: IntentReceiverBinding): Uint8Array =>
  factoryCall('deployAndActivate(bytes)', binding)
export const encodeFactoryDeployAndRecover = (binding: IntentReceiverBinding, tokenAddress: Uint8Array): Uint8Array =>
  factoryCall('deployAndRecover(bytes,address)', binding, addressWord(tokenAddress, 'tokenAddress'))

export const encodeReceiverActivate = (): Uint8Array => selectorFor('activate()')
export const encodeReceiverRecover = (tokenAddress: Uint8Array): Uint8Array =>
  concatBytes(selectorFor('recover(address)'), addressWord(tokenAddress, 'tokenAddress'))

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
  options: {
    blockTag?: string | { blockHash: string; requireCanonical: boolean }
    allowActivated?: boolean
    allowClosed?: boolean
  } = {},
): Promise<void> => {
  nonzeroAddress(receiverAddress, 'receiverAddress')
  if (expectedRuntimeHash.length !== 32) throw new Error('expectedRuntimeHash must be bytes32')
  const expected = encodeReceiverArgs(binding)
  const chainId = BigInt((await rpc('eth_chainId', [])) as string)
  if (chainId !== binding.chainId) throw new Error('receiver chain mismatch')
  const blockTag = options.blockTag ?? ((await rpc('eth_blockNumber', [])) as string)
  const code = fromHex(await rpc('eth_getCode', [asHex(receiverAddress), blockTag]))
  if (code.length === 0 || !equal(keccak_256(code), expectedRuntimeHash)) throw new Error('receiver runtime mismatch')
  const implementation = fromHex(await rpc('eth_getCode', [asHex(RECEIVER_IMPLEMENTATION), blockTag]))
  if (!equal(keccak_256(implementation), expectedImplementationRuntimeHash()))
    throw new Error('receiver implementation mismatch')
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
    'activationCutoffTimestamp()',
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
  if (active.length !== 32 || active.subarray(0, 31).some((b) => b !== 0) || active[31]! > 1)
    throw new Error('invalid receiver activated state')
  if (!options.allowActivated && active[31] === 1) throw new Error('receiver already activated')
  if (!options.allowClosed) {
    if (typeof blockTag !== 'string') throw new Error('open-window check requires numeric block tag')
    if (BigInt(blockTag) >= binding.activationCutoff) throw new Error('receiver activation closed')
    const header = (await rpc('eth_getBlockByNumber', [blockTag, false])) as { timestamp: string } | null
    if (!header || BigInt(header.timestamp) >= binding.activationCutoffTimestamp)
      throw new Error('receiver timestamp activation closed')
  }
}
