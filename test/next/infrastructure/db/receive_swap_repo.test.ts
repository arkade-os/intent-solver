import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Conflict } from '@arkade-os/solver-next/domain/shared/error.js'
import { RfqId, SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { Hashlock } from '@arkade-os/solver-next/domain/swap/hashlock.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { ReceiveSwapRepository } from '@arkade-os/solver-next/infrastructure/db/receive_swap_repo.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { ref, SECRET, t } from '../../domain/support.js'

const ID = SwapId.of('swap-1')
const HASH = Hashlock.ofPreimage(SECRET)
const RFQ = 'ef'.repeat(32)

// Two databases with the same quote. The legacy store writes one, the new repository the other,
// and after every step both must hold the same rows.
interface Side {
  readonly db: Database.Database
  readonly legacy: ReceiveSwapStore
  readonly repo: ReceiveSwapRepository
}

let now: number
let dir: string
let old: Side
let next: Side

// A file, not `:memory:`: the test reads the rows through a second connection.
const open = async (name: string): Promise<Side> => {
  const path = join(dir, `${name}.sqlite`)
  const db = new Database(path)
  const driver = betterSqliteDriver(path)
  const legacy = await ReceiveSwapStore.open(driver, () => now)
  await legacy.insertQuote({
    id: ID,
    paymentHash: HASH,
    amountSats: 5_000,
    payoutSats: 4_950,
    invoice: 'lnbcrt1',
    invoiceExpiresAt: 2_000,
    payoutAddress: 'tark1',
    payoutPkScript: '51',
    payoutPubkey: '02',
    claimPacket: null,
    refundLocktime: 9_000,
    solverPubkey: '03',
    serverPubkey: '04',
    claimDelay: 1,
    refundDelay: 2,
    refundWithoutReceiverDelay: 3,
    emulatorPubkey: '05',
    pkScript: '5120aa',
    lockupAddress: 'tark1lockup',
    solverRefundPkScript: '52',
    nonInteractiveParameters: true,
    rfqId: RFQ,
  })
  return { db, legacy, repo: new ReceiveSwapRepository(driver, () => now) }
}

const rows = ({ db }: Side) => ({
  swaps: db.prepare('SELECT * FROM receive_swap ORDER BY id').all(),
  history: db.prepare('SELECT swap_id, at, from_state, to_state, detail FROM receive_swap_event ORDER BY id').all(),
})

/** One step: the legacy store does it its way, the repository through the domain, then the rows are compared. */
const step = async (legacy: (store: ReceiveSwapStore) => Promise<unknown>, change: (swap: Swap) => void) => {
  now += 1
  await legacy(old.legacy)
  await next.repo.update(ID, change)
  expect(rows(next)).toEqual(rows(old))
}

const armed = () =>
  step(
    (store) => store.transition(ID, 'quoted', 'armed', { htlc_expires_at: 5_000 }),
    (swap) => void swap.lock('from', t(now), ref(HASH), t(5_000)),
  )
const paying = () =>
  step(
    (store) => store.claimFundLease(ID, 'armed'),
    (swap) => void swap.locking('to', t(now)),
  )
const funded = () =>
  step(
    (store) =>
      store.transition(ID, 'armed', 'funded', {
        arkade_lockup_txid: 'lockup',
        arkade_lockup_vout: 1,
        arkade_lockup_value: 4_950,
      }),
    (swap) => void swap.lock('to', t(now), ref('lockup:1')),
  )

beforeEach(async () => {
  now = 1_000
  dir = mkdtempSync(join(tmpdir(), 'receive-swap-repo-'))
  old = await open('legacy')
  next = await open('next')
  expect(rows(next)).toEqual(rows(old))
})

afterEach(async () => {
  for (const side of [old, next]) {
    side.db.close()
    await side.legacy.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('receive_swap written through the repository', () => {
  it('writes the same rows as the legacy store, step by step to settled', async () => {
    await armed()
    await paying()
    await funded()
    await step(
      (store) => store.transition(ID, 'funded', 'claimed', { preimage: SECRET }),
      (swap) => void swap.claim('to', t(now), { preimage: SECRET }),
    )
    await step(
      (store) => store.patch(ID, { settle_attempted_at: now }),
      (swap) => void swap.claiming('from', t(now)),
    )
    await step(
      (store) => store.transition(ID, 'claimed', 'settled', {}),
      (swap) => void swap.claim('from', t(now)),
    )
    expect((await next.repo.get(ID))?.state).toBe('settled')
  })

  it('writes the same rows through a refund', async () => {
    await armed()
    await paying()
    await funded()
    await step(
      (store) => store.transition(ID, 'funded', 'refunding', {}),
      (swap) => void swap.refunding('to', t(now)),
    )
    await step(
      (store) => store.transition(ID, 'refunding', 'refunded', { refund_ark_txid: 'refund-tx' }),
      (swap) => void swap.refund('to', t(now), ref('refund-tx')),
    )
  })

  it('writes a refusal and a stuck swap as the legacy store does', async () => {
    await armed()
    await step(
      (store) => store.fail(ID, 'armed', 'refused to fund: invoice_expired'),
      (swap) => void swap.fail('refused', 'refused to fund: invoice_expired', t(now)),
    )
  })

  it('writes stuck once the payout is out', async () => {
    await armed()
    await paying()
    await funded()
    await step(
      (store) => store.fail(ID, 'funded', 'funded state with no funded outpoint recorded'),
      (swap) => void swap.fail('stuck', 'funded state with no funded outpoint recorded', t(now)),
    )
    expect((await next.repo.get(ID))?.to.state).toBe('locked')
  })

  it('gives the payout lease back when the payout was not sent', async () => {
    await armed()
    await paying()
    now += 1
    await old.legacy.releaseFundLease(ID)
    await next.repo.update(ID, (swap) => void swap.lockFailed('to', t(now)))
    // The legacy release does not touch `updated_at`; the repository always does, so a stale writer is refused.
    const { updated_at: _a, ...mine } = rows(next).swaps[0] as Record<string, unknown>
    const { updated_at: _b, ...theirs } = rows(old).swaps[0] as Record<string, unknown>
    expect(mine).toEqual(theirs)
  })

  it('refuses a write when the row changed after it was read', async () => {
    await armed()
    const racing = next.repo.update(ID, async (swap) => {
      await next.repo.update(ID, (other) => void other.locking('to', t(now)))
      swap.locking('to', t(now))
    })
    await expect(racing).rejects.toThrow(Conflict)
    expect((await next.repo.get(ID))?.to.state).toBe('locking')
  })

  it('moves the version on every write, even two in one second', async () => {
    const before = (await next.repo.get(ID))?.version
    const first = await next.repo.update(ID, (swap) => void swap.lock('from', t(now), ref(HASH), t(5_000)))
    const second = await next.repo.update(ID, (swap) => void swap.locking('to', t(now)))
    expect(new Set([before, first.version, second.version]).size).toBe(3)
  })

  it('finds a swap by id, request, hash, script and funding transaction', async () => {
    await armed()
    await paying()
    await funded()
    const { repo } = next
    expect((await repo.get(ID))?.id).toBe(ID)
    expect(await repo.get(SwapId.of('nope'))).toBeNull()
    expect((await repo.findByRfqId(RfqId.of(RFQ)))?.id).toBe(ID)
    expect((await repo.findByHash(HASH)).map((swap) => swap.id)).toEqual([ID])
    expect((await repo.findLiveByScript('5120aa'))?.id).toBe(ID)
    expect((await repo.findByFundingTx(ref('lockup:1'))).map((swap) => swap.id)).toEqual([ID])
    expect((await repo.listOpen({ after: null, limit: 10 })).map((swap) => swap.id)).toEqual([ID])
    expect(await repo.listOpen({ after: ID, limit: 10 })).toEqual([])
  })
})
