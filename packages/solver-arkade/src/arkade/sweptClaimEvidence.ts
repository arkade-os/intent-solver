import type { IndexerProvider, VirtualCoin } from '@arkade-os/sdk'
import { base64 } from '@scure/base'
import { vtxoPages } from './indexerPaging.js'

export interface ClaimBatchOutpoint {
  txid: string
  vout: number
  value: number
}

export interface SweptClaimJournal {
  intentId: string | null
  proofTxid: string
  registeredAt: number
  fundingOutpoints: ClaimBatchOutpoint[]
  lockupPkScript: string
  recipientPkScript: string
  expectedSats: number
  deleteProof?: string
  commitmentTxid?: string
  payoutOutpoints?: ClaimBatchOutpoint[]
}

export type SweptClaimEvidence =
  { status: 'pending' } | { status: 'claimed'; commitmentTxid: string } | { status: 'conflict'; reason: string }

const keyOf = (outpoint: { txid: string; vout: number }): string => `${outpoint.txid}:${outpoint.vout}`
const isTxid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isScript = (value: unknown): value is string => typeof value === 'string' && /^5120[0-9a-f]{64}$/.test(value)
const isCanonicalBase64 = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const decoded = base64.decode(value)
    return decoded.length > 0 && base64.encode(decoded) === value
  } catch {
    return false
  }
}
const isOutpoint = (value: unknown): value is ClaimBatchOutpoint => {
  if (typeof value !== 'object' || value === null) return false
  const point = value as Record<string, unknown>
  return (
    isTxid(point.txid) &&
    Number.isSafeInteger(point.vout) &&
    (point.vout as number) >= 0 &&
    Number.isSafeInteger(point.value) &&
    (point.value as number) > 0
  )
}

export const parseSweptClaimJournal = (raw: string): SweptClaimJournal => {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid swept claim journal')
  const value = parsed as Record<string, unknown>
  if (
    (value.intentId !== null && (typeof value.intentId !== 'string' || value.intentId.length === 0)) ||
    !isTxid(value.proofTxid) ||
    !Number.isSafeInteger(value.registeredAt) ||
    (value.registeredAt as number) <= 0 ||
    !Array.isArray(value.fundingOutpoints) ||
    value.fundingOutpoints.length === 0 ||
    !value.fundingOutpoints.every(isOutpoint) ||
    !isScript(value.lockupPkScript) ||
    !isScript(value.recipientPkScript) ||
    !Number.isSafeInteger(value.expectedSats) ||
    (value.expectedSats as number) <= 0 ||
    (value.deleteProof !== undefined && !isCanonicalBase64(value.deleteProof)) ||
    (value.intentId === null &&
      (value.deleteProof === undefined || value.commitmentTxid !== undefined || value.payoutOutpoints !== undefined)) ||
    (value.commitmentTxid !== undefined && !isTxid(value.commitmentTxid)) ||
    (value.payoutOutpoints !== undefined &&
      (!Array.isArray(value.payoutOutpoints) || !value.payoutOutpoints.every(isOutpoint))) ||
    (value.commitmentTxid === undefined) !== (value.payoutOutpoints === undefined)
  ) {
    throw new Error('invalid swept claim journal')
  }
  return value as unknown as SweptClaimJournal
}

const exactVtxos = async (
  indexer: Pick<IndexerProvider, 'getVtxos'>,
  outpoints: readonly ClaimBatchOutpoint[],
): Promise<Map<string, VirtualCoin> | null> => {
  const requested = new Set(outpoints.map(keyOf))
  const found = new Map<string, VirtualCoin>()
  for await (const page of vtxoPages(indexer, { outpoints: outpoints.map(({ txid, vout }) => ({ txid, vout })) })) {
    for (const coin of page) {
      const key = keyOf(coin)
      if (!requested.has(key) || found.has(key)) return null
      found.set(key, coin)
    }
  }
  return found
}

export const verifySweptClaimCommitment = async (
  indexer: Pick<IndexerProvider, 'getVtxos'>,
  journal: SweptClaimJournal,
): Promise<SweptClaimEvidence> => {
  const { commitmentTxid, payoutOutpoints, fundingOutpoints, lockupPkScript, recipientPkScript, expectedSats } = journal
  if (journal.intentId === null) return { status: 'pending' }
  if (!commitmentTxid || !payoutOutpoints?.length) return { status: 'pending' }
  if (
    fundingOutpoints.length === 0 ||
    !Number.isSafeInteger(expectedSats) ||
    expectedSats <= 0 ||
    [...fundingOutpoints, ...payoutOutpoints].some(
      (output) =>
        !Number.isSafeInteger(output.vout) ||
        output.vout < 0 ||
        !Number.isSafeInteger(output.value) ||
        output.value <= 0,
    ) ||
    fundingOutpoints.reduce((sum, output) => sum + output.value, 0) !== expectedSats ||
    payoutOutpoints.reduce((sum, output) => sum + output.value, 0) !== expectedSats ||
    new Set([...fundingOutpoints, ...payoutOutpoints].map(keyOf)).size !==
      fundingOutpoints.length + payoutOutpoints.length
  ) {
    return { status: 'conflict', reason: 'batch claim journal has inconsistent outpoints or value' }
  }

  const inputs = await exactVtxos(indexer, fundingOutpoints)
  if (!inputs) return { status: 'conflict', reason: 'indexer returned conflicting funding outpoints' }
  let pending = false
  for (const expected of fundingOutpoints) {
    const coin = inputs.get(keyOf(expected))
    if (!coin) {
      pending = true
      continue
    }
    if (coin.value !== expected.value || coin.script !== lockupPkScript || coin.spentBy || coin.isUnrolled) {
      return { status: 'conflict', reason: `funding outpoint ${keyOf(expected)} changed before batch claim` }
    }
    if (coin.settledBy && coin.settledBy !== commitmentTxid) {
      return { status: 'conflict', reason: `funding outpoint ${keyOf(expected)} settled in another batch` }
    }
    if (!coin.settledBy) pending = true
  }
  if (pending) return { status: 'pending' }

  const payouts = await exactVtxos(indexer, payoutOutpoints)
  if (!payouts) return { status: 'conflict', reason: 'indexer returned conflicting payout outpoints' }
  pending = false
  for (const expected of payoutOutpoints) {
    const coin = payouts.get(keyOf(expected))
    if (!coin) {
      pending = true
      continue
    }
    if (coin.value !== expected.value || coin.script !== recipientPkScript || (coin.assets ?? []).length > 0) {
      return { status: 'conflict', reason: `batch claim payout ${keyOf(expected)} changed` }
    }
    if (coin.commitmentTxIds?.length && !coin.commitmentTxIds.includes(commitmentTxid)) {
      return { status: 'conflict', reason: `batch claim payout ${keyOf(expected)} belongs to another batch` }
    }
    if (!coin.commitmentTxIds?.length) pending = true
  }
  if (pending) return { status: 'pending' }
  return { status: 'claimed', commitmentTxid }
}
