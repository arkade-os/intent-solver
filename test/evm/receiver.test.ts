import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  addressWord,
  encodeClaim,
  encodeLock,
  encodeRefund,
  selectorFor,
  swapKey,
  uintWord,
} from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import {
  encodeReceiverActivate,
  encodeReceiverConstructor,
  encodeReceiverDeployment,
  encodeReceiverRecover,
  receiverRuntimeHash,
  verifyReceiverBinding,
  type IntentReceiverBinding,
  type ReceiverImmutableReferences,
} from '@arkade-os/solver-rails-evm/evm/receiver.js'
import { concatBytes } from '@noble/hashes/utils.js'

type Artifact = {
  evm: {
    bytecode: { object: string }
    deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> }
  }
}
type AstNode = { id: number; name?: string; mutability?: string; nodes?: AstNode[] }
type CompileResult = {
  contracts: Record<string, Record<string, Artifact>>
  sources: Record<string, { ast: AstNode }>
  errors?: { severity: string; formattedMessage: string }[]
}
const solc = createRequire(import.meta.url)('solc') as { compile: (input: string) => string }
let anvil: ChildProcess
let rpcUrl: string
const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
  const result = (await (
    await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  ).json()) as { error?: unknown; result?: unknown }
  if (result.error) throw new Error(JSON.stringify(result.error))
  return result.result
}
const hx = (value: Uint8Array): string => `0x${hex.encode(value)}`
const bytes = (value: string): Uint8Array => hex.decode(value.slice(2))
const WETH = bytes('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')
const SWAP = bytes('0x00000000000000000000000000000000deadbeef')
const AMOUNT = 1_000n
const PREIMAGE = hex.decode('11'.repeat(32))
let accounts: Uint8Array[]
let artifacts: CompileResult['contracts']
let immutableReferences: ReceiverImmutableReferences
let snapshot: string

const call = async (address: Uint8Array, signature: string, ...words: Uint8Array[]): Promise<bigint> =>
  BigInt(
    (await rpc('eth_call', [
      { to: hx(address), data: hx(concatBytes(selectorFor(signature), ...words)) },
      'latest',
    ])) as string,
  )
const block = async (): Promise<bigint> => BigInt((await rpc('eth_blockNumber', [])) as string)
const send = async (from: Uint8Array, to: Uint8Array | null, data: Uint8Array, value = 0n) => {
  const hash = await rpc('eth_sendTransaction', [
    {
      from: hx(from),
      ...(to ? { to: hx(to) } : {}),
      data: hx(data),
      gas: '0x600000',
      value: `0x${value.toString(16)}`,
    },
  ])
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
      status: string
      contractAddress: string | null
    } | null
    if (receipt) return receipt
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('local transaction receipt missing')
}
const deployArtifact = async (file: string, name: string): Promise<Uint8Array> => {
  const receipt = await send(accounts[0]!, null, hex.decode(artifacts[file]![name]!.evm.bytecode.object))
  expect(receipt.status).toBe('0x1')
  return bytes(receipt.contractAddress!)
}
const binding = async (token = WETH): Promise<IntentReceiverBinding> => {
  const tip = await block()
  return {
    chainId: 31337n,
    swapContract: SWAP,
    activationCutoff: tip + 50n,
    lock: {
      amount: AMOUNT,
      preimageHash: sha256(PREIMAGE),
      tokenAddress: token,
      claimAddress: accounts[1]!,
      refundAddress: accounts[0]!,
      timelock: tip + 100n,
    },
  }
}
const deployReceiver = async (terms: IntentReceiverBinding): Promise<Uint8Array> => {
  const receipt = await send(
    accounts[0]!,
    null,
    encodeReceiverDeployment(
      hex.decode(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.bytecode.object),
      terms,
    ),
  )
  expect(receipt.status).toBe('0x1')
  return bytes(receipt.contractAddress!)
}
const tokenBalance = (token: Uint8Array, who: Uint8Array) => call(token, 'balanceOf(address)', addressWord(who, 'who'))
const transfer = async (receiver: Uint8Array, amount: bigint) => {
  expect((await send(accounts[0]!, WETH, selectorFor('deposit()'), amount)).status).toBe('0x1')
  expect(
    (
      await send(
        accounts[0]!,
        WETH,
        concatBytes(
          selectorFor('transfer(address,uint256)'),
          addressWord(receiver, 'receiver'),
          uintWord(amount, 'amount'),
        ),
      )
    ).status,
  ).toBe('0x1')
}
const activate = (receiver: Uint8Array) => send(accounts[2]!, receiver, encodeReceiverActivate())
const recover = (receiver: Uint8Array, token = WETH) => send(accounts[2]!, receiver, encodeReceiverRecover(token))
const mineTo = async (target: bigint) => {
  while ((await block()) < target) await rpc('evm_mine', [])
}
const locked = (terms: IntentReceiverBinding) => call(SWAP, 'swaps(bytes32)', swapKey(terms.lock))
const allowance = (token: Uint8Array, receiver: Uint8Array) =>
  call(token, 'allowance(address,address)', addressWord(receiver, 'receiver'), addressWord(SWAP, 'swap'))
