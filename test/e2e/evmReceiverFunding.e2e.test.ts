import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { EvmSendSwapService } from '@arkade-os/solver-corridors-evm/send/evmOrchestrator.js'
import { EvmSendSwapStore, type EvmSendSwapRow } from '@arkade-os/solver-corridors-evm/db/evmSendSwaps.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { arkadeOpsFromContext } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { evmSendArkadeDeps } from '@arkade-os/solver-corridors-evm/send/evmArkadeDeps.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { EVM_ORDER_MARGIN_SECONDS } from '@arkade-os/solver-core/core/evmSend.js'
import { createPriceFeed } from '@arkade-os/solver-core/price/feed.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import type { EvmPayoutFundingAdapter, EvmPayoutFundingBinding } from '@arkade-os/solver-core/ports/evmPayoutFunding.js'
import { createEvmHtlcBackend } from '@arkade-os/solver-rails-evm/evm/backend.js'
import { createEvmBroadcaster } from '@arkade-os/solver-rails-evm/evm/broadcast.js'
import { createNonceSource } from '@arkade-os/solver-rails-evm/evm/nonce.js'
import { encodeClaim } from '@arkade-os/solver-rails-evm/evm/erc20Swap.js'
import { createDurableEvmSender } from '@arkade-os/solver-rails-evm/evm/durableSender.js'
import { createReceiverBackend } from '@arkade-os/solver-rails-evm/evm/receiverBackend.js'
import { assertEvmClaimTraceSupport } from '@arkade-os/solver-rails-evm/evm/claimTraceProbe.js'
import {
  receiverAddress,
  RECEIVER_DEPLOYER,
  RECEIVER_DEPLOYER_RUNTIME,
  type IntentReceiverBinding,
} from '@arkade-os/solver-rails-evm/evm/receiver.js'
import { addressFromPrivateKey } from '@arkade-os/solver-rails-evm/evm/transaction.js'
import { openArkade, type E2eArkade } from './support/stack.js'
import {
  CLIENT_KEY,
  SWAP_ADDRESS,
  WETH,
  abiCall,
  balanceOf,
  evmChainReady,
  evmRpc,
  fundWithWeth,
  installContracts,
  sendFrom,
  setEth,
  waitForReceipt,
  word,
  type EvmRpc,
} from './support/evmChain.js'

const AMOUNT_SATS = 100_000
const FEED_URL = process.env.PRICEFEED_E2E_URL ?? 'http://localhost:8088/btc-asset'
const PROVIDER_KEY = new Uint8Array(32).fill(3)
const RECEIVER_KEY = new Uint8Array(32).fill(4)
const REFUND_KEY = new Uint8Array(32).fill(5)
const MIN_CONFIRMATIONS = 2
const hx = (bytes: Uint8Array): string => `0x${hex.encode(bytes)}`
const bytes = (value: string): Uint8Array => hex.decode(value.replace(/^0x/, ''))
const minedConfirmation = async (label: string, receiptBlock: bigint): Promise<void> => {
  await rpc('anvil_mine', ['0x1', '0x0'])
  const postMineHead = BigInt((await rpc('eth_blockNumber', [])) as string)
  const confirmations = postMineHead - receiptBlock + 1n
  console.info(
    `${label} confirmation mine receiptBlock=${receiptBlock} postMineHead=${postMineHead} confirmations=${confirmations}`,
  )
  if (confirmations < BigInt(MIN_CONFIRMATIONS))
    throw new Error(
      `${label} confirmation mine did not reach depth ${MIN_CONFIRMATIONS}: ` +
        `receiptBlock=${receiptBlock}, postMineHead=${postMineHead}, confirmations=${confirmations}`,
    )
}

let available = false
let arkade: E2eArkade | undefined
let rpc: EvmRpc
let sql: SqlDriver | undefined
let store: EvmSendSwapStore
let service: EvmSendSwapService
let receivers: ReturnType<typeof createReceiverBackend>
let activationSubmissions = 0

type PreparedReceiver = {
  binding: string
  address: string
  funding_txid: string | null
  activation_txid: string | null
}
const receiverBinding = (binding: EvmPayoutFundingBinding): IntentReceiverBinding => ({
  chainId: BigInt(binding.chainId),
  swapContract: bytes(binding.contractAddress),
  activationCutoff: BigInt(binding.evmTimeout) - 100n,
  activationCutoffTimestamp: BigInt(binding.arkadeRefundLocktime - EVM_ORDER_MARGIN_SECONDS),
  lock: {
    tokenAddress: bytes(binding.tokenAddress),
    amount: BigInt(binding.amount),
    preimageHash: bytes(binding.paymentHash),
    claimAddress: bytes(binding.claimAddress),
    refundAddress: bytes(binding.refundAddress),
    timelock: BigInt(binding.evmTimeout),
  },
})

