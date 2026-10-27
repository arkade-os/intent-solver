import { amountSatsOf, paymentHashOf } from '@arkade-os/solver-core/invoice/decode.js'
import type { LightningBackend } from '@arkade-os/solver-core/ports/lightning.js'
import type { OnchainSendBackend } from '@arkade-os/solver-core/ports/onchain.js'
import type {
  RebalanceBackend,
  RebalanceDeposit,
  RebalancePool,
  RebalanceReceipt,
} from '@arkade-os/solver-core/ports/rebalance.js'

const validateAmount = (netSats: number, maxFeeSats: number): void => {
  if (!Number.isSafeInteger(netSats) || netSats <= 0) throw new Error('net amount must be positive whole sats')
  if (!Number.isSafeInteger(maxFeeSats) || maxFeeSats < 0) throw new Error('fee cap must be nonnegative whole sats')
}

const invalidDeposit = (deposit: RebalanceDeposit, kind: 'onchain' | 'lightning'): boolean =>
  deposit.kind !== kind ||
  !deposit.destination ||
  !Number.isSafeInteger(deposit.netSats) ||
  deposit.netSats <= 0 ||
  deposit.amountSats !== deposit.netSats ||
  deposit.feeSats !== 0

export const createLndRebalanceBackend = (ln: LightningBackend, onchain: OnchainSendBackend): RebalanceBackend => {
  const onchainPool: RebalancePool = {
    id: 'rail:onchain',
    label: 'Onchain wallet',
    kinds: ['onchain'],
    readBalance: async () => (await onchain.getBalance()).confirmedSats,
    prepare: async (kind, netSats, maxFeeSats) => {
      validateAmount(netSats, maxFeeSats)
      if (kind !== 'onchain') throw new Error('unsupported deposit route for onchain pool')
      return { kind, destination: await onchain.newReceiveAddress(), amountSats: netSats, netSats, feeSats: 0 }
    },
    receipt: async (deposit, fundingTxid): Promise<RebalanceReceipt> => {
      if (invalidDeposit(deposit, 'onchain')) return { state: 'failed', reason: 'invalid onchain deposit' }
      if (!fundingTxid) return { state: 'pending' }
      const outputs = await onchain.findOutputs({ address: deposit.destination })
      const output = outputs.find(
        (candidate) =>
          candidate.txid === fundingTxid && candidate.valueSats === deposit.amountSats && candidate.confirmations >= 1,
      )
      return output ? { state: 'credited', netSats: output.valueSats, feeSats: 0 } : { state: 'pending' }
    },
  }
  const lightningPool: RebalancePool = {
    id: 'rail:lightning',
    label: 'Lightning channels',
    kinds: ['lightning'],
    readBalance: async () => (await ln.getBalance()).availableSats,
    prepare: async (kind, netSats, maxFeeSats) => {
      validateAmount(netSats, maxFeeSats)
      if (kind !== 'lightning') throw new Error('unsupported deposit route for lightning pool')
      if (!ln.createInvoice) throw new Error('plain deposit invoices unavailable')
      const created = await ln.createInvoice({ amountSats: netSats })
      if (amountSatsOf(created.invoice) !== netSats) throw new Error('deposit invoice amount does not match net amount')
      return {
        kind,
        destination: created.invoice,
        amountSats: netSats,
        netSats,
        feeSats: 0,
        expiresAt: created.expiresAt,
        paymentHash: paymentHashOf(created.invoice),
      }
    },
    receipt: async (deposit): Promise<RebalanceReceipt> => {
      if (invalidDeposit(deposit, 'lightning')) return { state: 'failed', reason: 'invalid lightning deposit' }
      try {
        if (
          amountSatsOf(deposit.destination) !== deposit.amountSats ||
          paymentHashOf(deposit.destination) !== deposit.paymentHash
        )
          return { state: 'failed', reason: 'deposit invoice identity mismatch' }
      } catch {
        return { state: 'failed', reason: 'invalid deposit invoice' }
      }
      const state = ln.getOwnInvoiceState
        ? await ln.getOwnInvoiceState(deposit.paymentHash!)
        : await ln.getHoldState(deposit.paymentHash!)
      if (!state) return { state: 'pending', reason: 'destination invoice record unavailable' }
      if (state.status === 'cancelled') return { state: 'failed', reason: 'destination invoice cancelled' }
      if (state.status !== 'settled') return { state: 'pending' }
      if (state.amountSats !== deposit.netSats)
        return { state: 'failed', reason: 'settled destination amount mismatch' }
      return { state: 'credited', netSats: state.amountSats, feeSats: 0 }
    },
  }
  return { pools: async () => [onchainPool, lightningPool] }
}
