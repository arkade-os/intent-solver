import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
  encodeFactoryDeploy,
  encodeReceiverActivate,
  encodeReceiverArgs,
  encodeReceiverRecover,
  expectedReceiverRuntimeHash,
  implementationRuntimeHash,
  receiverAddress,
  receiverFactoryDeploymentCall,
  RECEIVER_DEPLOYER,
  RECEIVER_FACTORY,
  RECEIVER_IMPLEMENTATION,
  verifyReceiverBinding,
  type IntentReceiverBinding,
  type ImplementationImmutableReferences,
} from '@arkade-os/solver-rails-evm/evm/receiver.js'
import { concatBytes } from '@noble/hashes/utils.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import { createDurableEvmSender } from '@arkade-os/solver-rails-evm/evm/durableSender.js'
import { createReceiverBackend, ReceiverInvariantError } from '@arkade-os/solver-rails-evm/evm/receiverBackend.js'
import { receiverArtifact } from '@arkade-os/solver-rails-evm/evm/receiverArtifact.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'

type Artifact = {
  evm: {
    bytecode: { object: string }
    deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> }
  }
}
const CONTRACTS = fileURLToPath(new URL('../../packages/solver-rails-evm/contracts/', import.meta.url))
const solidityFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? solidityFiles(join(dir, entry.name))
      : entry.name.endsWith('.sol')
        ? [join(dir, entry.name)]
        : [],
  )
const receiverSources = (): Record<string, { content: string }> =>
  Object.fromEntries(
    solidityFiles(CONTRACTS).map((path) => [
      relative(CONTRACTS, path).split('\\').join('/'),
      { content: readFileSync(path, 'utf8') },
    ]),
  )
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
let immutableReferences: ImplementationImmutableReferences
let snapshot: string

const call = async (address: Uint8Array, signature: string, ...words: Uint8Array[]): Promise<bigint> =>
  BigInt(
    (await rpc('eth_call', [
      { to: hx(address), data: hx(concatBytes(selectorFor(signature), ...words)) },
      'latest',
    ])) as string,
  )
const block = async (): Promise<bigint> => BigInt((await rpc('eth_blockNumber', [])) as string)
const receiptFor = async (hash: unknown) => {
  for (let attempt = 0; attempt < 500; attempt++) {
    const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
      status: string
      contractAddress: string | null
    } | null
    if (receipt) return receipt
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('local transaction receipt missing')
}
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
  return receiptFor(hash)
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
    activationCutoffTimestamp:
      BigInt(((await rpc('eth_getBlockByNumber', ['latest', false])) as { timestamp: string }).timestamp) + 3600n,
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
  expect((await send(accounts[0]!, RECEIVER_FACTORY, encodeFactoryDeploy(terms))).status).toBe('0x1')
  return receiverAddress(terms)
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
  const count = target - (await block())
  if (count > 0n) await rpc('anvil_mine', [`0x${count.toString(16)}`, '0x0'])
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

const testBackend = async (driver: SqlDriver, confirmations = 1) => {
  const transactions = await createDurableEvmSender({
    driver,
    rpc,
    chainId: 31337n,
    privateKey: hex.decode('59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'),
    gasLimit: 6_000_000n,
    maxFeePerGas: 5_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  })
  const backend = createReceiverBackend({
    rpc,
    chainId: 31337n,
    transactions,
    minClaimWindowBlocks: 5n,
    finality: {
      confirmations,
      minAgeSeconds: 0,
      requireFinalizedTag: false,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      maxClockSkewSeconds: 60,
    },
    allowedSwapCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(SWAP), 'latest'])) as string))],
    allowedTokenCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(WETH), 'latest'])) as string))],
  })
  return { backend, transactions }
}
const verifiedDeploy = async (
  backend: ReturnType<typeof createReceiverBackend>,
  id: string,
  terms: IntentReceiverBinding,
) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const deployed = await backend.deploy(id, terms)
    if (deployed.verified) return deployed
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('test receiver deployment never became verified')
}

beforeAll(async () => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('no ephemeral test port')
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((e) => (e ? reject(e) : resolve())))
  rpcUrl = `http://127.0.0.1:${port}`
  const anvilRequire = createRequire(createRequire(import.meta.url).resolve('@foundry-rs/anvil/package.json'))
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch
  const anvilPath = anvilRequire.resolve(
    `@foundry-rs/anvil-${process.platform}-${architecture}/bin/anvil${process.platform === 'win32' ? '.exe' : ''}`,
  )
  anvil = spawn(
    anvilPath,
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
          ...receiverSources(),
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
  ) as ImplementationImmutableReferences
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
  expect((await send(accounts[0]!, RECEIVER_DEPLOYER, receiverFactoryDeploymentCall())).status).toBe('0x1')
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