beforeAll(async () => {
  if (!(await evmChainReady())) return
  try {
    const feed = await fetch(FEED_URL, { signal: AbortSignal.timeout(2_000) })
    if (!feed.ok) return
    arkade = await openArkade()
  } catch {
    return
  }
  if ((await arkade.ctx.wallet.getBalance()).available < AMOUNT_SATS) return

  rpc = evmRpc()
  // Earlier refund cases advance Anvil time; this file needs honest wall-clock cutoff checks.
  await rpc('anvil_reset', [])
  await rpc('anvil_setAutomine', [true])
  const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`fixtures/${name}.runtime.hex`, import.meta.url)), 'utf8')
  await installContracts(rpc, fixture('erc20swap'), fixture('weth9'))
  await rpc('anvil_setCode', [hx(RECEIVER_DEPLOYER), hx(RECEIVER_DEPLOYER_RUNTIME)])
  for (const key of [PROVIDER_KEY, RECEIVER_KEY, REFUND_KEY, CLIENT_KEY]) {
    await setEth(rpc, addressFromPrivateKey(key), 10n ** 20n)
  }
  await fundWithWeth(rpc, PROVIDER_KEY, 10n ** 18n)
  sql = betterSqliteDriver(':memory:')
  store = await EvmSendSwapStore.open(sql)
  await sql.exec(`CREATE TABLE receiver_funding_e2e (
    intent_id TEXT PRIMARY KEY, binding TEXT NOT NULL, address TEXT NOT NULL,
    funding_txid TEXT, activation_txid TEXT
  )`)
  const sender = async (privateKey: Uint8Array) =>
    createDurableEvmSender({
      driver: sql!,
      rpc,
      chainId: 31337n,
      privateKey,
      gasLimit: 6_000_000n,
      maxFeePerGas: 5_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    })
  const receiverSender = await sender(RECEIVER_KEY)
  const providerSender = await sender(PROVIDER_KEY)
  receivers = createReceiverBackend({
    rpc,
    chainId: 31337n,
    transactions: receiverSender,
    minClaimWindowBlocks: 100n,
    finality: {
      confirmations: MIN_CONFIRMATIONS,
      minAgeSeconds: 0,
      requireFinalizedTag: false,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      maxClockSkewSeconds: 60,
    },
    allowedSwapCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(SWAP_ADDRESS), 'latest'])) as string))],
    allowedTokenCodeHashes: [keccak_256(bytes((await rpc('eth_getCode', [hx(WETH), 'latest'])) as string))],
  })
  await receivers.ensureFactory()
  const funding: EvmPayoutFundingAdapter = {
    identity: 'plain-token-provider-e2e',
    async prepareQuote({ binding }) {
      await sql!.run('INSERT INTO receiver_funding_e2e(intent_id,binding,address) VALUES(?,?,?)', [
        binding.intentId,
        JSON.stringify(binding),
        hx(receiverAddress(receiverBinding(binding))),
      ])
      return { validUntil: binding.quoteValidUntil }
    },
    async abandonQuote() {},
    async ensure({ binding }, mode) {
      const prepared = await sql!.get<PreparedReceiver>('SELECT * FROM receiver_funding_e2e WHERE intent_id=?', [
        binding.intentId,
      ])
      if (!prepared || prepared.binding !== JSON.stringify(binding)) throw new Error('Missing immutable receiver quote')
      expect(mode).not.toBe('recover')
      expect((await store.get(binding.intentId)).state).toBe('locking_evm')
      if (prepared.activation_txid) return { activationTxid: prepared.activation_txid }
      const immutable = receiverBinding(binding)
      const receiver = bytes(prepared.address)
      let fundingTxid = prepared.funding_txid
      let fundingWasSubmitted = false
      if (!prepared.funding_txid) {
        const transfer = await providerSender.submit(`provider-fund:${binding.intentId}`, {
          to: WETH,
          data: abiCall('a9059cbb', receiver, word(immutable.lock.amount)),
        })
        fundingTxid = transfer.hash
        fundingWasSubmitted = true
        await sql!.run('UPDATE receiver_funding_e2e SET funding_txid=? WHERE intent_id=?', [
          fundingTxid,
          binding.intentId,
        ])
      }
      if (!fundingTxid) throw new Error('Provider funding transaction was not recorded')
      const minedFunding = await waitForReceipt(rpc, fundingTxid)
      expect(minedFunding.status, `provider funding reverted: ${fundingTxid}`).toBe('0x1')
      if (fundingWasSubmitted) await minedConfirmation('provider funding', BigInt(minedFunding.blockNumber))
      const fundingReceipt = (await rpc('eth_getTransactionReceipt', [fundingTxid ?? ''])) as {
        transactionHash?: unknown
        blockHash?: unknown
        blockNumber?: unknown
        status?: unknown
      } | null
      if (
        !fundingReceipt ||
        fundingReceipt.transactionHash !== fundingTxid ||
        typeof fundingReceipt.blockNumber !== 'string' ||
        typeof fundingReceipt.blockHash !== 'string' ||
        fundingReceipt.status !== '0x1'
      )
        throw new Error(`provider funding transaction is missing or reverted: ${fundingTxid}`)
      const fundingBlock = (await rpc('eth_getBlockByNumber', [fundingReceipt.blockNumber, false])) as {
        hash?: unknown
      } | null
      if (fundingBlock?.hash !== fundingReceipt.blockHash)
        throw new Error(`provider funding transaction is not canonical: ${fundingTxid}`)
      const observation = await receivers.inspect(receiver, immutable)
      if (observation.htlcPresent) return { activationTxid: prepared.activation_txid ?? undefined }
      const latestBalance = await balanceOf(rpc, WETH, receiver)
      if (latestBalance !== immutable.lock.amount)
        throw new Error(
          `provider funding did not credit exact amount: latest=${latestBalance}, observed=${observation.tokenBalance}, ` +
            `observedBlock=${observation.observedBlock}, observedTimestamp=${observation.observedTimestamp}`,
        )
      if (observation.tokenBalance > immutable.lock.amount)
        throw new Error(`finalized receiver balance exceeds the exact quote: ${observation.tokenBalance}`)
      // The canonical, two-confirmation view may lag a fresh Anvil block whose
      // timestamp is ahead of wall time. Keep the row live and retry next tick.
      if (observation.tokenBalance < immutable.lock.amount) return {}
      const activation = await receivers.activate(`activate:${binding.intentId}`, receiver, immutable)
      activationSubmissions++
      await sql!.run('UPDATE receiver_funding_e2e SET activation_txid=? WHERE intent_id=?', [
        activation.hash,
        binding.intentId,
      ])
      const activationReceipt = await waitForReceipt(rpc, activation.hash)
      expect(activationReceipt.status, `receiver activation reverted: ${activation.hash}`).toBe('0x1')
      return { activationTxid: activation.hash }
    },
    async sweepRecovery() {},
  }
  const ops = await arkadeOpsFromContext(arkade.ctx, arkade.emulator)
  const backend = createEvmHtlcBackend({ contractAddress: SWAP_ADDRESS, rpc })
  service = new EvmSendSwapService({
    store,
    evm: backend,
    payoutFunding: funding,
    broadcast: createEvmBroadcaster({
      rpc,
      privateKey: REFUND_KEY,
      chainId: 31337,
      gasLimit: 500_000n,
      maxFeeCeilingPerGas: 100n * 10n ** 9n,
      nonces: createNonceSource(async (address, block) =>
        BigInt((await rpc('eth_getTransactionCount', [hx(address), block])) as string),
      ),
      headroomSeconds: 600,
      fastestSecondsPerBlock: 1,
    }),
    ...evmSendArkadeDeps(ops),
    arkade: ops,
    solverEvmAddress: addressFromPrivateKey(REFUND_KEY),
    blockHeight: async () => Number(await backend.currentBlock()),
    maxExposedSats: 1_000_000_000,
    admission: new AdmissionControl(),
    totalCommitted: async () => 0,
    assertClaimTraceSupport: (tokenAddress) => assertEvmClaimTraceSupport(rpc, tokenAddress),
    markets: new Map([
      [
        hx(WETH),
        {
          token: { symbol: 'WETH', address: hx(WETH), decimals: 0 },
          market: {
            token: { symbol: 'WETH', address: hx(WETH), decimals: 0 },
            priceFeed: FEED_URL,
            pricePath: '/btc/asset',
          },
          limits: { minSats: 1_000, maxSats: 10_000_000 },
          fee: { bps: 100, flatSats: 0 },
        },
      ],
    ]),
    fetchPrice: createPriceFeed(),
    chain: {
      contractAddress: hx(SWAP_ADDRESS),
      chainId: 31337,
      minConfirmations: MIN_CONFIRMATIONS,
      minAgeSeconds: 0,
      cadence: { fastestSecondsPerBlock: 1, slowestSecondsPerBlock: 1 },
      quoteValiditySeconds: 60,
    },
    onTickError: (id, error) => console.error(`EVM receiver funding ${id} failed:`, error),
  })
  available = true
}, 240_000)

