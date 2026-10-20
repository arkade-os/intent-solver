import {
  ArkAddress,
  PaymentRouter,
  Transaction,
  arkRail,
  onchainRail,
  isVtxoSpent,
  type NormalizedExtendedVirtualCoin,
  type RouteQuote,
} from '@arkade-os/sdk'
import {
  arkadeRefunder,
  createRfqSwapRecord,
  lockupContractParams,
  rebuildRfqSwap,
  requestLightningSend,
  rfqSecretsProfile,
  rfqSignerOf,
  senderIdentityForSwapRecord,
  RfqSwapManager,
  type RfqSwapRecord,
  type RfqSwapRecordStore,
} from '@arkade-os/swap'
import { nostrRfqTransport } from '@arkade-os/swap/nostr'
import { base64, hex } from '@scure/base'
import { Address } from '@scure/btc-signer'
import type { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import type { SqlDriver } from '@arkade-os/solver-core/core/driver.js'
import { NETWORKS } from '@arkade-os/solver-core/core/networks.js'
import { checkRebalanceFees } from '@arkade-os/solver-core/core/rebalancePolicy.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'
import type { RebalanceDeposit, RebalancePolicy, RebalanceTransfer } from '@arkade-os/solver-core/ports/rebalance.js'
import { outpointKey } from '@arkade-os/solver-arkade/arkade/lockupFunding.js'
import { ONCHAIN_NETWORKS } from '@arkade-os/solver-rails/onchain/htlc.js'
import { arkadeFundingOwed } from './pool.js'
import type { RebalanceSource } from './rebalance.js'
import type { Services } from './services.js'

const now = (): number => Math.floor(Date.now() / 1000)
const validTxid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
const sum = (coins: readonly { value: number }[]): number => coins.reduce((total, coin) => total + coin.value, 0)
const wholeSats = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid source debit')
}

interface StoredRfq {
  record: RfqSwapRecord
  fundAmount: number
  validUntil: number
}

class RebalanceRfqRepository implements RfqSwapRecordStore {
  constructor(private readonly driver: SqlDriver) {}

  async init(): Promise<void> {
    await this.driver.exec(
      'CREATE TABLE IF NOT EXISTS rebalance_rfq (rfq_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, fund_amount INTEGER NOT NULL, valid_until INTEGER NOT NULL)',
    )
  }

  async create(value: StoredRfq): Promise<void> {
    await this.driver.run(
      'INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)',
      [value.record.rfqId, JSON.stringify(value.record), value.fundAmount, value.validUntil],
    )
  }

  async stored(id: string): Promise<StoredRfq | undefined> {
    const row = await this.driver.get<{ record_json: string; fund_amount: number; valid_until: number }>(
      'SELECT record_json, fund_amount, valid_until FROM rebalance_rfq WHERE rfq_id = ?',
      [id],
    )
    return (
      row && {
        record: JSON.parse(row.record_json) as RfqSwapRecord,
        fundAmount: row.fund_amount,
        validUntil: row.valid_until,
      }
    )
  }

  async saveRfqSwap(record: RfqSwapRecord): Promise<void> {
    const result = await this.driver.run('UPDATE rebalance_rfq SET record_json = ? WHERE rfq_id = ?', [
      JSON.stringify(record),
      record.rfqId,
    ])
    if (result.changes !== 1) throw new Error('rebalance recovery origin is missing')
  }

  async getRfqSwap(id: string): Promise<RfqSwapRecord | undefined> {
    return (await this.stored(id))?.record
  }
  async getAllRfqSwaps(): Promise<RfqSwapRecord[]> {
    return (await this.driver.all<{ record_json: string }>('SELECT record_json FROM rebalance_rfq')).map(
      (row) => JSON.parse(row.record_json) as RfqSwapRecord,
    )
  }
  async removeRfqSwap(id: string): Promise<void> {
    await this.driver.run('DELETE FROM rebalance_rfq WHERE rfq_id = ?', [id])
  }
}

