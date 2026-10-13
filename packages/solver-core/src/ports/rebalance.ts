export type DepositKind = 'onchain' | 'lightning'

export interface RebalanceDeposit {
  kind: DepositKind
  destination: string
  amountSats: number
  netSats: number
  feeSats: number
  expiresAt?: number
  paymentHash?: string
  data?: Record<string, unknown>
}

export interface RebalanceReceipt {
  state: 'pending' | 'credited' | 'failed'
  netSats?: number
  feeSats?: number
  reason?: string
}

export interface RebalancePool {
  id: string
  label: string
  kinds: readonly DepositKind[]
  readBalance(): Promise<number>
  prepare(kind: DepositKind, netSats: number, maxFeeSats: number): Promise<RebalanceDeposit>
  receipt(deposit: RebalanceDeposit, fundingTxid?: string): Promise<RebalanceReceipt>
}

export interface RebalanceBackend {
  pools(): Promise<readonly RebalancePool[]>
  protectDeposits?(read: () => Promise<readonly RebalanceTransfer[]>): void
  maintain?(): Promise<void>
}

export interface RebalancePolicy {
  enabled: boolean
  reserveSats: number
  maxDebitSats: number
  dailyDebitSats: number
  maxFeeSats: number
  maxFeeBps: number
  minTransferSats: number
  cooldownSeconds: number
  targets: Record<string, { minimumSats: number; targetSats: number }>
  counterparty?: { solverPubkey: string; relays: string[] }
}

export type RebalanceState =
  | 'quoted'
  | 'submitting'
  | 'pending'
  | 'needs_reconciliation'
  | 'refunding'
  | 'completed'
  | 'refunded'
  | 'failed'
  | 'cancelled'

export interface RebalanceTransfer {
  id: string
  requestKey: string
  origin: 'manual' | 'automatic'
  poolId: string
  netSats: number
  debitSats: number
  feeSats: number
  policyRevision: string
  createdAt: number
  updatedAt: number
  expiresAt: number
  chargedAt?: number
  state: RebalanceState
  deposit: RebalanceDeposit
  inputs: { txid: string; vout: number; value: number }[]
  routeData?: Record<string, unknown>
  fundingTxid?: string
  error?: string
  creditedSats?: number
}