afterAll(async () => {
  arkade?.close()
  await sql?.close()
})

const tickUntil = async (id: string, done: (row: EvmSendSwapRow) => boolean): Promise<EvmSendSwapRow> => {
  const deadline = Date.now() + 120_000
  let row = await store.get(id)
  while (!done(row) && Date.now() < deadline) {
    await service.tick(id)
    row = await store.get(id)
    if (!done(row)) await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  return row
}

describe('e2e provider-funded receiver across real Arkade and EVM chains', () => {
  it('plain ERC20 funding activates the exact quote and a finalized client claim settles Arkade', async (ctx) => {
    if (!available) return ctx.skip()
    const preimage = crypto.getRandomValues(new Uint8Array(32))
    const outcome = await service.quote({
      paymentHash: hex.encode(sha256(preimage)),
      tokenAddress: hx(WETH),
      amountSats: AMOUNT_SATS,
      evmClaimAddress: hx(addressFromPrivateKey(CLIENT_KEY)),
      refundAddress: await arkade!.ctx.wallet.getAddress(),
      clientRefundPubkey: hex.encode(await arkade!.ctx.identity.xOnlyPublicKey()),
    })
    expect(outcome.accepted, JSON.stringify(outcome)).toBe(true)
    if (!outcome.accepted) return
    const quoted = outcome.swap
    expect(await balanceOf(rpc, WETH, addressFromPrivateKey(REFUND_KEY))).toBe(0n)
    const providerBefore = await balanceOf(rpc, WETH, addressFromPrivateKey(PROVIDER_KEY))
    const clientBefore = await balanceOf(rpc, WETH, addressFromPrivateKey(CLIENT_KEY))
    await arkade!.ctx.wallet.send({ address: quoted.lockupAddress, amount: AMOUNT_SATS })
    const locked = await tickUntil(quoted.id, (row) => row.evmLockTxid !== null || row.failureReason !== null)
    expect(locked.failureReason).toBeNull()
    expect(locked.evmLockTxid).toMatch(/^0x[0-9a-f]{64}$/)
    await rpc('anvil_mine', ['0x1', '0x0'])
    const awaiting = await tickUntil(quoted.id, (row) => row.state === 'awaiting_claim' || row.failureReason !== null)
    expect(awaiting.state).toBe('awaiting_claim')
    const prepared = (await sql!.get<PreparedReceiver>('SELECT * FROM receiver_funding_e2e WHERE intent_id=?', [
      quoted.id,
    ]))!
    expect(activationSubmissions).toBe(1)
    const immutable = receiverBinding(JSON.parse(prepared.binding) as EvmPayoutFundingBinding)
    const proof = await receivers.inspect(bytes(prepared.address), immutable)
    expect(proof.htlcPresent).toBe(true)
    expect(proof.activated).toBe(true)
    expect(proof.tokenBalance).toBe(0n)
    expect(proof.confirmations).toBeGreaterThanOrEqual(MIN_CONFIRMATIONS)
    expect(providerBefore - (await balanceOf(rpc, WETH, addressFromPrivateKey(PROVIDER_KEY)))).toBe(
      immutable.lock.amount,
    )
    expect(await balanceOf(rpc, WETH, addressFromPrivateKey(REFUND_KEY))).toBe(0n)
    const fundingTx = (await rpc('eth_getTransactionByHash', [prepared.funding_txid])) as { to: string; input: string }
    expect(fundingTx.to.toLowerCase()).toBe(hx(WETH))
    expect(fundingTx.input).toBe(hx(abiCall('a9059cbb', bytes(prepared.address), word(immutable.lock.amount))))
    const clientClaim = await sendFrom(rpc, CLIENT_KEY, SWAP_ADDRESS, encodeClaim(preimage, immutable.lock))
    expect(clientClaim.status).toBe('0x1')
    expect((await balanceOf(rpc, WETH, addressFromPrivateKey(CLIENT_KEY))) - clientBefore).toBe(immutable.lock.amount)
    await service.tick(quoted.id)
    const unfinalized = await store.get(quoted.id)
    expect(unfinalized.preimage).toBeNull()
    expect(unfinalized.claimArkTxid).toBeNull()
    await rpc('anvil_mine', ['0x1', '0x0'])
    const settled = await tickUntil(quoted.id, (row) => row.state === 'claimed' || row.failureReason !== null)
    expect(settled.failureReason).toBeNull()
    expect(settled.state).toBe('claimed')
    expect(settled.preimage).toBe(hex.encode(preimage))
    expect(settled.claimArkTxid).toMatch(/^[0-9a-f]{64}$/)
    expect(await receivers.claimEvidence(immutable, clientClaim.blockNumber)).toEqual(preimage)
  }, 600_000)
})