export const createArkadeRebalanceSource = async (
  services: Services,
  driver: SqlDriver,
  admission: AdmissionControl,
): Promise<RebalanceSource> => {
  const { wallet, reservations } = services.arkade
  const repository = new RebalanceRfqRepository(driver)
  await repository.init()
  const held = new Map<string, NormalizedExtendedVirtualCoin[]>()
  const indexer = wallet.indexerProvider
  const owed = (): Promise<number> => arkadeFundingOwed(services.readers)
  const snapshot = async (): Promise<NormalizedExtendedVirtualCoin[]> =>
    (await wallet.getSpendableVtxos({ withRecoverable: false })).filter((coin) => !coin.assets?.length)
  const lockupCoins = async (record: RfqSwapRecord) =>
    (await indexer.getVtxos({ scripts: [hex.encode(ArkAddress.decode(record.lockupAddress).pkScript)] })).vtxos
  const managerRepository: RfqSwapRecordStore = {
    saveRfqSwap: (record) => repository.saveRfqSwap(record),
    getRfqSwap: (id) => repository.getRfqSwap(id),
    removeRfqSwap: (id) => repository.removeRfqSwap(id),
    getAllRfqSwaps: async () => {
      return (await repository.getAllRfqSwaps()).filter((record) => validTxid(record.fundingArkTxid))
    },
  }
  let managerStack:
    Promise<{ manager: RfqSwapManager; contracts: Awaited<ReturnType<typeof wallet.getContractManager>> }> | undefined
  const ensureManager = () => {
    managerStack ??= (async () => {
      const contracts = await wallet.getContractManager()
      const manager = new RfqSwapManager({ indexer, contracts, repository: managerRepository })
      manager.setCallbacks({ refundArkade: arkadeRefunder({ ark: wallet.arkProvider, wallet, contracts, repository }) })
      const restored = await manager.restoreFromRepository()
      if (restored.failed.length) throw new Error('rebalance RFQ recovery could not restore a funded contract')
      await manager.start()
      return { manager, contracts }
    })().catch((error) => {
      managerStack = undefined
      throw error
    })
    return managerStack
  }
  if ((await managerRepository.getAllRfqSwaps()).length) await ensureManager()

  const routerQuote = (
    destination: string,
    amount: number,
    coins: NormalizedExtendedVirtualCoin[],
    kind: 'onchain' | 'ark',
  ): Promise<RouteQuote> => {
    const router = new PaymentRouter({ wallet, prefs: {} })
    router.use(
      kind === 'ark' ? arkRail() : onchainRail({ feeInfo: async () => (await wallet.arkProvider.getInfo()).fees }),
    )
    return router.route({ raw: destination, amount, selectedVtxos: coins })
  }

  const selectQuote = async (
    destination: string,
    amount: number,
    kind: 'onchain' | 'ark',
    candidates: NormalizedExtendedVirtualCoin[],
  ) => {
    const minimumChange = Math.max(Number(services.arkade.dustSats ?? 330n), Number(services.arkade.vtxoMinSats ?? 0n))
    const sorted = [...candidates].sort(
      (a, b) => b.value - a.value || outpointKey(a.txid, a.vout).localeCompare(outpointKey(b.txid, b.vout)),
    )
    const selected: NormalizedExtendedVirtualCoin[] = []
    for (const coin of sorted) {
      selected.push(coin)
      if (sum(selected) < amount) continue
      const quote = await routerQuote(destination, amount, selected, kind)
      wholeSats(quote.total)
      if (quote.amount !== amount || quote.total < amount)
        throw new Error('source rail quoted a different payment amount')
      const change = sum(selected) - quote.total
      if (change === 0 || change >= minimumChange) return { quote, selected }
    }
    throw new Error('insufficient unreserved asset-free source inventory')
  }

  const storedRfq = async (row: RebalanceTransfer): Promise<StoredRfq> => {
    const id = row.routeData?.rfqId
    if (typeof id !== 'string') throw new Error('rebalance recovery origin is missing')
    const value = await repository.stored(id)
    if (!value) throw new Error('rebalance recovery origin is missing')
    return value
  }

  const currentQuote = async (row: RebalanceTransfer, coins: NormalizedExtendedVirtualCoin[]): Promise<RouteQuote> => {
    const rfq = row.deposit.kind === 'lightning' ? await storedRfq(row) : undefined
    if (rfq && rfq.validUntil <= now()) throw new Error('external source quote expired')
    const quote = await routerQuote(
      rfq?.record.lockupAddress ?? row.deposit.destination,
      rfq?.fundAmount ?? row.deposit.amountSats,
      coins,
      rfq ? 'ark' : 'onchain',
    )
    wholeSats(quote.total)
    if (
      quote.amount !== (rfq?.fundAmount ?? row.deposit.amountSats) ||
      quote.total > row.debitSats ||
      quote.total < row.deposit.amountSats ||
      sum(coins) < quote.total
    )
      throw new Error('source debit changed; request another preview')
    return quote
  }

  const exactInputs = (
    row: RebalanceTransfer,
    coins: NormalizedExtendedVirtualCoin[],
  ): NormalizedExtendedVirtualCoin[] => {
    const byKey = new Map(coins.map((coin) => [outpointKey(coin.txid, coin.vout), coin]))
    if (
      !row.inputs.length ||
      new Set(row.inputs.map((input) => outpointKey(input.txid, input.vout))).size !== row.inputs.length
    )
      throw new Error('invalid source input selection')
    return row.inputs.map((input) => {
      const coin = byKey.get(outpointKey(input.txid, input.vout))
      if (!coin || coin.value !== input.value) throw new Error('source input no longer spendable')
      return coin
    })
  }

  const inputEvidence = async (row: RebalanceTransfer) => {
    const { vtxos } = await indexer.getVtxos({ outpoints: row.inputs.map(({ txid, vout }) => ({ txid, vout })) })
    const byKey = new Map(vtxos.map((coin) => [outpointKey(coin.txid, coin.vout), coin]))
    return row.inputs.map((input) => byKey.get(outpointKey(input.txid, input.vout)))
  }

  const proveArkOutput = async (txid: string, address: string, amount: number): Promise<boolean> => {
    const script = hex.encode(ArkAddress.decode(address).pkScript)
    const { txs } = await indexer.getVirtualTxs([txid])
    for (const raw of txs) {
      const tx = Transaction.fromPSBT(base64.decode(raw))
      if (tx.id !== txid) continue
      for (let i = 0; i < tx.outputsLength; i++) {
        const output = tx.getOutput(i)
        if (output.script && hex.encode(output.script) === script && output.amount === BigInt(amount)) return true
      }
    }
    return false
  }

  const proveRefund = async (record: RfqSwapRecord, amount: number): Promise<boolean> => {
    const address = record.profile.refundAddress
    if (typeof address !== 'string') return false
    for (const txid of [...new Set([record.refundArkTxid, ...(record.lockupSpendArkTxids ?? [])].filter(validTxid))]) {
      if (await proveArkOutput(txid, address, amount)) return true
    }
    return false
  }

  return {
    async quote(deposit: RebalanceDeposit, policy: RebalancePolicy) {
      let destination = deposit.destination
      let amount = deposit.amountSats
      let kind: 'onchain' | 'ark' = 'onchain'
      let expiresAt = now() + 60
      let routeData: Record<string, unknown> | undefined
      if (deposit.kind === 'onchain') Address(ONCHAIN_NETWORKS[services.config.network]).decode(destination)
      else {
        const counterparty = policy.counterparty
        if (!counterparty || !/^[0-9a-f]{64}$/i.test(counterparty.solverPubkey) || !counterparty.relays.length)
          throw new Error('configure an external Lightning counterparty')
        if (counterparty.solverPubkey.toLowerCase() === services.providerPubkey.toLowerCase())
          throw new Error('rebalance counterparty must be another solver')
        const invoice = decodeInvoice(destination)
        if (invoice.network !== NETWORKS[services.config.network].invoicePrefix)
          throw new Error('rebalance invoice is for another network')
        if (
          invoice.amountSats !== deposit.amountSats ||
          (deposit.paymentHash && deposit.paymentHash !== invoice.paymentHash)
        )
          throw new Error('rebalance invoice amount or hash does not match deposit')
        if (invoice.expiresAt <= now()) throw new Error('rebalance invoice expired')
        const transport = nostrRfqTransport(counterparty)
        try {
          const request = await requestLightningSend(wallet, services.arkade.arkServerUrl, transport, {
            invoice: {
              raw: destination,
              paymentHash: invoice.paymentHash,
              amountSats: invoice.amountSats,
              expiresAt: invoice.expiresAt,
            },
          })
          if (
            request.quote.solver_pubkey.toLowerCase().replace(/^(02|03)(?=[0-9a-f]{64}$)/, '') ===
            services.providerPubkey.toLowerCase()
          )
            throw new Error('rebalance counterparty must be another solver')
          wholeSats(request.fundAmount)
          if (
            request.fundAmount < amount ||
            request.quote.profile.payment_hash !== invoice.paymentHash ||
            Number(request.quote.to_amount) !== amount
          )
            throw new Error('external source quote does not match deposit')
          expiresAt = Math.min(expiresAt, request.quote.valid_until, invoice.expiresAt)
          if (
            !Number.isSafeInteger(expiresAt) ||
            expiresAt <= now() ||
            !Number.isSafeInteger(request.quote.refund_locktime)
          )
            throw new Error('external source quote expired or lacks recovery deadline')
          const time = now()
          const record = createRfqSwapRecord(
            {
              kind: 'lightning_send',
              lockupAddress: request.address,
              amount: request.fundAmount,
              profile: {
                ...rfqSecretsProfile(request.secrets, invoice.paymentHash),
                refundAddress: request.refundAddress,
              },
            },
            {
              kind: 'lightning_send',
              rfqId: request.rfqId,
              state: 'pending',
              lockupPkScript: request.swapPkScript,
              lockup: { script: request.script, address: request.address },
              paymentHash: invoice.paymentHash,
              refundLocktime: request.quote.refund_locktime!,
              createdAt: time,
              updatedAt: time,
            },
          )
          await repository.create({ record, fundAmount: request.fundAmount, validUntil: expiresAt })
          destination = request.address
          amount = request.fundAmount
          kind = 'ark'
          routeData = { rfqId: request.rfqId }
        } finally {
          transport.close?.()
        }
      }
      try {
        const coins = await snapshot()
        const pinned = reservations.reserved()
        const candidates = coins.filter((coin) => !pinned.has(outpointKey(coin.txid, coin.vout)))
        const { quote, selected } = await selectQuote(destination, amount, kind, candidates)
        if (
          quote.total + policy.reserveSats + (await owed()) + admission.outstandingInventorySats('arkade') >
          sum(candidates)
        )
          throw new Error('source reserve or outstanding payouts leave insufficient surplus')
        return {
          debitSats: quote.total,
          feeSats: quote.total - deposit.netSats,
          inputs: selected.map(({ txid, vout, value }) => ({ txid, vout, value })),
          expiresAt,
          routeData,
        }
      } catch (error) {
        // No transfer row references this RFQ yet, so it can never be funded. Not a time-based
        // sweep: a funded lockup whose txid was never recorded also has no fundingArkTxid.
        if (routeData) await repository.removeRfqSwap(routeData.rfqId as string)
        throw error
      }
    },

    async reserve(row, policy, restoring = false) {
      if (restoring) {
        const releaseInputs = reservations.reserve(row.inputs)
        const balance = admission.restoreInventory('arkade', row.debitSats)
        return () => {
          releaseInputs()
          balance.release()
          held.delete(row.id)
        }
      }
      checkRebalanceFees(policy, row.netSats, row.debitSats)
      if (row.debitSats > policy.maxDebitSats || row.feeSats !== row.debitSats - row.netSats)
        throw new Error('invalid approved source debit')
      const coins = await snapshot()
      const selected = exactInputs(row, coins)
      const pinned = reservations.reserved()
      if (selected.some((coin) => pinned.has(outpointKey(coin.txid, coin.vout))))
        throw new Error('source inputs are reserved')
      const releaseInputs = reservations.reserve(selected)
      try {
        await currentQuote(row, selected)
        const available =
          sum(coins.filter((coin) => !pinned.has(outpointKey(coin.txid, coin.vout)))) - policy.reserveSats
        const balance = await admission.reserveInventory('arkade', row.debitSats, available, owed)
        if (!balance) throw new Error('source reserve or outstanding payouts leave insufficient surplus')
        held.set(row.id, selected)
        return () => {
          releaseInputs()
          balance.release()
          held.delete(row.id)
        }
      } catch (error) {
        releaseInputs()
        throw error
      }
    },

    async submit(row) {
      if (!held.has(row.id)) throw new Error('source inputs must be reserved before submission')
      const selected = exactInputs(row, await snapshot())
      const quote = await currentQuote(row, selected)
      if (row.expiresAt <= now()) throw new Error('rebalance quote expired')
      let txid: string | undefined
      if (row.deposit.kind === 'onchain') txid = (await (await quote.send()).settled()).txid
      else {
        const { manager, contracts } = await ensureManager()
        const stored = await storedRfq(row)
        const record = stored.record
        if (record.fundingArkTxid) throw new Error('source funding already recorded')
        if (stored.validUntil <= now() || row.expiresAt <= now()) throw new Error('external source quote expired')
        txid = await wallet.send({
          recipients: [{ address: record.lockupAddress, amount: stored.fundAmount }],
          selectedVtxos: selected,
        })
        if (validTxid(txid)) {
          await repository.saveRfqSwap({ ...record, fundingArkTxid: txid, state: 'pending', updatedAt: now() })
          await manager.addSwap(
            rebuildRfqSwap(
              { ...record, fundingArkTxid: txid, state: 'pending' },
              await lockupContractParams(contracts, record.lockupAddress),
            ),
          )
        }
      }
      if (!validTxid(txid))
        throw new Error('source submission returned no valid transaction id; reconciliation required')
      return txid
    },

    async reconcile(row) {
      if (row.deposit.kind === 'onchain') {
        if (!services.onchain) return { state: 'unknown' }
        const evidence = await inputEvidence(row)
        const outputs = (await services.onchain.findOutputs({ address: row.deposit.destination })).filter(
          (output) => output.valueSats === row.deposit.amountSats && validTxid(output.txid),
        )
        if (outputs.length !== 1) return { state: 'unknown' }
        const txid = outputs[0]!.txid
        if (row.fundingTxid && row.fundingTxid !== txid) return { state: 'unknown' }
        if (!evidence.length || evidence.some((coin) => !coin || coin.settledBy !== txid)) return { state: 'unknown' }
        return { state: 'submitted', fundingTxid: txid }
      }
      const stored = await storedRfq(row)
      let record = stored.record
      const lockup = await lockupCoins(record)
      const source = await inputEvidence(row)
      const possible = [
        ...new Set(source.flatMap((coin) => (coin?.arkTxId && validTxid(coin.arkTxId) ? [coin.arkTxId] : []))),
      ]
      const funding = record.fundingArkTxid ?? row.fundingTxid ?? (possible.length === 1 ? possible[0] : undefined)
      const proven =
        funding &&
        source.length === row.inputs.length &&
        source.every((coin) => coin?.arkTxId === funding) &&
        (await proveArkOutput(funding, record.lockupAddress, stored.fundAmount))
      if (proven && (await proveRefund(record, stored.fundAmount))) return { state: 'refunded' }
      if (proven && !record.fundingArkTxid) {
        record = { ...record, fundingArkTxid: funding, state: 'pending', updatedAt: now() }
        await repository.saveRfqSwap(record)
      }
      if (proven || lockup.length) {
        const { manager, contracts } = await ensureManager()
        const script = hex.encode(ArkAddress.decode(record.lockupAddress).pkScript)
        const refundable =
          proven &&
          lockup.some(
            (coin) =>
              coin.txid === funding &&
              coin.value === stored.fundAmount &&
              coin.script === script &&
              !isVtxoSpent(coin) &&
              !coin.isSwept &&
              !coin.isUnrolled,
          )
        if ((record.state === 'failed' || record.state === 'refunded') && refundable && !record.refundArkTxid) {
          const rebuilt = rebuildRfqSwap(record, await lockupContractParams(contracts, record.lockupAddress))
          if (rebuilt.kind !== 'lightning_send' || now() < rebuilt.refundLocktime)
            throw new Error('source refund is not yet eligible')
          await senderIdentityForSwapRecord(wallet, rfqSignerOf(record) ?? {})
          if (await manager.isProcessing(record.rfqId)) throw new Error('source refund recovery is still running')
          await manager.removeSwap(record.rfqId)
          record = { ...record, state: 'pending', updatedAt: now() }
          delete record.failure
          delete record.blockedReason
          await repository.saveRfqSwap(record)
          await contracts.setContractWatchState(script, 'watched')
        }
        if (!(await manager.hasSwap(record.rfqId)))
          await manager.addSwap(rebuildRfqSwap(record, await lockupContractParams(contracts, record.lockupAddress)))
        await manager.poll()
        record = (await repository.getRfqSwap(record.rfqId))!
      }
      if (proven && (await proveRefund(record, stored.fundAmount))) return { state: 'refunded' }
      if (record.state === 'failed')
        throw new Error(`source refund remains unresolved: ${record.failure ?? 'recovery required'}`)
      return proven ? { state: 'submitted', fundingTxid: funding } : { state: 'unknown' }
    },
    close: async () => {
      if (managerStack) await (await managerStack).manager.stop()
    },
  }
}
