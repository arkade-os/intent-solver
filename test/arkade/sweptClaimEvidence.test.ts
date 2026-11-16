import { describe, expect, it, vi } from 'vitest'
import type { IndexerProvider, VirtualCoin } from '@arkade-os/sdk'
import {
  parseSweptClaimJournal,
  verifySweptClaimCommitment,
  type SweptClaimJournal,
} from '@arkade-os/solver-arkade/arkade/sweptClaimEvidence.js'

const LOCKUP_SCRIPT = '5120' + 'aa'.repeat(32)
const PAYOUT_SCRIPT = '5120' + 'bb'.repeat(32)
const COMMITMENT = 'cc'.repeat(32)
const FUNDING = { txid: '11'.repeat(32), vout: 0, value: 1007 }
const PAYOUT = { txid: '22'.repeat(32), vout: 0, value: 1007 }

const journal = (over: Partial<SweptClaimJournal> = {}): SweptClaimJournal => ({
  intentId: 'intent-1',
  proofTxid: '33'.repeat(32),
  registeredAt: 1_700_000_000,
  fundingOutpoints: [FUNDING],
  lockupPkScript: LOCKUP_SCRIPT,
  recipientPkScript: PAYOUT_SCRIPT,
  expectedSats: 1007,
  commitmentTxid: COMMITMENT,
  payoutOutpoints: [PAYOUT],
  ...over,
})

const coin = (outpoint: typeof FUNDING, script: string, over: Partial<VirtualCoin> = {}): VirtualCoin =>
  ({
    txid: outpoint.txid,
    vout: outpoint.vout,
    value: outpoint.value,
    script,
    status: {},
    createdAt: new Date(),
    isUnrolled: false,
    ...over,
  }) as VirtualCoin

const funding = (over: Partial<VirtualCoin> = {}) =>
  coin(FUNDING, LOCKUP_SCRIPT, { isSwept: true, settledBy: COMMITMENT, spentBy: '', ...over })
const payout = (over: Partial<VirtualCoin> = {}) =>
  coin(PAYOUT, PAYOUT_SCRIPT, { commitmentTxIds: [COMMITMENT], ...over })

const indexerWith = (rows: VirtualCoin[]) => {
  const getVtxos = vi.fn(async ({ outpoints }: { outpoints: { txid: string; vout: number }[] }) => ({
    vtxos: rows.filter((row) => outpoints.some((point) => row.txid === point.txid && row.vout === point.vout)),
  }))
  return { indexer: { getVtxos } as unknown as Pick<IndexerProvider, 'getVtxos'>, getVtxos }
}

describe('swept claim commitment evidence', () => {
  it('decodes each journal stage and rejects malformed persisted evidence', () => {
    const registered = journal({ commitmentTxid: undefined, payoutOutpoints: undefined })
    const prepared = { ...registered, intentId: null, deleteProof: 'AQIDBA==' }
    expect(parseSweptClaimJournal(JSON.stringify(prepared))).toEqual(prepared)
    expect(parseSweptClaimJournal(JSON.stringify(registered))).toEqual(registered)
    const withDeleteProof = { ...registered, deleteProof: 'AQIDBA==' }
    expect(parseSweptClaimJournal(JSON.stringify(withDeleteProof))).toEqual(withDeleteProof)
    expect(parseSweptClaimJournal(JSON.stringify(journal()))).toEqual(journal())
    expect(() => parseSweptClaimJournal(JSON.stringify({ ...registered, deleteProof: '' }))).toThrow()
    expect(() => parseSweptClaimJournal(JSON.stringify({ ...registered, deleteProof: 'AQIDBA=' }))).toThrow()
    expect(() => parseSweptClaimJournal(JSON.stringify({ ...registered, deleteProof: 'AQID BA==' }))).toThrow()
    expect(() => parseSweptClaimJournal(JSON.stringify(journal({ payoutOutpoints: undefined })))).toThrow()
    expect(() =>
      parseSweptClaimJournal(JSON.stringify(journal({ recipientPkScript: LOCKUP_SCRIPT.slice(2) }))),
    ).toThrow()
    expect(() => parseSweptClaimJournal(JSON.stringify(journal({ registeredAt: 0 })))).toThrow()
  })

  it('proves the exact funded inputs and payout in the validated batch', async () => {
    const { indexer } = indexerWith([funding(), payout()])
    await expect(verifySweptClaimCommitment(indexer, journal())).resolves.toEqual({
      status: 'claimed',
      commitmentTxid: COMMITMENT,
    })
  })

  it('waits for a validated commitment and for missing indexer facts', async () => {
    const { indexer, getVtxos } = indexerWith([funding()])
    await expect(verifySweptClaimCommitment(indexer, journal({ commitmentTxid: undefined }))).resolves.toEqual({
      status: 'pending',
    })
    expect(getVtxos).not.toHaveBeenCalled()
    await expect(verifySweptClaimCommitment(indexer, journal())).resolves.toEqual({ status: 'pending' })
    await expect(verifySweptClaimCommitment(indexer, journal({ intentId: null }))).resolves.toEqual({
      status: 'pending',
    })
    await expect(verifySweptClaimCommitment(indexerWith([payout()]).indexer, journal())).resolves.toEqual({
      status: 'pending',
    })
    await expect(
      verifySweptClaimCommitment(indexerWith([funding(), payout({ commitmentTxIds: [] })]).indexer, journal()),
    ).resolves.toEqual({ status: 'pending' })
  })

  it('does not mistake a competing spend or unrelated payout for a claim', async () => {
    const competing = indexerWith([funding({ settledBy: 'dd'.repeat(32) }), payout()])
    await expect(verifySweptClaimCommitment(competing.indexer, journal())).resolves.toMatchObject({
      status: 'conflict',
    })
    const wrongPayout = indexerWith([funding(), payout({ script: LOCKUP_SCRIPT })])
    await expect(verifySweptClaimCommitment(wrongPayout.indexer, journal())).resolves.toMatchObject({
      status: 'conflict',
    })
    const wrongBatch = indexerWith([funding(), payout({ commitmentTxIds: ['ee'.repeat(32)] })])
    await expect(verifySweptClaimCommitment(wrongBatch.indexer, journal())).resolves.toMatchObject({
      status: 'conflict',
    })
  })

  it('refuses inconsistent journal values before reading the indexer', async () => {
    const { indexer, getVtxos } = indexerWith([funding(), payout()])
    await expect(verifySweptClaimCommitment(indexer, journal({ expectedSats: 1006 }))).resolves.toMatchObject({
      status: 'conflict',
    })
    expect(getVtxos).not.toHaveBeenCalled()
  })
})
