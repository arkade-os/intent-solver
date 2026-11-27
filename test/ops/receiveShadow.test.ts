import { hex } from '@scure/base'
import { sha256 } from '@noble/hashes/sha2.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createReceiveShadow, type ReceiveShadowDeps } from '@arkade-os/solver-app/ops/receiveShadow.js'
import type { ReceiveAction } from '@arkade-os/solver-core/core/receivePlan.js'
import type { HoldState } from '@arkade-os/solver-core/ports/lightning.js'
import type { ReceiveSwapRow } from '@arkade-os/solver-corridors/db/receiveSwaps.js'

const PREIMAGE = '11'.repeat(32)
const HASH = hex.encode(sha256(hex.decode(PREIMAGE)))
const QUOTED_AT = 1_800_000_000
const MINUTE = 60

const row = (override: Partial<ReceiveSwapRow> = {}): ReceiveSwapRow => ({
  id: 'swap-1',
  state: 'armed',
  createdAt: QUOTED_AT,
  updatedAt: QUOTED_AT + 60,
  paymentHash: HASH,
  amountSats: 5_000,
  payoutSats: 4_950,
  invoice: 'lnbcrt-secret-invoice',
  invoiceWalletFingerprint: null,
  invoiceBackendName: null,
  invoiceExpiresAt: QUOTED_AT + 30 * MINUTE,
  htlcExpiresAt: QUOTED_AT + 240 * MINUTE,
  payoutAddress: 'tark1payout',
  payoutPkScript: '51',
  payoutPubkey: '02',
  claimPacket: null,
  refundLocktime: QUOTED_AT + 120 * MINUTE,
  solverPubkey: '03',
  serverPubkey: '04',
  claimDelay: 512,
  refundDelay: 1024,
  refundWithoutReceiverDelay: 1024,
  emulatorPubkey: '05',
  pkScript: '5120aa',
  lockupAddress: 'tark1lockup',
  solverRefundPkScript: '52',
  nonInteractiveParameters: true,
  fundStartedAt: null,
  arkadeLockupTxid: null,
  arkadeLockupVout: null,
  arkadeLockupValue: null,
  settleAttemptedAt: null,
  preimage: null,
  refundArkTxid: null,
  unrolledRefund: null,
  failureReason: null,
  rfqId: null,
  ...override,
})

let lines: string[]
let asked: string[]
let hold: HoldState | Error
let lockups: { txid: string; vout: number; value: number; spent: boolean; unrolled: boolean }[]
let coupled: unknown

const shadow = (override: Partial<ReceiveShadowDeps> = {}) =>
  createReceiveShadow({
    ln: {
      getHoldState: async () => {
        asked.push('hold')
        if (hold instanceof Error) throw hold
        return hold
      },
    },
    arkade: {
      findLockups: async () => (asked.push('findLockups'), lockups.filter((o) => !o.spent)),
      findLockupOutpoints: async () => (asked.push('findLockupOutpoints'), lockups),
      findClaimPreimage: async () => (asked.push('findClaimPreimage'), null),
    },
    coupledSend: async () => coupled,
    now: () => QUOTED_AT + 5 * MINUTE,
    acceptUnilateralGap: false,
    log: (line) => lines.push(line),
    ...override,
  })

beforeEach(() => {
  lines = []
  asked = []
  hold = { status: 'armed', expiresAt: QUOTED_AT + 240 * MINUTE }
  lockups = []
  coupled = null
})

const FUND: ReceiveAction = { do: 'fund', coupled: false }

