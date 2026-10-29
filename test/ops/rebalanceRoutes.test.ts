import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ArkAddress,
  Transaction,
  VHTLC,
  VHTLCV2ContractHandler,
  type NormalizedExtendedVirtualCoin,
} from '@arkade-os/sdk'
import { Address } from '@scure/btc-signer'
import { base64, hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import type { RfqSwapRecordStore, RfqSwapManagerDeps, RfqSwapManager, RfqSwapRecord } from '@arkade-os/swap'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import type { RebalanceDeposit, RebalancePolicy, RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import { betterSqliteDriver } from '@arkade-os/solver-db/driver.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import { createReservationLedger } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { forgeInvoice } from '@arkade-os/solver-rails-fake/ln/fake/bolt11.js'
import type { Services } from '@arkade-os/solver-app/ops/services.js'
import { createArkadeRebalanceSource } from '@arkade-os/solver-app/ops/rebalanceRoutes.js'
import type { RebalanceSource } from '@arkade-os/solver-app/ops/rebalance.js'

const mocks = vi.hoisted(() => ({
  route: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  managerRepositories: [] as RfqSwapRecordStore[],
  managerAdd: vi.fn(),
  restoreIds: [] as string[][],
  realManager: false,
  actualManagers: [] as RfqSwapManager[],
  refund: vi.fn(),
  signer: vi.fn(),
  rebuild: vi.fn(),
}))

vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...real,
    PaymentRouter: class {
      use() {
        return this
      }
      route(params: unknown) {
        return mocks.route(params)
      }
    },
  }
})

vi.mock('@arkade-os/swap/nostr', () => ({ nostrRfqTransport: () => ({ close: mocks.close }) }))
vi.mock('@arkade-os/swap', async (importOriginal) => {
  const real = await importOriginal<typeof import('@arkade-os/swap')>()
  return {
    ...real,
    requestLightningSend: mocks.request,
    arkadeRefunder: () => mocks.refund,
    senderIdentityForSwapRecord: mocks.signer,
    createRfqSwapRecord: (origin: Record<string, unknown>, swap: Record<string, unknown>) => ({
      ...origin,
      rfqId: swap.rfqId,
      state: swap.state,
      createdAt: swap.createdAt,
      updatedAt: swap.updatedAt,
    }),
    lockupContractParams: vi.fn().mockResolvedValue({}),
    rebuildRfqSwap: mocks.rebuild,
    RfqSwapManager: class {
      constructor(private deps: RfqSwapManagerDeps) {
        if (mocks.realManager) {
          const manager = new real.RfqSwapManager(deps, { pollIntervalMs: 60_000 })
          mocks.actualManagers.push(manager)
          return manager as unknown as this
        }
        mocks.managerRepositories.push(deps.repository!)
      }
      setCallbacks() {}
      async restoreFromRepository() {
        mocks.restoreIds.push((await this.deps.repository!.getAllRfqSwaps()).map((record) => record.rfqId))
        return { restored: [], failed: [] }
      }
      async start() {}
      async stop() {}
      async poll() {}
      async hasSwap() {
        return false
      }
      async isProcessing() {
        return false
      }
      async removeSwap() {}
      addSwap(swap: unknown) {
        mocks.managerAdd(swap)
        return Promise.resolve()
      }
    },
  }
})

const txid = 'aa'.repeat(32)
const address = Address(ONCHAIN_NETWORKS.regtest).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(1) })
const lockupAddress = new ArkAddress(
  new Uint8Array(32).fill(2),
  schnorr.getPublicKey(new Uint8Array(32).fill(3)),
  'tark',
).encode()
const refundAddress = new ArkAddress(
  new Uint8Array(32).fill(2),
  schnorr.getPublicKey(new Uint8Array(32).fill(4)),
  'tark',
).encode()
const timestamp = (): number => Math.floor(Date.now() / 1000)
const policy: RebalancePolicy = {
  enabled: false,
  reserveSats: 500,
  maxDebitSats: 5_000,
  dailyDebitSats: 10_000,
  maxFeeSats: 100,
  maxFeeBps: 1_000,
  minTransferSats: 500,
  cooldownSeconds: 10,
  targets: {},
  counterparty: { solverPubkey: 'bb'.repeat(32), relays: ['wss://relay.example'] },
}
const deposit: RebalanceDeposit = {
  kind: 'onchain',
  destination: address,
  amountSats: 1_020,
  netSats: 1_000,
  feeSats: 20,
}
const coin = (byte: string, value: number, assets = false): NormalizedExtendedVirtualCoin =>
  ({ txid: byte.repeat(64), vout: 0, value, assets: assets ? [{}] : [] }) as unknown as NormalizedExtendedVirtualCoin
