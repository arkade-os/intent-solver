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
import type { RfqSwapRecordStore, RfqSwapManagerDeps, RfqSwapManager, RfqSwapRecord } from '@arkade-os/swap/protocol'
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
vi.mock('@arkade-os/swap/protocol', async (importOriginal) => {
  const real = await importOriginal<typeof import('@arkade-os/swap/protocol')>()
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
        const page = await this.deps.repository!.getRfqSwapsPage({}, { limit: 500 })
        mocks.restoreIds.push(page.items.map((record) => record.rfqId))
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
        operatorUrl: 'https://operator.example',
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
    capped.origin = 'automatic'
    await expect(source.reserve(capped, { ...policy, maxFeeSats: 29 })).rejects.toThrow(/fee/)
    release()
  })

  it('authorizes a reviewed manual debit beyond automatic limits while retaining its exact source bound', async () => {
    coins = [coin('1', 3_000_000)]
    sourceFee = 14_759
    const receiving = { ...deposit, netSats: 2_000_000, amountSats: 2_001_000, feeSats: 1000 }
    const limits = { ...policy, reserveSats: 2_000_000, maxFeeSats: 500, maxFeeBps: 20, maxDebitSats: 500_500 }
    await expect(source.quote(receiving, limits)).rejects.toThrow(/surplus/)
    const row = rowFrom(await source.quote(receiving, limits, 'manual'), receiving)
    expect(row.debitSats).toBe(2_015_759)
    const release = await source.reserve(row, limits)
    sourceFee += 1
    await expect(source.submit(row)).rejects.toThrow(/debit changed/)
    expect(send).not.toHaveBeenCalled()
    sourceFee -= 1
    expect(await source.submit(row)).toBe(txid)
    release()
  })

  it.each(['manual', 'automatic'] as const)(
    'chooses six older inputs over one expensive input for %s refill',
    async (origin) => {
      const older = new Date('2026-11-10T00:00:00Z')
      const newer = new Date('2026-12-20T00:00:00Z')
      coins = [
        { ...coin('f', 7_278_590), expiresAt: newer },
        ...Array.from({ length: 6 }, (_, i) => ({ ...coin(String(i + 1), 90_207), expiresAt: older })),
      ]
      mocks.route.mockImplementation(async ({ amount, selectedVtxos }) => {
        const fee = selectedVtxos.some((input: NormalizedExtendedVirtualCoin) => input.txid === coins[0]!.txid)
          ? 14_757
          : 200
        return { amount, total: amount + fee, fee, send }
      })
      const receiving = { ...deposit, amountSats: 500_500, netSats: 500_000, feeSats: 500 }
      const quote = await source.quote(receiving, policy, origin)
      expect(quote.inputs).toEqual(coins.slice(1).map(({ txid, vout, value }) => ({ txid, vout, value })))
      expect(quote.debitSats).toBe(500_700)
      expect(quote.feeSats).toBe(700)
      expect(send).not.toHaveBeenCalled()
      const row = { ...rowFrom(quote, receiving), origin }
      const limits = { ...policy, maxDebitSats: 600_000, maxFeeSats: 800 }
      const release = await source.reserve(row, limits)
      expect(await source.submit(row)).toBe(txid)
      expect(mocks.route.mock.lastCall?.[0].selectedVtxos).toEqual(coins.slice(1))
      expect(send).toHaveBeenCalledTimes(1)
      release()
    },
  )

  it('keeps the smaller selection when older inputs quote a higher fee', async () => {
    coins = [coin('1', 2_000), { ...coin('2', 1_500), expiresAt: new Date('2026-11-10') }]
    mocks.route.mockImplementation(async ({ amount, selectedVtxos }) => {
      const fee = selectedVtxos[0].txid === coins[0]!.txid ? 10 : 20
      return { amount, total: amount + fee, fee, send }
    })
    const quote = await source.quote(deposit, policy)
    expect(quote.inputs[0]!.txid).toBe(coins[0]!.txid)
    expect(quote.debitSats).toBe(1_030)
  })

  it('can quote an alternative input set after a preview failure without sending either set', async () => {
    coins = [coin('1', 2_000), { ...coin('2', 1_500), expiresAt: new Date('2026-11-10') }]
    mocks.route.mockImplementation(async ({ amount, selectedVtxos }) => {
      if (selectedVtxos[0].txid === coins[0]!.txid) throw new Error('TX_TOO_LARGE: proof weight exceeds limit')
      return { amount, total: amount + 10, fee: 10, send }
    })
    const quote = await source.quote(deposit, policy)
    expect(quote.inputs[0]!.txid).toBe(coins[1]!.txid)
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a transfer requiring more than 50 inputs without sending', async () => {
    coins = Array.from({ length: 60 }, (_, i) => ({ ...coin('1', 100), vout: i }))
    await expect(source.quote({ ...deposit, amountSats: 5_100, netSats: 5_080 }, policy, 'manual')).rejects.toThrow(
      /50 input limit/,
    )
    expect(mocks.route).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('never grows a fee-short selection beyond 50 inputs', async () => {
    coins = Array.from({ length: 60 }, (_, i) => ({ ...coin('1', 100), vout: i }))
    sourceFee = 100
    await expect(source.quote({ ...deposit, amountSats: 4_950, netSats: 4_930 }, policy, 'manual')).rejects.toThrow(
      /50 input limit/,
    )
    expect(mocks.route).toHaveBeenCalledTimes(1)
    expect(mocks.route.mock.lastCall?.[0].selectedVtxos).toHaveLength(50)
    expect(send).not.toHaveBeenCalled()
  })

  it('surfaces a rejected proof-size quote without claiming a transfer or sending', async () => {
    mocks.route.mockRejectedValue(new Error('TX_TOO_LARGE: proof weight exceeds limit'))
    await expect(source.quote(deposit, policy)).rejects.toThrow(/TX_TOO_LARGE/)
    expect(send).not.toHaveBeenCalled()
    expect(services.arkade.reservations.reserved().size).toBe(0)
  })

  it('manual transfers cannot consume outstanding payouts or inventory reserved for customer quotes', async () => {
    const limits = { ...policy, reserveSats: 10_000 }
    const row = rowFrom(await source.quote(deposit, limits, 'manual'))
    const readers = services.readers
    services.readers = [{ committedSats: async () => 2500 }] as unknown as Services['readers']
    await expect(source.quote(deposit, limits, 'manual')).rejects.toThrow(/surplus/)
    await expect(source.reserve(row, limits)).rejects.toThrow(/surplus/)
    expect(services.arkade.reservations.reserved().size).toBe(0)
    services.readers = readers
    const customer = await admission.reserveInventory('arkade', 2500, 3500, async () => 0)
    await expect(source.quote(deposit, limits, 'manual')).rejects.toThrow(/surplus/)
    await expect(source.reserve(row, limits)).rejects.toThrow(/surplus/)
    expect(send).not.toHaveBeenCalled()
    customer?.release()
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

  it('keeps submitted inputs pinned without charging inventory while a later quote uses another coin', async () => {
    const row = rowFrom(await source.quote(deposit, policy, 'manual'))
    expect(() => source.pinPendingInputs({ ...row, inputs: [] })).toThrow(/no valid source inputs/)
    const releaseFull = await source.reserve(row, policy)
    const releasePending = source.pinPendingInputs(row)
    releaseFull()
    expect(admission.outstandingInventorySats('arkade')).toBe(0)
    expect(services.arkade.reservations.reserved().has(`${row.inputs[0]!.txid}:0`)).toBe(true)
    expect((await source.quote(deposit, policy, 'manual')).inputs[0]!.txid).not.toBe(row.inputs[0]!.txid)
    releasePending()
    expect(services.arkade.reservations.reserved().size).toBe(0)
  })

  it('keeps a terminal source input protected until a fresh wallet snapshot omits it', async () => {
    const row = rowFrom(await source.quote(deposit, policy, 'manual'))
    const other = { ...row, id: 'other', inputs: [{ txid: 'ff'.repeat(32), vout: 0, value: 1000 }] }
    vi.mocked(services.arkade.wallet.getSpendableVtxos).mockClear()
    const absent = await source.inputsAbsent([row, other])
    expect([...absent]).toEqual(['other'])
    expect(services.arkade.wallet.getSpendableVtxos).toHaveBeenCalledTimes(1)
    coins = coins.filter((coin) => coin.txid !== row.inputs[0]!.txid)
    expect((await source.inputsAbsent([row])).has(row.id)).toBe(true)
    vi.mocked(services.arkade.wallet.getSpendableVtxos).mockRejectedValueOnce(new Error('indexer offline'))
    await expect(source.inputsAbsent([row])).rejects.toThrow('indexer offline')
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
    expect(await source.reconcile({ ...row, fundingTxid: txid })).toEqual({ state: 'submitted', fundingTxid: txid })
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

  it('restores funded records at startup behind an older abandoned unfunded quote', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    const release = await source.reserve(row, policy)
    expect(await source.submit(row)).toBe(txid)
    release()
    const funded = await driver.get<{ record_json: string }>('SELECT record_json FROM rebalance_rfq WHERE rfq_id = ?', [
      'rfq-1',
    ])
    const { fundingTxid: _, ...unfunded } = JSON.parse(funded!.record_json) as RfqSwapRecord
    await driver.run('INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)', [
      'rfq-0',
      JSON.stringify({ ...unfunded, rfqId: 'rfq-0', state: 'quoted', updatedAt: 1 }),
      1_040,
      1,
    ])
    await source.close?.()
    mocks.restoreIds.length = 0
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(mocks.restoreIds).toEqual([['rfq-1']])
  })

  it('leaves a funded record to the daemon when built passive', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    const release = await source.reserve(row, policy)
    expect(await source.submit(row)).toBe(txid)
    release()
    await source.close?.()
    mocks.restoreIds.length = 0
    vi.mocked(services.arkade.wallet.getContractManager).mockClear()
    source = await createArkadeRebalanceSource(services, driver, admission, 'passive')
    expect(mocks.restoreIds).toEqual([])
    expect(services.arkade.wallet.getContractManager).not.toHaveBeenCalled()
  })

  it('restores a funded record stored under the pre-0.1.0 field names', async () => {
    const receiving = lightningDeposit()
    mockRequest(receiving)
    const row = rowFrom(await source.quote(receiving, policy), receiving)
    const release = await source.reserve(row, policy)
    expect(await source.submit(row)).toBe(txid)
    release()
    const funded = await driver.get<{ record_json: string }>('SELECT record_json FROM rebalance_rfq WHERE rfq_id = ?', [
      'rfq-1',
    ])
    const { fundingTxid, ...rest } = JSON.parse(funded!.record_json) as RfqSwapRecord
    await driver.run('UPDATE rebalance_rfq SET record_json = ? WHERE rfq_id = ?', [
      JSON.stringify({ ...rest, fundingArkTxid: fundingTxid }),
      'rfq-1',
    ])
    await source.close?.()
    mocks.restoreIds.length = 0
    source = await createArkadeRebalanceSource(services, driver, admission)
    expect(mocks.restoreIds).toEqual([['rfq-1']])
    const record = await mocks.managerRepositories.at(-1)!.getRfqSwap('rfq-1')
    expect(record).toMatchObject({ fundingTxid: txid })
    expect(record).not.toHaveProperty('fundingArkTxid')
  })

  it('pages same-timestamp records in the code-unit order its cursor resumes from', async () => {
    // localeCompare puts 'rfq-a' first; the cursor's `>` puts 'rfq-B' first, so a
    // mismatched sort would return one id twice and drop the other.
    for (const rfqId of ['rfq-a', 'rfq-B'])
      await driver.run(
        'INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)',
        [rfqId, JSON.stringify({ rfqId, state: 'pending', updatedAt: 100, fundingTxid: txid }), 1_040, 1],
      )
    await source.close?.()
    source = await createArkadeRebalanceSource(services, driver, admission)
    const repository = mocks.managerRepositories.at(-1)!
    const first = await repository.getRfqSwapsPage({}, { limit: 1 })
    const second = await repository.getRfqSwapsPage({}, { limit: 1, after: first.nextCursor })
    expect([...first.items, ...second.items].map((record) => record.rfqId)).toEqual(['rfq-B', 'rfq-a'])
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
      fundingTxid: funding.id,
      refundTxid: refund.id,
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
    const real = await vi.importActual<typeof import('@arkade-os/swap/protocol')>('@arkade-os/swap/protocol')
    const paymentHash = hex.encode(new Uint8Array(32).fill(8))
    const script = new VHTLC.ScriptV2({
      sender: schnorr.getPublicKey(new Uint8Array(32).fill(3)),
      receiver: schnorr.getPublicKey(new Uint8Array(32).fill(4)),
      server: schnorr.getPublicKey(new Uint8Array(32).fill(5)),
      preimageHash: ripemd160(hex.decode(paymentHash)),
      // 2 hours: @arkade-os/swap's own REFUND_MTP_LAG_SECONDS, unexported (arkade-os/ts-sdk#1095).
      refundLocktime: BigInt(condition === 'early' ? timestamp() + 600 : timestamp() - 2 * 60 * 60 - 10),
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
      fundingTxid: funding.id,
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
      .mockResolvedValue({ txid: refund.id, amount: 1_040 })
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
      fundingTxid: funding.id,
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