const mint = (token: Uint8Array, receiver: Uint8Array, amount = AMOUNT) =>
  send(
    accounts[0]!,
    token,
    concatBytes(selectorFor('mint(address,uint256)'), addressWord(receiver, 'receiver'), uintWord(amount, 'amount')),
  )
const mode = (token: Uint8Array, value: bigint) =>
  send(accounts[0]!, token, concatBytes(selectorFor('setMode(uint256)'), uintWord(value, 'mode')))

beforeAll(async () => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())))
  rpcUrl = `http://127.0.0.1:${port}`
  anvil = spawn(
    new URL('../../node_modules/.bin/anvil', import.meta.url).pathname,
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--hardfork', 'cancun', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let startupError = ''
  anvil.stderr?.on('data', (chunk: Buffer) => {
    startupError += chunk.toString()
  })
  anvil.on('error', (error) => {
    startupError += error.message
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await rpc('eth_chainId', [])
      ready = true
      break
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  if (!ready) throw new Error(`Anvil failed to start: ${startupError}`)
  const result = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: {
          'IntentReceiver.sol': {
            content: readFileSync(
              new URL('../../packages/solver-rails-evm/contracts/IntentReceiver.sol', import.meta.url),
              'utf8',
            ),
          },
          'ReceiverTokens.sol': {
            content: readFileSync(new URL('fixtures/ReceiverTokens.sol', import.meta.url), 'utf8'),
          },
        },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: 'shanghai',
          outputSelection: {
            '*': {
              '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
              '': ['ast'],
            },
          },
        },
      }),
    ),
  ) as CompileResult
  expect(result.errors?.filter((e) => e.severity === 'error') ?? []).toEqual([])
  artifacts = result.contracts
  const immutableIds: Record<string, string> = {}
  const walk = (node: AstNode): void => {
    if (node.mutability === 'immutable' && node.name) immutableIds[node.id] = node.name
    for (const child of node.nodes ?? []) walk(child)
  }
  walk(result.sources['IntentReceiver.sol']!.ast)
  immutableReferences = Object.fromEntries(
    Object.entries(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.deployedBytecode.immutableReferences).map(
      ([id, refs]) => [immutableIds[id], refs],
    ),
  ) as ReceiverImmutableReferences
  accounts = ((await rpc('eth_accounts', [])) as string[]).map(bytes)
  for (const [address, fixture] of [
    [SWAP, 'erc20swap.runtime.hex'],
    [WETH, 'weth9.runtime.hex'],
  ] as const) {
    await rpc('anvil_setCode', [
      hx(address),
      readFileSync(new URL(`../e2e/fixtures/${fixture}`, import.meta.url), 'utf8').trim(),
    ])
  }
  snapshot = (await rpc('evm_snapshot', [])) as string
}, 60_000)

beforeEach(async () => {
  expect(await rpc('evm_revert', [snapshot])).toBe(true)
  snapshot = (await rpc('evm_snapshot', [])) as string
})
afterAll(async () => {
  if (anvil && anvil.exitCode === null && !anvil.killed) {
    await new Promise<void>((resolve) => {
      anvil.once('exit', () => resolve())
      anvil.kill()
    })
  }
})