const chainTest = (name: string, body: () => Promise<void> | void) => it(name, body, 60_000)

describe('experimental provider-funded receiver against real ERC20Swap runtime', () => {
  chainTest('consumes an abandoned expired activation nonce before the next recovery can mine', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend, transactions } = await testBackend(driver)
      const terms = await binding()
      const deployed = await verifiedDeploy(backend, 'gap-deploy', terms)
      expect(deployed.verified).toBe(true)
      await transfer(deployed.address, AMOUNT)
      const abandoned = await backend.prepareActivation('gap-activation', deployed.address, terms)
      const unknown = await driver.get<{ raw: string }>('SELECT raw FROM evm_transaction_journal WHERE id = ?', [
        'gap-activation',
      ])
      await driver.run('UPDATE evm_transaction_journal SET hash = ? WHERE id = ?', [
        '0x' + '00'.repeat(32),
        'gap-activation',
      ])
      expect((await transactions.pending())[0]!.hash).toBe(abandoned.hash)
      const storedAttempt = await driver.get<{ hash: string }>(
        'SELECT hash FROM evm_transaction_attempts WHERE id = ? AND sequence = 0',
        ['gap-activation'],
      )
      await driver.run('UPDATE evm_transaction_attempts SET hash = ? WHERE id = ? AND sequence = 0', [
        '0x' + '00'.repeat(32),
        'gap-activation',
      ])
      await expect(backend.broadcastRawTransaction(unknown!.raw)).rejects.toThrow('no matching durable authorization')
      await driver.run('UPDATE evm_transaction_attempts SET hash = ? WHERE id = ? AND sequence = 0', [
        storedAttempt!.hash,
        'gap-activation',
      ])
      const pending = await transactions.pending()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.rawTransaction).toBe(abandoned.rawTransaction)
      expect(pending[0]!.request.to).toEqual(RECEIVER_FACTORY)
      await expect(backend.resolveExpiredActivation('gap-activation', deployed.address, terms)).rejects.toThrow(
        'guaranteed expired',
      )
      await expect(backend.recover('gap-recovery', deployed.address, terms)).rejects.toThrow('unresolved earlier nonce')
      await mineTo(terms.activationCutoff)
      expect(await backend.resolveExpiredActivation('never-prepared', deployed.address, terms)).toBeNull()
      const resolved = await backend.resolveExpiredActivation('gap-activation', deployed.address, terms)
      const receipt = await receiptFor(resolved!.hash)
      expect(receipt.status).toBe('0x0')
      expect(resolved!.rawTransaction).toBe(abandoned.rawTransaction)
      const recovered = await backend.recover('gap-recovery', deployed.address, terms)
      expect(recovered.nonce).toBe(abandoned.nonce + 1n)
      expect((await receiptFor(recovered.hash)).status).toBe('0x1')
      expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
      expect(await tokenBalance(WETH, accounts[1]!)).toBe(0n)
      expect(await locked(terms)).toBe(0n)
    } finally {
      await driver.close()
    }
  })

  chainTest('deploys at the precomputed address and waits for its finality before verifying', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver, 2)
      const terms = await binding()
      const pending = await backend.deploy('finalized-deploy', terms)
      expect(pending.verified).toBe(false)
      expect(pending.address).toEqual(receiverAddress(terms))
      await receiptFor(pending.transactionHash)
      await rpc('evm_mine', [])
      const ready = await backend.deploy('finalized-deploy', terms)
      expect(ready.verified).toBe(true)
      expect(ready.address).toEqual(pending.address)
      expect(ready.transactionHash).toBe(pending.transactionHash)
      await expect(
        backend.deploy('short-window', { ...terms, lock: { ...terms.lock, timelock: terms.activationCutoff + 1n } }),
      ).rejects.toThrow('claim window is too short')
    } finally {
      await driver.close()
    }
  })

  chainTest('takes funding before deployment, then deploys and activates in one transaction', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const terms = await binding()
      const address = receiverAddress(terms)
      await transfer(address, AMOUNT)
      const before = await backend.inspect(address, terms)
      expect(before).toMatchObject({ deployed: false, activated: false, tokenBalance: AMOUNT, htlcPresent: false })
      const activation = await backend.activate('lazy-activation', address, terms)
      const receipt = (await receiptFor(activation.hash)) as { status: string; gasUsed?: string }
      expect(receipt.status).toBe('0x1')
      expect(Number(receipt.gasUsed)).toBeLessThan(400_000)
      expect(await backend.inspect(address, terms)).toMatchObject({
        deployed: true,
        activated: true,
        htlcPresent: true,
      })
      expect(await locked(terms)).toBe(1n)
    } finally {
      await driver.close()
    }
  })

  chainTest('deploys and recovers a late delivery to an address that never had code', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const terms = await binding()
      const address = receiverAddress(terms)
      await mineTo(terms.activationCutoff)
      await transfer(address, AMOUNT)
      expect((await receiptFor((await backend.recover('late-recovery', address, terms)).hash)).status).toBe('0x1')
      expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
      expect(await tokenBalance(WETH, address)).toBe(0n)
    } finally {
      await driver.close()
    }
  })

  chainTest('refuses to activate or recover through a factory that is not deployed', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const terms = await binding()
      await transfer(receiverAddress(terms), AMOUNT)
      await rpc('anvil_setCode', [hx(RECEIVER_FACTORY), '0x'])
      await expect(backend.activate('no-factory', receiverAddress(terms), terms)).rejects.toThrow('factory')
      await expect(backend.recover('no-factory-recovery', receiverAddress(terms), terms)).rejects.toThrow('factory')
    } finally {
      await driver.close()
    }
  })

  chainTest('verifies a receiver another account deployed without sending its own', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const terms = await binding()
      expect((await send(accounts[3]!, RECEIVER_FACTORY, encodeFactoryDeploy(terms))).status).toBe('0x1')
      const deployed = await backend.deploy('foreign-deploy', terms)
      expect(deployed).toEqual({ address: receiverAddress(terms), transactionHash: null, verified: true })
    } finally {
      await driver.close()
    }
  })

  chainTest('spends a reserved deploy nonce after another account deployed first, and still verifies', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend, transactions } = await testBackend(driver)
      const terms = await binding()
      const prepared = await transactions.prepare('raced-deploy', {
        to: RECEIVER_FACTORY,
        data: encodeFactoryDeploy(terms),
      })
      expect((await send(accounts[3]!, RECEIVER_FACTORY, encodeFactoryDeploy(terms))).status).toBe('0x1')
      const deployed = await backend.deploy('raced-deploy', terms)
      expect(deployed).toEqual({ address: receiverAddress(terms), transactionHash: prepared.hash, verified: true })
      expect((await receiptFor(prepared.hash)).status).toBe('0x1')
    } finally {
      await driver.close()
    }
  })

  chainTest('refuses to deploy on a chain without the deterministic deployer', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      await rpc('anvil_setCode', [hx(RECEIVER_FACTORY), '0x'])
      await rpc('anvil_setCode', [hx(RECEIVER_DEPLOYER), '0x'])
      await expect(backend.deploy('no-deployer', await binding())).rejects.toThrow('not allowlisted')
    } finally {
      await driver.close()
    }
  })

  chainTest('permits a dedicated gas signer to execute refundFor to the fixed primary solver address', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const initial = await binding()
      const terms = { ...initial, lock: { ...initial.lock, claimAddress: accounts[2]! } }
      const deployed = await verifiedDeploy(backend, 'refund-deploy', terms)
      await transfer(deployed.address, AMOUNT)
      await receiptFor((await backend.activate('refund-activation', deployed.address, terms)).hash)
      await expect(backend.refund('refund-destination', terms)).rejects.toThrow('not mature')
      await mineTo(terms.lock.timelock)
      const refunded = await backend.refund('refund-destination', terms)
      expect((await receiptFor(refunded.hash)).status).toBe('0x1')
      expect(await backend.refundEvidence(terms, 0n)).toBe(true)
      expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
      expect(await tokenBalance(WETH, accounts[1]!)).toBe(0n)
    } finally {
      await driver.close()
    }
  })
  chainTest('pins reproducible compiled deployment and runtime artifacts', () => {
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL('../../scripts/build-receiver-artifact.mjs', import.meta.url)), '--check'],
      { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 30_000, stdio: 'pipe' },
    )
    expect(receiverArtifact.factoryCreationBytecode).toBe(
      artifacts['IntentReceiver.sol']!['IntentReceiverFactory']!.evm.bytecode.object,
    )
    expect(receiverArtifact.implementationRuntimeTemplate).toBe(
      artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.deployedBytecode.object,
    )
    expect(receiverArtifact.implementationImmutableReferences).toEqual(immutableReferences)
  })

  chainTest('closes permissionless activation by timestamp even while block cutoff is distant', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    await rpc('evm_setNextBlockTimestamp', [Number(terms.activationCutoffTimestamp)])
    expect((await activate(receiver)).status).toBe('0x0')
    expect(await block()).toBeLessThan(terms.activationCutoff)
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
    expect(await locked(terms)).toBe(0n)
  })

  chainTest(
    'deploys before publishing, observes finalized exact funding, activates, and binds canonical claims',
    async () => {
      const driver = betterSqliteDriver(':memory:')
      try {
        const transactions = await createDurableEvmSender({
          driver,
          rpc,
          chainId: 31337n,
          privateKey: hex.decode('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
          gasLimit: 6_000_000n,
          maxFeePerGas: 5_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        })
        const backend = createReceiverBackend({
          rpc,
          chainId: 31337n,
          transactions,
          minClaimWindowBlocks: 5n,
          finality: {
            confirmations: 1,
            minAgeSeconds: 0,
            requireFinalizedTag: false,
            nowSeconds: () => Math.floor(Date.now() / 1000),
            maxClockSkewSeconds: 60,
          },
          allowedSwapCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(SWAP), 'latest'])) as string))],
          allowedTokenCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(WETH), 'latest'])) as string))],
        })
        const terms = await binding()
        const deployed = await verifiedDeploy(backend, 'deploy-intent', terms)
        expect(deployed.verified).toBe(true)
        const before = await backend.inspect(deployed.address, terms)
        expect(before.htlcPresent).toBe(false)
        expect(before.tokenBalance).toBe(0n)
        await transfer(deployed.address, AMOUNT)
        expect((await backend.inspect(deployed.address, terms)).tokenBalance).toBe(AMOUNT)
        const activated = await backend.activate('activate-intent', deployed.address, terms)
        await receiptFor(activated.hash)
        expect(activated.state).toBe('submitted')
        const after = await backend.inspect(deployed.address, terms)
        expect(after.activated).toBe(true)
        expect(after.htlcPresent).toBe(true)
        expect(after.tokenBalance).toBe(0n)
        expect(await backend.claimEvidence(terms, before.observedBlock)).toBeNull()
        expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x1')
        expect(await backend.claimEvidence(terms, before.observedBlock)).toEqual(PREIMAGE)
        expect(await backend.refundEvidence(terms, before.observedBlock)).toBe(false)
      } finally {
        await driver.close()
      }
    },
  )

  chainTest(
    'persists signed dispatch before network, replays identical bytes after restart, and rejects request mutation',
    async () => {
      const driver = betterSqliteDriver(':memory:')
      try {
        const rawTransactions: string[] = []
        let fail = true
        const journalRpc = async (method: string, params: readonly unknown[]) => {
          if (method === 'eth_sendRawTransaction') {
            rawTransactions.push(params[0] as string)
            if (fail) throw new Error('network stopped')
          }
          return rpc(method, params)
        }
        const deps = {
          driver,
          rpc: journalRpc,
          chainId: 31337n,
          privateKey: hex.decode('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
          gasLimit: 6_000_000n,
          maxFeePerGas: 5_000_000_000n,
          maxPriorityFeePerGas: 1_000_000_000n,
        }
        const first = await createDurableEvmSender(deps)
        const request = { to: accounts[3]!, data: new Uint8Array() }
        expect((await first.submit('durable-send', request)).state).toBe('unknown')
        const saved = await driver.get<{ raw: string; state: string }>(
          'SELECT raw,state FROM evm_transaction_journal WHERE id = ?',
          ['durable-send'],
        )
        expect(saved!.raw).toBe(rawTransactions[0])
        expect(saved!.state).toBe('unknown')
        fail = false
        const restarted = await createDurableEvmSender(deps)
        const replayed = await restarted.submit('durable-send', request)
        expect(replayed.state).toBe('submitted')
        await receiptFor(replayed.hash)
        expect(rawTransactions[1]).toBe(rawTransactions[0])
        await expect(restarted.submit('durable-send', { to: accounts[4]!, data: new Uint8Array() })).rejects.toThrow(
          'changed request',
        )
        expect(rawTransactions).toHaveLength(2)

        const minedOriginal = await restarted.replace(
          'durable-send',
          request,
          { maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 1_200_000_000n },
          8_000_000_000n,
        )
        expect(minedOriginal.hash).toBe(replayed.hash)
        expect(minedOriginal.state).toBe('success')
        expect(rawTransactions).toHaveLength(2)

        await rpc('anvil_setAutomine', [false])
        let replacement: Awaited<ReturnType<typeof restarted.replace>>
        try {
          await restarted.submit('durable-replacement', request)
          replacement = await restarted.replace(
            'durable-replacement',
            request,
            { maxFeePerGas: 6_000_000_000n, maxPriorityFeePerGas: 1_200_000_000n },
            8_000_000_000n,
          )
          expect(replacement.state).toBe('submitted')
          const pending = await restarted.pending()
          expect(pending.map((item) => item.hash)).toEqual([replacement.hash])
          await rpc('evm_mine', [])
          expect(await restarted.getPrepared('durable-replacement', request)).toMatchObject({
            hash: replacement.hash,
            state: 'success',
          })
          expect(await restarted.pending()).toEqual([])
        } finally {
          await rpc('anvil_setAutomine', [true])
        }

        const next = await restarted.prepare('next-send', request)
        expect(next.nonce).toBe(replacement!.nonce + 1n)
        await driver.run("UPDATE evm_transaction_journal SET nonce = '000000000000ffff' WHERE id = ?", ['durable-send'])
        await expect(restarted.submit('durable-send', request)).rejects.toThrow('does not authorize')
        expect(rawTransactions).toHaveLength(4)
      } finally {
        await driver.close()
      }
    },
  )
  chainTest(
    'holds partial funding, permits topups, activates exactly once, and pays the immutable claimant',
    async () => {
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
    },
  )

  chainTest('protects the required amount and sends excess/duplicates to the fixed refund address', async () => {
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

  chainTest('rejects activation at the exact cutoff and recovers late funds without creating a lock', async () => {
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

  chainTest('refunds a matured destination lock to solver and cannot claim after refund', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x1')
    await mineTo(terms.lock.timelock)
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
    expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x0')
  })

  chainTest('shows the actual destination claim branch remains valid after timelock until refund wins', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await transfer(receiver, AMOUNT)
    expect((await activate(receiver)).status).toBe('0x1')
    await mineTo(terms.lock.timelock + 1n)
    expect((await send(accounts[1]!, SWAP, encodeClaim(PREIMAGE, terms.lock))).status).toBe('0x1')
    expect((await send(accounts[0]!, SWAP, encodeRefund(terms.lock))).status).toBe('0x0')
  })

  chainTest('rejects wrong asset funding while allowing its recovery', async () => {
    const wrong = await deployArtifact('ReceiverTokens.sol', 'ReceiverProbeToken')
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    await mint(wrong, receiver)
    expect((await activate(receiver)).status).toBe('0x0')
    expect((await recover(receiver, wrong)).status).toBe('0x1')
    expect(await tokenBalance(wrong, accounts[0]!)).toBe(AMOUNT)
    expect(await locked(terms)).toBe(0n)
  })

  chainTest('recovers a short unactivated deposit after cutoff', async () => {
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

  chainTest('does not report recovery when transfer fails or falsely returns success', async () => {
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

  chainTest('refuses to overwrite an already funded destination lock', async () => {
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

  chainTest('classifies a stable exact lock without receiver activation as an invariant failure', async () => {
    const driver = betterSqliteDriver(':memory:')
    try {
      const { backend } = await testBackend(driver)
      const terms = await binding()
      const deployed = await verifiedDeploy(backend, 'invariant-deploy', terms)
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

      await expect(backend.inspect(deployed.address, terms)).rejects.toBeInstanceOf(ReceiverInvariantError)
    } finally {
      await driver.close()
    }
  })

  chainTest('atomically rolls back approval failure and permits retry after token recovery', async () => {
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

  chainTest('blocks token callback recovery during activation', async () => {
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

  chainTest('rejects fee-on-transfer tokens and rolls back the swap flag and allowance', async () => {
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

  chainTest('supports tokens returning no approval/transfer result against the real swap', async () => {
    const token = await deployArtifact('ReceiverTokens.sol', 'ReceiverNoReturnToken')
    const terms = await binding(token)
    const receiver = await deployReceiver(terms)
    await mint(token, receiver, AMOUNT + 1n)
    expect((await activate(receiver)).status).toBe('0x1')
    expect((await recover(receiver, token)).status).toBe('0x1')
    expect(await tokenBalance(token, SWAP)).toBe(AMOUNT)
    expect(await tokenBalance(token, accounts[0]!)).toBe(1n)
  })

  chainTest('checks chain, exact runtime, immutable binding, state, and activation window', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    const codeHash = expectedReceiverRuntimeHash(terms)
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

  chainTest('fails verification for an expired receiver and malformed trusted build metadata', async () => {
    const terms = await binding()
    const receiver = await deployReceiver(terms)
    const codeHash = expectedReceiverRuntimeHash(terms)
    const template = hex.decode(artifacts['IntentReceiver.sol']!['IntentReceiver']!.evm.deployedBytecode.object)
    expect(implementationRuntimeHash(template, immutableReferences, RECEIVER_IMPLEMENTATION)).toEqual(
      keccak_256(bytes((await rpc('eth_getCode', [hx(RECEIVER_IMPLEMENTATION), 'latest'])) as string)),
    )
    expect(() => implementationRuntimeHash(template, { self: [] }, RECEIVER_IMPLEMENTATION)).toThrow(
      'missing immutable',
    )
    expect(() =>
      implementationRuntimeHash(template, { self: [{ start: template.length, length: 32 }] }, RECEIVER_IMPLEMENTATION),
    ).toThrow('invalid immutable')
    await mineTo(terms.activationCutoff)
    await expect(verifyReceiverBinding(rpc, receiver, terms, codeHash)).rejects.toThrow('activation closed')
  })

  chainTest('deploys any binding but activates only on its chain with deployed swap and token code', async () => {
    const terms = await binding()
    for (const bad of [
      { ...terms, chainId: 1n },
      { ...terms, swapContract: accounts[3]! },
      { ...terms, lock: { ...terms.lock, tokenAddress: accounts[3]! } },
      { ...terms, lock: { ...terms.lock, claimAddress: SWAP } },
    ]) {
      const receiver = await deployReceiver(bad)
      expect((await activate(receiver)).status).toBe('0x0')
    }
  })

  chainTest('recovers everything on a chain the binding does not name', async () => {
    const terms = { ...(await binding()), chainId: 1n }
    const receiver = receiverAddress(terms)
    await transfer(receiver, AMOUNT)
    await deployReceiver(terms)
    expect((await recover(receiver)).status).toBe('0x1')
    expect(await tokenBalance(WETH, accounts[0]!)).toBe(AMOUNT)
  })

  chainTest('sweeps force-fed ETH to the refund address', async () => {
    const receiver = await deployReceiver(await binding())
    const NO_TOKEN = new Uint8Array(20)
    expect((await recover(receiver, NO_TOKEN)).status).toBe('0x0')
    await rpc('anvil_setBalance', [hx(receiver), '0xde0b6b3a7640000'])
    const before = BigInt((await rpc('eth_getBalance', [hx(accounts[0]!), 'latest'])) as string)
    expect((await recover(receiver, NO_TOKEN)).status).toBe('0x1')
    expect(BigInt((await rpc('eth_getBalance', [hx(receiver), 'latest'])) as string)).toBe(0n)
    expect(BigInt((await rpc('eth_getBalance', [hx(accounts[0]!), 'latest'])) as string) - before).toBe(10n ** 18n)
  })

  chainTest('refuses calls made to the implementation rather than a clone', async () => {
    expect((await activate(RECEIVER_IMPLEMENTATION)).status).toBe('0x0')
    expect((await recover(RECEIVER_IMPLEMENTATION)).status).toBe('0x0')
  })

  chainTest('rejects malformed and overflowing binding terms before encoding', async () => {
    const terms = await binding()
    expect(encodeReceiverArgs(terms)).toHaveLength(10 * 32)
    expect(() => encodeReceiverArgs({ ...terms, activationCutoff: terms.lock.timelock })).toThrow('precede')
    expect(() => encodeReceiverArgs({ ...terms, lock: { ...terms.lock, amount: 2n ** 256n } })).toThrow('uint256')
    expect(() => encodeReceiverArgs({ ...terms, lock: { ...terms.lock, preimageHash: new Uint8Array(31) } })).toThrow(
      'bytes32',
    )
    expect(() =>
      encodeReceiverArgs({ ...terms, lock: { ...terms.lock, claimAddress: terms.lock.refundAddress } }),
    ).toThrow('differ')
  })
})