describe('the Lightning receive shadow', () => {
  it('says nothing when the new model decides what today decided', async () => {
    const it = shadow()
    await it.compare(row(), FUND)
    expect(lines).toEqual([])
    expect(it.counts()).toEqual({ compared: 1, same: 1, different: 0, skipped: 0, failed: 0 })
  })

  it('logs one line when they differ, with both steps and both reasons', async () => {
    hold = { status: 'armed', expiresAt: QUOTED_AT + 60 * MINUTE }
    const it = shadow()
    await it.compare(row(), FUND)
    expect(lines).toEqual([
      'receive_shadow_diff {"swapId":"swap-1","state":"armed","old":"fund","next":"fail","nextReason":"refused to fund: settle_window_too_short"}',
    ])
    expect(it.counts()).toMatchObject({ compared: 1, different: 1 })
  })

  it('logs a row that keeps differing the same way once, and counts it every time', async () => {
    hold = { status: 'armed', expiresAt: QUOTED_AT + 60 * MINUTE }
    const it = shadow()
    await it.compare(row(), FUND)
    await it.compare(row(), FUND)
    expect(lines).toHaveLength(1)
    expect(it.counts()).toMatchObject({ compared: 2, different: 2 })
  })

  it('counts a different reason for the same step as a difference', async () => {
    hold = { status: 'pending', expiresAt: null }
    await shadow().compare(row(), { do: 'fail', reason: 'refused to fund: invoice_expired' })
    expect(lines[0]).toContain('"oldReason":"refused to fund: invoice_expired"')
    expect(lines[0]).toContain('"nextReason":"refused to fund: htlc_not_armed"')
  })

  it('never puts the preimage, the invoice or the payment hash in a line', async () => {
    lockups = [{ txid: 'pay', vout: 0, value: 4_950, spent: false, unrolled: false }]
    const claimed = row({ state: 'claimed', preimage: PREIMAGE, arkadeLockupTxid: 'pay', arkadeLockupVout: 0 })
    await shadow().compare(claimed, { do: 'wait' })
    await shadow().compare(row(), { do: 'record_claim', preimage: PREIMAGE })
    expect(lines).toHaveLength(2)
    for (const line of lines) {
      expect(line).not.toContain(PREIMAGE)
      expect(line).not.toContain(HASH)
      expect(line).not.toContain('lnbcrt')
    }
  })

  it('leaves out a payment between two of our own clients', async () => {
    const it = shadow()
    await it.compare(row(), { do: 'fund', coupled: true })
    await it.compare(row({ state: 'quoted' }), { do: 'arm_coupled' })
    await it.compare(row({ state: 'claimed' }), { do: 'record_settled' })
    coupled = { id: 'send-1' }
    await it.compare(row(), { do: 'wait' })
    await it.compare(row(), { do: 'wait' }, { coupledSend: { state: 'funded' } as never })
    expect(it.counts()).toEqual({ compared: 0, same: 0, different: 0, skipped: 5, failed: 0 })
    expect(asked).toEqual([])
  })

  it('answers the new model from what today read, and reads nothing twice', async () => {
    const funded = row({ state: 'funded', arkadeLockupTxid: 'pay', arkadeLockupVout: 0 })
    const ours = { txid: 'pay', vout: 0, value: 4_950, spent: true, unrolled: false }
    const it = shadow()
    await it.compare(
      funded,
      { do: 'record_claim', preimage: PREIMAGE },
      {
        spendable: [],
        claim: { history: [ours], preimage: PREIMAGE },
        history: [ours],
        refundOpen: false,
      },
    )
    expect(asked).toEqual([])
    expect(it.counts()).toMatchObject({ compared: 1, same: 1 })
  })

  it('passes on a refund the server finished only when today asked for it', async () => {
    const refunding = row({ state: 'refunding', arkadeLockupTxid: 'pay', arkadeLockupVout: 0 })
    const spent = [{ txid: 'pay', vout: 0, value: 4_950, spent: true, unrolled: false }]
    const seen = { spendable: [], claim: { history: spent, preimage: null }, history: spent }
    const it = shadow({ now: () => QUOTED_AT + 121 * MINUTE })
    await it.compare(refunding, { do: 'record_refund', txid: 'refund-tx' }, { ...seen, ownRefund: 'refund-tx' })
    expect(it.counts()).toMatchObject({ compared: 1, same: 1 })
    expect(lines).toEqual([])
  })

  it('logs a count every five hundred rows', async () => {
    const it = shadow()
    for (let i = 0; i < 500; i++) await it.compare(row(), { do: 'fund', coupled: true })
    expect(lines).toEqual(['receive_shadow {"compared":0,"same":0,"different":0,"skipped":500,"failed":0}'])
  })

  it('never throws: a failure is counted and logged, with what failed', async () => {
    hold = new Error('node unreachable')
    const it = shadow()
    await expect(it.compare(row(), FUND)).resolves.toBeUndefined()
    expect(it.counts()).toMatchObject({ compared: 0, failed: 1 })
    expect(lines).toEqual(['receive_shadow_failed {"swapId":"swap-1","state":"armed","error":"node unreachable"}'])
  })

  it('survives a row it cannot read as a swap, and a lookup that fails', async () => {
    const it = shadow({
      coupledSend: async () => {
        throw new Error('store closed')
      },
    })
    await it.compare(row(), FUND)
    await shadow().compare(row({ paymentHash: 'not-a-hash' }), FUND)
    expect(lines.map((line) => line.split(' ')[0])).toEqual(['receive_shadow_failed', 'receive_shadow_failed'])
  })

  it('only reads', async () => {
    lockups = [{ txid: 'pay', vout: 0, value: 4_950, spent: true, unrolled: false }]
    const funded = { arkadeLockupTxid: 'pay', arkadeLockupVout: 0 }
    await shadow().compare(row({ state: 'funded', ...funded }), { do: 'wait' })
    await shadow().compare(row({ state: 'refunding', ...funded }), { do: 'wait' })
    await shadow().compare(row({ state: 'claimed', ...funded, preimage: PREIMAGE }), { do: 'settle' })
    expect(new Set(asked)).toEqual(new Set(['findLockups', 'findLockupOutpoints', 'findClaimPreimage']))
  })
})