describe('experimental provider-funded receiver against real ERC20Swap runtime', () => {
  it('holds partial funding, permits topups, activates exactly once, and pays the immutable claimant', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT - 1n)
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await recover(receiver)).status).toBe('0x0')
    expect(await locked(terms)).toBe(0n)
    await transfer(receiver, 1n)
    expect((await activate(receiver)).status).toBe('0x1')
    expect(await locked(terms)).toBe(1n)
    expect(await allowance(WETH, receiver)).toBe(0n)
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await send(accounts[2]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x0')
    expect((await send(accounts[1]!, SWAP, encodeClaim(hex.decode('22'.repeat(32)), terms.lock))).status).toBe('0x0')
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x0')
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[1]!)).toBe(AMOUNT)
    expect(await locked(terms)).toBe(0n)
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x0')
  })

  it('protects the required amount and sends excess/duplicates to the fixed refund address', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT + 20n)
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await tokenBalance(WETH, receiver)).toBe(AMOUNT)
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(20n)
    expect(await tokenBalance(WETH, accounts[2]!)).toBe(0n)
    expect((await activate(receiver)).status).toBe('0x1')
    await transfer(receiver, AMOUNT)
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT + 20n)
    expect(await locked(terms)).toBe(1n)
    expect((await activate(receiver)).status).toBe('0x0')
  })

  it('rejects activation at the exact cutoff and recovers late funds without creating a lock', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    await mineTo(terms.activationCutoff - 1n)
    expect((await activate(receiver)).status).toBe('0x0')
    expect(await block()).toBe(terms.activationCutoff)
    expect((await recover(receiver)).status).toBe('0x1')
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await locked(terms)).toBe(0n)
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT * 2n)
  })

  it('refunds a matured destination lock to solver and cannot claim after refund', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x1')
    await mineTo(terms.lock.timelock)
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
    expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x0')
  })

  it('shows the actual destination claim branch remains valid after timelock until refund wins', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x1')
    await mineTo(terms.lock.timelock + 1n)
    expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x1')
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x0')
  })

  it('rejects wrong asset funding while allowing its recovery', async () => {
    const wrong = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await mint(wrong, receiver)
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await recover(receiver, wrong)).status).toBe('0x1')
    expect(await tokenBalance(wrong, accounts[0]!)).toBe(AMOUNT)
    expect(await locked(terms)).toBe(0n)
  })

  it('recovers a short unactivated deposit after cutoff', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT - 1n)
    expect((await recover(receiver)).status).toBe('0x0')
    await mineTo(terms.activationCutoff)
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT - 1n)
    expect(await tokenBalance(WETH, receiver)).toBe(0n)
    expect(await locked(terms)).toBe(0n)
  })

  it('does not report recovery when transfer fails or falsely returns success', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver, AMOUNT + 1n)
    for (const failure of [4n, 5n]) {
      await mode(token, failure)
      expect((await recover(receiver, token)).status).toBe('0x0')
      expect(await tokenBalance(token, receiver)).toBe(AMOUNT + 1n)
      expect(await tokenBalance(token, accounts[0]!)).toBe(0n)
    }
    await mode(token, 0n)
    expect((await recover(receiver, token)).status).toBe('0x1')
    expect(await tokenBalance(token, receiver)).toBe(AMOUNT)
  })

  it('refuses to overwrite an already funded destination lock', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    expect((await send(accounts[0]!, WETH, selectorFor('deposit()'), AMOUNT)).status).toBe('0x1')
    expect(
      (
        await send(
          accounts[0]!,
          WETH,
          concatBytes(selectorFor('approve(address,uint256)'), addressWord(SWAP, 'swap'), uintWord(AMOUNT, 'amount')),
        )
      ).status,
    ).toBe('0x1')
    expect((await send(accounts[0]!, SWAP, encodeLock(terms.lock))).status).toBe('0x1')
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x0')
    expect(await tokenBalance(WETH, receiver)).toBe(AMOUNT)
    expect(await call(receiver, 'activated()')).toBe(0n)
    expect(await locked(terms)).toBe(1n)
  })

  it('atomically rolls back approval failure and permits retry after token recovery', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver)
    await mode(token, 1n)
    expect((await activate(receiver)).status).toBe('0x0')
    expect(await call(receiver, 'activated()')).toBe(0n)
    expect(await locked(terms)).toBe(0n)
    expect(await tokenBalance(token, receiver)).toBe(AMOUNT)
    await mode(token, 0n)
    expect((await activate(receiver)).status).toBe('0x1')
    expect(await allowance(token, receiver)).toBe(0n)
  })

  it('blocks token callback recovery during activation', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver, AMOUNT * 2n)
    await mode(token, 2n)
    expect((await activate(receiver)).status).toBe('0x1')
    expect(await call(token, 'reentryBlocked()')).toBe(1n)
    expect(await tokenBalance(token, receiver)).toBe(AMOUNT)
    expect(await tokenBalance(token, SWAP)).toBe(AMOUNT)
    expect(await tokenBalance(token, accounts[0]!)).toBe(0n)
  })

  it('rejects fee-on-transfer tokens and rolls back the swap flag and allowance', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver)
    await mode(token, 3n)
    expect((await activate(receiver)).status).toBe('0x0')
    expect(await locked(terms)).toBe(0n)
    expect(await call(receiver, 'activated()')).toBe(0n)
    expect(await tokenBalance(token, receiver)).toBe(AMOUNT)
    expect(await tokenBalance(token, SWAP)).toBe(0n)
    expect(await allowance(token, receiver)).toBe(0n)
  })

  it('supports tokens returning no approval/transfer result against the real swap', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverNoReturnToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver, AMOUNT + 1n)
    expect((await activate(receiver)).status).toBe('0x1')
    expect((await recover(receiver, token)).status).toBe('0x1')
    expect(await tokenBalance(token, SWAP)).toBe(AMOUNT)
    expect(await tokenBalance(token, accounts[0]!)).toBe(1n)
  })

  it('checks chain, exact runtime, immutable binding, state, and activation window', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    const codeHash = receiverRuntimeHash(
      hex.decode(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.deployedBytecode.object),
      immutableReferences,
      terms,
    )
    expect(codeHash).toEqual(keccak_256(bytes((await rpc('eth_getCode', [hx(receiver), 'latest'])) as string)))
    await expect(verifyReceiverBinding(rpc, receiver, terms, codeHash)).resolves.toBeUndefined()
    await expect(verifyReceiverBinding(rpc, receiver, { ...terms, chainId: 1n }, codeHash)).rejects.toThrow(
      'chain mismatch',
    )
    await expect(verifyReceiverBinding(rpc, receiver, terms, new Uint8Array(32))).rejects.toThrow('runtime mismatch')
    await expect(
      verifyReceiverBinding(rpc, receiver, { ...terms, lock: { ...terms.lock, amount: AMOUNT + 1n } }, codeHash),
    ).rejects.toThrow('binding mismatch')
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x1')
    await expect(verifyReceiverBinding(rpc, receiver, terms, codeHash)).rejects.toThrow('already activated')
  })

  it('fails verification for an expired receiver and malformed trusted build metadata', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    const template = hex.decode(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.deployedBytecode.object)
    const codeHash = receiverRuntimeHash(template, immutableReferences, terms)
    expect(() => receiverRuntimeHash(template, { ...immutableReferences, amount: [] }, terms)).toThrow(
      'missing immutable',
    )
    expect(() =>
      receiverRuntimeHash(
        template,
        { ...immutableReferences, amount: [{ start: template.length, length: 32 }] },
        terms,
      ),
    ).toThrow('invalid immutable')
    await mineTo(terms.activationCutoff)
    await expect(verifyReceiverBinding(rpc, receiver, terms, codeHash)).rejects.toThrow('activation closed')
  })

  it('enforces constructor chain and nonempty deployed swap/token code', async () => {
    const terms = await binding()
    const creation = hex.decode(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.bytecode.object)
    expect((await send(accounts[0]!, null, encodeReceiverDeployment(creation, { ...terms, chainId: 1n }))).status).toBe(
      '0x0',
    )
    expect(
      (await send(accounts[0]!, null, encodeReceiverDeployment(creation, { ...terms, swapContract: accounts[3]! })))
        .status,
    ).toBe('0x0')
    expect(
      (
        await send(
          accounts[0]!,
          null,
          encodeReceiverDeployment(creation, { ...terms, lock: { ...terms.lock, tokenAddress: accounts[3]! } }),
        )
      ).status,
    ).toBe('0x0')
  })

  it('rejects malformed and overflowing constructor terms before encoding', async () => {
    const terms = await binding()
    expect(encodeReceiverConstructor(terms)).toHaveLength(9 * 32)
    expect(() => encodeReceiverConstructor({ ...terms, activationCutoff: terms.lock.timelock })).toThrow('precede')
    expect(() => encodeReceiverConstructor({ ...terms, lock: { ...terms.lock, amount: 2n ** 256n } })).toThrow(
      'uint256',
    )
    expect(() =>
      encodeReceiverConstructor({ ...terms, lock: { ...terms.lock, preimageHash: new Uint8Array(31) } }),
    ).toThrow('bytes32')
    expect(() =>
      encodeReceiverConstructor({ ...terms, lock: { ...terms.lock, claimAddress: terms.lock.refundAddress } }),
    ).toThrow('differ')
  })
})