const rowFrom = (
  quote: Awaited<ReturnType<RebalanceSource['quote']>>,
  receiving: RebalanceDeposit = deposit,
): RebalanceTransfer => ({
  id: 'rebalance-1',
  requestKey: 'request-1',
  origin: 'manual',
  poolId: 'rail:onchain',
  netSats: receiving.netSats,
  policyRevision: 'policy-1',
  createdAt: timestamp(),
  updatedAt: timestamp(),
  state: 'quoted',
  deposit: receiving,
  ...quote,
})

describe('Arkade rebalance source routes', () => {
  let driver: SqlDriver
  let services: Services
  let source: RebalanceSource
  let admission: AdmissionControl
  let coins: NormalizedExtendedVirtualCoin[]
  let sourceFee: number
  let send: ReturnType<typeof vi.fn>
  let indexerCoins: Record<string, unknown>[]
  let outputs: { txid: string; vout: number; valueSats: number; confirmations: number }[]

  beforeEach(async () => {
    vi.clearAllMocks()
    mocks.realManager = false
    mocks.actualManagers.length = 0
    mocks.signer.mockResolvedValue({})
    mocks.rebuild.mockImplementation((record) => record)
    mocks.managerRepositories.length = 0
    mocks.restoreIds.length = 0
    driver = betterSqliteDriver(':memory:')
    coins = [coin('1', 2_000), coin('2', 1_500)]
    sourceFee = 10
    indexerCoins = []
    outputs = []
    send = vi.fn().mockResolvedValue({ settled: async () => ({ txid }) })
    mocks.route.mockImplementation(async ({ amount }: { amount: number }) => ({
      amount,
      total: amount + sourceFee,
      fee: sourceFee,
      send,
    }))
    services = {
      config: { network: 'regtest' },
      providerPubkey: 'cc'.repeat(32),
      readers: [],
      arkade: {
        arkServerUrl: 'https://operator.example',
        reservations: createReservationLedger(),
        wallet: {
          getSpendableVtxos: vi.fn(async () => coins),
          getContractManager: vi.fn().mockResolvedValue({}),
          arkProvider: { getInfo: vi.fn().mockResolvedValue({ fees: {} }) },
          send: vi.fn().mockResolvedValue(txid),
          indexerProvider: {
            getVtxos: vi.fn(async () => ({ vtxos: indexerCoins })),
            getVirtualTxs: vi.fn().mockResolvedValue({ txs: [] }),
          },
        },
      },
      onchain: { findOutputs: vi.fn(async () => outputs) },
    } as unknown as Services
    admission = new AdmissionControl()
    source = await createArkadeRebalanceSource(services, driver, admission)
  })

  afterEach(async () => {
    await source.close?.()
    await driver.close()
  })

  const lightningDeposit = (amountSats = 1_020, network = 'bcrt'): RebalanceDeposit => {
    const paymentHash = new Uint8Array(32).fill(8)
    return {
      ...deposit,
      kind: 'lightning',
      destination: forgeInvoice({ network, amountSats, paymentHash, timestamp: timestamp(), expirySeconds: 3_600 }),
      paymentHash: hex.encode(paymentHash),
    }
  }

  const mockRequest = (receiving: RebalanceDeposit) =>
    mocks.request.mockResolvedValue({
      rfqId: 'rfq-1',
      address: lockupAddress,
      fundAmount: 1_040,
      refundAddress,
      swapPkScript: ArkAddress.decode(lockupAddress).pkScript,
      script: {},
      secrets: {
        descriptor: 'public-descriptor',
        pkScript: ArkAddress.decode(refundAddress).pkScript,
        address: refundAddress,
      },
      quote: {
        solver_pubkey: 'bb'.repeat(32),
        valid_until: timestamp() + 60,
        refund_locktime: timestamp() + 10_000,
        to_amount: receiving.amountSats,
        profile: { payment_hash: receiving.paymentHash },
      },
    })

  it('selects only enough asset-free unpinned coins and includes receiving fees in the cap', async () => {
    coins = [coin('1', 2_000), coin('2', 7_000, true), coin('3', 9_000), coin('4', 1_500)]
    const release = services.arkade.reservations.reserve([coins[2]!])
    const quote = await source.quote(deposit, policy)
    expect(quote.inputs).toEqual([{ txid: coins[0]!.txid, vout: 0, value: 2_000 }])
    expect(quote.debitSats).toBe(1_030)
    expect(quote.feeSats).toBe(30)
    expect(services.arkade.wallet.getSpendableVtxos).toHaveBeenCalledWith({ withRecoverable: false })
    const capped = rowFrom(await source.quote(deposit, { ...policy, maxFeeSats: 29 }))
    await expect(source.reserve(capped, { ...policy, maxFeeSats: 29 })).rejects.toThrow(/fee/)
    release()
  })

  it('rejects another Bitcoin network before source quoting', async () => {
    const destination = Address(ONCHAIN_NETWORKS.bitcoin).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(1) })
    await expect(source.quote({ ...deposit, destination }, policy)).rejects.toThrow()
    expect(mocks.route).not.toHaveBeenCalled()
  })

  it('adds a named input instead of leaving unspendable change', async () => {
    coins = [coin('1', 1_050), coin('2', 500)]
    const quote = await source.quote(deposit, { ...policy, reserveSats: 0 })
    expect(quote.inputs).toHaveLength(2)
  })

  it('does not initialize RFQ network observers for an empty journal', () => {
    expect(services.arkade.wallet.getContractManager).not.toHaveBeenCalled()
    expect(services.arkade.wallet.indexerProvider.getVtxos).not.toHaveBeenCalled()
    expect(mocks.managerRepositories).toHaveLength(0)
  })

  it('starts with abandoned unfunded quotes even when their indexer is offline', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    await source.quote(receiving, policy)
    vi.mocked(services.arkade.wallet.indexerProvider.getVtxos).mockRejectedValue(new Error('indexer offline'))
    await source.close?.()
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(services.arkade.wallet.indexerProvider.getVtxos).not.toHaveBeenCalled()
    expect(services.arkade.wallet.getContractManager).not.toHaveBeenCalled()
  })

  it('keeps the source reserve and unfunded obligations out of available surplus', async () => {
    services.readers = [{ committedSats: async () => 2_100 }] as unknown as Services['readers']
    await expect(source.quote(deposit, policy)).rejects.toThrow(/surplus/)
  })

  it('drops the stored RFQ when the source cannot cover a Lightning quote', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    services.readers = [{ committedSats: async () => 2_100 }] as unknown as Services['readers']
    await expect(source.quote(receiving, policy)).rejects.toThrow(/surplus/)
    expect(await driver.all('SELECT * FROM rebalance_rfq')).toEqual([])
  })

  it('pins exact inputs before asynchronous revalidation and releases both holds', async () => {
    const row = rowFrom(await source.quote(deposit, policy))
    mocks.route.mockImplementationOnce(async ({ amount }: { amount: number }) => {
      expect(services.arkade.reservations.reserved().has(`${row.inputs[0]!.txid}:0`)).toBe(true)
      return { amount, total: amount + 10 }
    })
    const release = await source.reserve(row, policy)
    expect(admission.outstandingInventorySats('arkade')).toBe(row.debitSats)
    expect(await source.submit(row)).toBe(txid)
    expect(
      mocks.route.mock.calls.at(-1)![0].selectedVtxos.map((input: NormalizedExtendedVirtualCoin) => input.txid),
    ).toEqual(row.inputs.map((input) => input.txid))
    release()
    release()
    expect(services.arkade.reservations.reserved().size).toBe(0)
    expect(admission.outstandingInventorySats('arkade')).toBe(0)
  })

  it('refuses higher fees and missing inputs without an unnamed top-up', async () => {
    const row = rowFrom(await source.quote(deposit, policy))
    sourceFee = 11
    await expect(source.reserve(row, policy)).rejects.toThrow(/debit changed/)
    expect(services.arkade.reservations.reserved().size).toBe(0)
    sourceFee = 10
    const release = await source.reserve(row, policy)
    sourceFee = 11
    await expect(source.submit(row)).rejects.toThrow(/debit changed/)
    sourceFee = 10
    coins = [coin('2', 8_000)]
    await expect(source.submit(row)).rejects.toThrow(/no longer spendable/)
    expect(send).not.toHaveBeenCalled()
    release()
  })

  it('unconditionally restores missing source coin and amount holds', async () => {
    const row = rowFrom(await source.quote(deposit, policy))
    coins = []
    const release = await source.reserve(row, policy, true)
    expect(services.arkade.reservations.reserved().has(`${row.inputs[0]!.txid}:0`)).toBe(true)
    expect(admission.outstandingInventorySats('arkade')).toBe(row.debitSats)
    expect(services.arkade.wallet.getSpendableVtxos).toHaveBeenCalledTimes(1)
    release()
  })

  it('never resends after a timeout or invents absence from missing evidence', async () => {
    const row = rowFrom(await source.quote(deposit, policy))
    const release = await source.reserve(row, policy)
    send.mockRejectedValueOnce(new Error('timeout'))
    await expect(source.submit(row)).rejects.toThrow('timeout')
    expect(await source.reconcile(row)).toEqual({ state: 'unknown' })
    expect(await source.reconcile({ ...row, fundingTxid: txid })).toEqual({ state: 'unknown' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(admission.outstandingInventorySats('arkade')).toBe(row.debitSats)
    release()
  })

  it('requires destination amount and explicit input settlement metadata together', async () => {
    const row = rowFrom(await source.quote(deposit, policy))
    outputs = [{ txid, vout: 0, valueSats: deposit.amountSats, confirmations: 0 }]
    expect(await source.reconcile(row)).toEqual({ state: 'unknown' })
    indexerCoins = row.inputs.map((input) => ({ ...input, settledBy: txid }))
    expect(await source.reconcile(row)).toEqual({ state: 'submitted', fundingTxid: txid })
    outputs.push({ txid: 'dd'.repeat(32), vout: 0, valueSats: deposit.amountSats, confirmations: 0 })
    expect(await source.reconcile(row)).toEqual({ state: 'unknown' })
  })

  it('rejects self counterparties, invoice amounts, and invoice networks before requesting', async () => {
    const receiving = lightningDeposit()
    await expect(
      source.quote(receiving, {
        ...policy,
        counterparty: { ...policy.counterparty!, solverPubkey: services.providerPubkey },
      }),
    ).rejects.toThrow(/another solver/)
    await expect(source.quote(lightningDeposit(1_000), policy)).rejects.toThrow(/amount/)
    await expect(source.quote(lightningDeposit(1_020, 'bc'), policy)).rejects.toThrow(/network/)
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('also refuses a quote whose actual contract signer is this solver', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const request = await mocks.request()
    mocks.request.mockResolvedValue({
      ...request,
      quote: { ...request.quote, solver_pubkey: `02${services.providerPubkey}` },
    })
    await expect(source.quote(receiving, policy)).rejects.toThrow(/another solver/)
    expect(await driver.all('SELECT * FROM rebalance_rfq')).toEqual([])
    expect(services.arkade.wallet.send).not.toHaveBeenCalled()
  })

  it('persists public RFQ recovery before funding and restores only funded records', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    expect(row.feeSats).toBe(50)
    const stored = await driver.get<{ record_json: string }>('SELECT record_json FROM rebalance_rfq WHERE rfq_id = ?', [
      'rfq-1',
    ])
    expect(JSON.parse(stored!.record_json).profile.signer).toEqual({ signingDescriptor: 'public-descriptor' })
    expect(stored!.record_json).not.toMatch(/preimage|privateKey|mnemonic/)
    await source.close?.()
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(mocks.restoreIds.flat()).toEqual([])
    const release = await source.reserve(row, policy)
    expect(await source.submit(row)).toBe(txid)
    expect(services.arkade.wallet.send).toHaveBeenCalledWith({
      recipients: [{ address: lockupAddress, amount: 1_040 }],
      selectedVtxos: [coins[0]],
    })
    expect(mocks.managerAdd).toHaveBeenCalledTimes(1)
    release()
    await source.close?.()
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(mocks.restoreIds.at(-1)).toEqual(['rfq-1'])
    expect(services.arkade.wallet.send).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('leaves Lightning timeout funding quarantined across restart without refunding an empty quote', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    const release = await source.reserve(row, policy)
    vi.mocked(services.arkade.wallet.send).mockRejectedValueOnce(new Error('timeout'))
    await expect(source.submit(row)).rejects.toThrow('timeout')
    expect(await source.reconcile(row)).toEqual({ state: 'unknown' })
    expect(mocks.managerAdd).not.toHaveBeenCalled()
    await source.close?.()
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(mocks.restoreIds.flat()).toEqual([])
    expect(services.arkade.wallet.send).toHaveBeenCalledTimes(1)
    release()
  })

  it('requires actual refund transaction output evidence beyond manager status', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    const funding = new Transaction()
    funding.addInput({
      txid: row.inputs[0]!.txid,
      index: row.inputs[0]!.vout,
      witnessUtxo: { amount: 2_000n, script: Uint8Array.of(0x51) },
    })
    funding.addOutput({ amount: 1_040n, script: ArkAddress.decode(lockupAddress).pkScript })
    const refund = new Transaction()
    refund.addInput({
      txid: funding.id,
      index: 0,
      witnessUtxo: { amount: 1_040n, script: ArkAddress.decode(lockupAddress).pkScript },
    })
    refund.addOutput({ amount: 1_040n, script: ArkAddress.decode(refundAddress).pkScript })
    indexerCoins = row.inputs.map((input) => ({ ...input, arkTxId: funding.id }))
    vi.mocked(services.arkade.wallet.indexerProvider.getVirtualTxs).mockImplementation(async (ids) => ({
      txs: ids.includes(funding.id) ? [base64.encode(funding.toPSBT())] : [],
    }))
    const stored = await driver.get<{ record_json: string }>('SELECT record_json FROM rebalance_rfq WHERE rfq_id = ?', [
      'rfq-1',
    ])
    const record = {
      ...JSON.parse(stored!.record_json),
      state: 'refunded',
      fundingArkTxid: funding.id,
      refundArkTxid: refund.id,
    }
    await driver.run('UPDATE rebalance_rfq SET record_json = ? WHERE rfq_id = ?', [JSON.stringify(record), 'rfq-1'])
    expect(await source.reconcile(row)).toEqual({ state: 'submitted', fundingTxid: funding.id })
    vi.mocked(services.arkade.wallet.indexerProvider.getVirtualTxs).mockImplementation(async (ids) => ({
      txs: ids.includes(funding.id)
        ? [base64.encode(funding.toPSBT())]
        : ids.includes(refund.id)
          ? [base64.encode(refund.toPSBT())]
          : [],
    }))
    expect(await source.reconcile(row)).toEqual({ state: 'refunded' })
  })

  it.each([
    ['failed', 'open'],
    ['refunded', 'open'],
    ['failed', 'early'],
    ['failed', 'foreign'],
    ['failed', 'spent'],
    ['failed', 'swept'],
    ['failed', 'unrolled'],
  ] as const)('recovers SDK %s only with eligible %s lockup evidence', async (initialState, condition) => {
    const real = await vi.importActual<typeof import('@arkade-os/swap')>('@arkade-os/swap')
    const paymentHash = hex.encode(new Uint8Array(32).fill(8))
    const script = new VHTLC.ScriptV2({
      sender: schnorr.getPublicKey(new Uint8Array(32).fill(3)),
      receiver: schnorr.getPublicKey(new Uint8Array(32).fill(4)),
      server: schnorr.getPublicKey(new Uint8Array(32).fill(5)),
      preimageHash: ripemd160(hex.decode(paymentHash)),
      refundLocktime: BigInt(
        condition === 'early' ? timestamp() + 600 : timestamp() - real.REFUND_MTP_LAG_SECONDS - 10,
      ),
      unilateralClaimDelay: { type: 'seconds', value: 512n },
      unilateralRefundDelay: { type: 'seconds', value: 1024n },
      unilateralRefundWithoutReceiverDelay: { type: 'seconds', value: 1536n },
    })
    const recoveryAddress = new ArkAddress(script.options.server, script.pkScript.slice(2), 'tark').encode()
    const params = VHTLCV2ContractHandler.serializeParams(script.options)
    const watch = vi.fn().mockResolvedValue(undefined)
    vi.mocked(services.arkade.wallet.getContractManager).mockResolvedValue({
      getContracts: vi.fn().mockResolvedValue([{ params }]),
      createContract: vi.fn().mockResolvedValue({}),
      setContractWatchState: watch,
      onContractEvent: () => () => {},
    } as unknown as Awaited<ReturnType<Services['arkade']['wallet']['getContractManager']>>)
    mocks.realManager = true
    mocks.rebuild.mockImplementation((record) => real.rebuildRfqSwap(record, params))
    const row = {
      ...rowFrom(await source.quote(deposit, policy), lightningDeposit()),
      routeData: { rfqId: 'rfq-recovery' },
    }
    const funding = new Transaction()
    funding.addInput({
      txid: row.inputs[0]!.txid,
      index: 0,
      witnessUtxo: { amount: 2_000n, script: Uint8Array.of(0x51) },
    })
    funding.addOutput({ amount: 1_040n, script: script.pkScript })
    const refund = new Transaction()
    refund.addInput({ txid: funding.id, index: 0, witnessUtxo: { amount: 1_040n, script: script.pkScript } })
    refund.addOutput({ amount: 1_040n, script: ArkAddress.decode(refundAddress).pkScript })
    const stored: RfqSwapRecord = {
      kind: 'lightning_send',
      rfqId: 'rfq-recovery',
      lockupAddress: recoveryAddress,
      fundingArkTxid: funding.id,
      amount: 1_040,
      state: initialState,
      createdAt: timestamp() - 20_000,
      updatedAt: timestamp(),
      failure: 'previous refund failure',
      profile: { signer: { signingDescriptor: 'public-descriptor' }, hashlock: { paymentHash }, refundAddress },
    }
    await driver.run('INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)', [
      stored.rfqId,
      JSON.stringify(stored),
      1_040,
      timestamp() - 19_000,
    ])
    vi.mocked(services.arkade.wallet.indexerProvider.getVtxos).mockImplementation(async (query) => ({
      vtxos: ('scripts' in query!
        ? [
            {
              txid: funding.id,
              vout: 0,
              value: 1_040,
              script: hex.encode(script.pkScript),
              isSpent: condition === 'spent',
              isSwept: condition === 'swept',
              isUnrolled: condition === 'unrolled',
            },
          ]
        : row.inputs.map((input) => ({ ...input, arkTxId: funding.id }))) as never,
    }))
    let refundVisible = false
    vi.mocked(services.arkade.wallet.indexerProvider.getVirtualTxs).mockImplementation(async (ids) => ({
      txs: ids.includes(funding.id)
        ? [base64.encode(funding.toPSBT())]
        : refundVisible && ids.includes(refund.id)
          ? [base64.encode(refund.toPSBT())]
          : [],
    }))
    mocks.refund
      .mockRejectedValueOnce(new Error('temporary refund transport failure'))
      .mockResolvedValue({ arkTxid: refund.id, amount: 1_040 })
    if (condition !== 'open') {
      if (condition === 'foreign') mocks.signer.mockRejectedValueOnce(new Error('missing local refund signer'))
      await expect(source.reconcile(row)).rejects.toThrow(
        condition === 'early'
          ? 'not yet eligible'
          : condition === 'foreign'
            ? 'missing local refund signer'
            : 'remains unresolved',
      )
      expect(mocks.refund).not.toHaveBeenCalled()
      expect(services.arkade.wallet.send).not.toHaveBeenCalled()
      return
    }
    await expect(source.reconcile(row)).rejects.toThrow('temporary refund transport failure')
    expect(mocks.refund).toHaveBeenCalledTimes(1)
    expect((await mocks.actualManagers[0]!.getStats()).monitoredSwaps).toBe(0)
    const failed = await driver.get<{ record_json: string }>('SELECT record_json FROM rebalance_rfq WHERE rfq_id = ?', [
      stored.rfqId,
    ])
    expect(JSON.parse(failed!.record_json)).toMatchObject({
      state: 'failed',
      fundingArkTxid: funding.id,
      failure: 'temporary refund transport failure',
    })
    expect(await source.reconcile(row)).toEqual({ state: 'submitted', fundingTxid: funding.id })
    expect(mocks.refund).toHaveBeenCalledTimes(2)
    refundVisible = true
    expect(await source.reconcile(row)).toEqual({ state: 'refunded' })
    expect(mocks.refund).toHaveBeenCalledTimes(2)
    expect(watch).toHaveBeenCalledWith(hex.encode(script.pkScript), 'watched')
    expect(mocks.signer).toHaveBeenCalledTimes(2)
    expect(services.arkade.wallet.send).not.toHaveBeenCalled()
    expect(mocks.request).not.toHaveBeenCalled()
  })
})
