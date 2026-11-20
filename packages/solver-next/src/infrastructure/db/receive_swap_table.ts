import { Amount } from '../../domain/shared/amount.js'
import { Asset } from '../../domain/shared/asset.js'
import { Rail } from '../../domain/shared/endpoint.js'
import { Conflict, RuleViolated } from '../../domain/shared/error.js'
import { RfqId, SwapId } from '../../domain/shared/ids.js'
import { UnixSeconds } from '../../domain/shared/time.js'
import { Hashlock, Preimage } from '../../domain/swap/hashlock.js'
import { MAX_REFUND_HORIZON, SETTLE_SAFETY_MARGIN } from '../../domain/swap/ln_receive.js'
import { ContractKind, Leg, Reference, Side, type LegState } from '../../domain/swap/leg.js'
import { AmountMode, Quote } from '../../domain/swap/quote.js'
import { Swap } from '../../domain/swap/swap.js'
import type { SwapEvent } from '../../domain/swap/swap_event.js'
import type { Page, SwapRepository } from '../../domain/swap/swap_repo.js'
import { SwapOutcome } from '../../domain/swap/swap_state.js'
import type { LockupContract, LockupContracts } from '../../ports/arkade.js'
import type { SqlDriver } from '../../ports/sql.js'

const BTC = Asset.of('BTC')

export type ReceiveSwapState =
  'quoted' | 'armed' | 'funded' | 'claimed' | 'refunding' | 'settled' | 'refunded' | 'refused' | 'stuck'

type Failed = 'refused' | 'stuck'
type Lived = Exclude<ReceiveSwapState, Failed>

const OPEN: readonly ReceiveSwapState[] = ['quoted', 'armed', 'funded', 'claimed', 'refunding']

/** The columns of `receive_swap` the swap is read from. The table has more; they describe the contract. */
export interface ReceiveSwapRecord {
  readonly id: string
  readonly state: ReceiveSwapState
  readonly updatedAt: number
  readonly paymentHash: string
  readonly amountSats: number
  readonly payoutSats: number
  readonly invoiceExpiresAt: number
  readonly htlcExpiresAt: number | null
  readonly arkadeLockupTxid: string | null
  readonly arkadeLockupVout: number | null
  readonly settleAttemptedAt: number | null
  readonly preimage: string | null
  readonly refundArkTxid: string | null
  readonly failureReason: string | null
  readonly rfqId: string | null
  readonly fundStartedAt: number | null
}

type Raw = Record<string, string | number | null>
const text = (value: string | number | null): string | null => (value === null ? null : String(value))
const number = (value: string | number | null): number | null => (value === null ? null : Number(value))

const recordOf = (raw: Raw): ReceiveSwapRecord => ({
  id: String(raw.id),
  state: String(raw.state) as ReceiveSwapState,
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  payoutSats: Number(raw.payout_sats ?? raw.amount_sats),
  invoiceExpiresAt: Number(raw.invoice_expires_at),
  htlcExpiresAt: number(raw.htlc_expires_at ?? null),
  arkadeLockupTxid: text(raw.arkade_lockup_txid ?? null),
  arkadeLockupVout: number(raw.arkade_lockup_vout ?? null),
  settleAttemptedAt: number(raw.settle_attempted_at ?? null),
  preimage: text(raw.preimage ?? null),
  refundArkTxid: text(raw.refund_ark_txid ?? null),
  failureReason: text(raw.failure_reason ?? null),
  rfqId: text(raw.rfq_id ?? null),
  fundStartedAt: number(raw.fund_started_at ?? null),
})

const legsAt = (row: ReceiveSwapRecord, state: Lived): readonly [from: LegState, to: LegState] => {
  switch (state) {
    case 'quoted':
      return ['pending', 'pending']
    case 'armed':
      // The fund lease is the row's only trace of a payout that may be in flight.
      return ['locked', row.fundStartedAt === null ? 'pending' : 'locking']
    case 'funded':
      return ['locked', 'locked']
    case 'claimed':
      return [row.settleAttemptedAt === null ? 'locked' : 'claiming', 'claimed']
    case 'refunding':
      return ['locked', 'refunding']
    case 'settled':
      return ['claimed', 'claimed']
    case 'refunded':
      // The held payment is left to time out and that is never recorded, so the row only proves it was held.
      return ['locked', 'refunded']
  }
}

// The state the row would have if the swap had not failed: the reverse of `legsAt`.
const stateOf = (swap: Swap): Lived => {
  const pair = `${swap.from.state}/${swap.to.state}`
  const states: Record<string, Lived> = {
    'pending/pending': 'quoted',
    'locked/pending': 'armed',
    'locked/locking': 'armed',
    'locked/locked': 'funded',
    'locked/claimed': 'claimed',
    'claiming/claimed': 'claimed',
    'claimed/claimed': 'settled',
    'locked/refunding': 'refunding',
    'locked/refunded': 'refunded',
  }
  const state = states[pair]
  if (state === undefined) throw new RuleViolated(`swap ${swap.id}: receive_swap has no state for legs ${pair}`)
  return state
}

// For a failed row whose history does not say where it failed from.
const lastProven = (row: ReceiveSwapRecord): Lived => {
  if (row.preimage !== null) return 'claimed'
  if (row.arkadeLockupTxid !== null) return 'funded'
  return row.htlcExpiresAt !== null || row.fundStartedAt !== null ? 'armed' : 'quoted'
}

const isFailed = (state: ReceiveSwapState): state is Failed => state === 'refused' || state === 'stuck'

/** `failedFrom`: the state a `refused` / `stuck` row was in before, which the row itself forgets. */
export const swapFromReceiveRow = (row: ReceiveSwapRecord, failedFrom: Lived | null = null): Swap => {
  const failed = isFailed(row.state)
  const [from, to] = legsAt(row, isFailed(row.state) ? (failedFrom ?? lastProven(row)) : row.state)
  const lockup =
    row.arkadeLockupTxid === null ? [] : [Reference.of(`${row.arkadeLockupTxid}:${row.arkadeLockupVout ?? 0}`)]
  // The row keeps one timestamp for both legs; only the fund lease has its own.
  const changed = UnixSeconds.of(row.updatedAt)
  const amount = Amount.of(BTC, BigInt(row.amountSats))
  const payout = Amount.of(BTC, BigInt(row.payoutSats))
  return Swap.fromSnapshot(
    {
      id: SwapId.of(row.id),
      rfqId: row.rfqId === null ? null : RfqId.of(row.rfqId),
      // Not kept on the row; both amounts were fixed at the quote, so nothing reads it back.
      amountMode: AmountMode.ExactIn,
      quote: Quote.of(UnixSeconds.of(row.invoiceExpiresAt), { fee: amount.minus(payout), spreadBps: 0 }),
      hashlock: Hashlock.of(row.paymentHash),
      preimage: row.preimage === null ? null : Preimage.of(row.preimage),
      from: Leg.restore(
        Side.From,
        { rail: Rail.Lightning, amount, contract: ContractKind.Lightning, version: null },
        from,
        { funding: [], claim: [], refund: [] },
        changed,
        row.htlcExpiresAt === null ? null : UnixSeconds.of(row.htlcExpiresAt),
      ),
      to: Leg.restore(
        Side.To,
        { rail: Rail.Arkade, amount: payout, contract: ContractKind.Vhtlc, version: null },
        to,
        { funding: lockup, claim: [], refund: row.refundArkTxid === null ? [] : [Reference.of(row.refundArkTxid)] },
        to === 'locking' && row.fundStartedAt !== null ? UnixSeconds.of(row.fundStartedAt) : changed,
      ),
      outcome: failed ? (row.state === 'refused' ? SwapOutcome.Refused : SwapOutcome.Stuck) : null,
      outcomeReason: failed ? row.failureReason : null,
    },
    // The row has no revision column. Every write moves `updated_at` forward, so it serves as one.
    row.updatedAt,
  )
}

// What one change of the swap writes into the row, besides its state.
const columnsFor = (event: SwapEvent, payoutSats: number, now: number): Record<string, string | number | null> => {
  if (event.type === 'SwapFailed') return { failure_reason: event.reason }
  if (event.type === 'LegReferenced') {
    const refund = event.side === Side.To ? event.references.refund : undefined
    return refund === undefined ? {} : { refund_ark_txid: refund }
  }
  if (event.type !== 'LegAdvanced') return {}
  if (event.side === Side.From) {
    if (event.state === 'locked') return { htlc_expires_at: event.expiresAt }
    return event.state === 'claiming' ? { settle_attempted_at: now } : {}
  }
  switch (event.state) {
    case 'locking':
      return { fund_started_at: now }
    case 'pending':
      return { fund_started_at: null }
    case 'locked': {
      const [txid, vout] = (event.references.funding ?? '').split(':')
      if (!txid || vout === undefined) throw new RuleViolated(`swap ${event.id}: a paid lockup needs its outpoint`)
      return { arkade_lockup_txid: txid, arkade_lockup_vout: Number(vout), arkade_lockup_value: payoutSats }
    }
    case 'claimed':
      return { preimage: event.preimage }
    case 'refunded':
      return event.references.refund === undefined ? {} : { refund_ark_txid: event.references.refund }
    default:
      return {}
  }
}

/**
 * One of the legacy tables swaps are kept in: `receive_swap`, for Lightning receive. The schema is not changed.
 * There is one `Swap` and one repository; each legacy table only needs its own row mapping until they are merged.
 */
export class ReceiveSwapTable implements Omit<SwapRepository, 'add'>, LockupContracts {
  private readonly contracts = new Map<string, LockupContract>()

  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => number,
  ) {}

  async get(id: SwapId): Promise<Swap | null> {
    return this.one('SELECT * FROM receive_swap WHERE id = ?', [id])
  }

  async findByRfqId(rfqId: RfqId): Promise<Swap | null> {
    return this.one('SELECT * FROM receive_swap WHERE rfq_id = ? ORDER BY created_at DESC LIMIT 1', [rfqId])
  }

  async findByHash(hashlock: Hashlock): Promise<readonly Swap[]> {
    return this.many("SELECT * FROM receive_swap WHERE payment_hash = ? AND state != 'refused'", [hashlock])
  }

  async findLiveByScript(script: string): Promise<Swap | null> {
    const marks = OPEN.map(() => '?').join(', ')
    return this.one(
      `SELECT * FROM receive_swap WHERE pk_script = ? AND state IN (${marks}) ORDER BY created_at DESC LIMIT 1`,
      [script, ...OPEN],
    )
  }

  async findByFundingTx(funding: Reference): Promise<readonly Swap[]> {
    return this.many('SELECT * FROM receive_swap WHERE arkade_lockup_txid = ?', [funding.split(':')[0]])
  }

  async listOpen(page: Page): Promise<readonly Swap[]> {
    const marks = OPEN.map(() => '?').join(', ')
    return this.many(`SELECT * FROM receive_swap WHERE state IN (${marks}) AND id > ? ORDER BY id LIMIT ?`, [
      ...OPEN,
      page.after ?? '',
      page.limit,
    ])
  }

  /** The contract the payout is locked under, from the columns the quote wrote. */
  async contract(id: string): Promise<LockupContract> {
    const known = this.contracts.get(id)
    if (known !== undefined) return known
    const read = await this.readContract(id)
    // A contract never changes after the quote. The cap only bounds memory.
    if (this.contracts.size >= 4_096) this.contracts.clear()
    this.contracts.set(id, read)
    return read
  }

  private async readContract(id: string): Promise<LockupContract> {
    const raw = await this.driver.get<Raw>('SELECT * FROM receive_swap WHERE id = ?', [id])
    if (raw === undefined) throw new Conflict(`swap ${id} does not exist`)
    const flag = raw.non_interactive_parameters ?? null
    return {
      id: String(raw.id),
      paymentHash: String(raw.payment_hash),
      pkScript: String(raw.pk_script),
      lockupAddress: String(raw.lockup_address),
      payoutSats: Number(raw.payout_sats ?? raw.amount_sats),
      // The column is NOT NULL, so a quote without a packet stores an empty string.
      claimPacket: raw.claim_packet === '' ? null : text(raw.claim_packet ?? null),
      refundLocktime: Number(raw.refund_locktime),
      claimDelay: Number(raw.claim_delay),
      refundDelay: Number(raw.refund_delay),
      refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
      receiverPubkey: String(raw.payout_pubkey),
      receiverPkScript: text(raw.payout_pk_script ?? null),
      serverPubkey: String(raw.server_pubkey),
      emulatorPubkey: text(raw.emulator_pubkey ?? null),
      clientRefundPubkey: text(raw.solver_pubkey ?? null),
      refundPkScript: text(raw.solver_refund_pk_script ?? null),
      nonInteractiveParameters: flag === null ? null : flag === '1',
    }
  }

  /** One UPDATE for everything `change` did. It fails when the row was written by anyone since it was read. */
  async update(id: SwapId, change: (swap: Swap) => void | Promise<void>): Promise<Swap> {
    const row = await this.row(id)
    if (row === null) throw new Conflict(`swap ${id} does not exist`)
    const swap = await this.load(row)
    await change(swap)
    if (swap.changes.length === 0) return swap

    const state: ReceiveSwapState =
      swap.outcome === null ? stateOf(swap) : swap.outcome === SwapOutcome.Refused ? 'refused' : 'stuck'
    const at = this.now()
    const columns = swap.changes.reduce(
      (all, event) => ({ ...all, ...columnsFor(event, row.payoutSats, at) }),
      {} as Record<string, string | number | null>,
    )
    // Strictly later than the last write, so `updated_at` tells two writes in one second apart.
    const updatedAt = Math.max(at, row.updatedAt + 1)
    const names = Object.keys(columns)
    // A change the table has no column for, such as the transaction id of a payout just sent.
    if (names.length === 0 && state === row.state) return swap
    const assignments = ['state = ?', 'updated_at = ?', ...names.map((name) => `${name} = ?`)].join(', ')
    const written = await this.driver.run(`UPDATE receive_swap SET ${assignments} WHERE id = ? AND updated_at = ?`, [
      state,
      updatedAt,
      ...names.map((name) => columns[name]),
      id,
      row.updatedAt,
    ])
    if (written.changes !== 1) throw new Conflict(`swap ${id} was changed by another writer`)
    if (state !== row.state) {
      await this.driver.run(
        'INSERT INTO receive_swap_event (swap_id, at, from_state, to_state, detail) VALUES (?, ?, ?, ?, NULL)',
        [id, at, row.state, state],
      )
    }
    if (row.state === 'quoted' && state === 'armed') await this.noteHeadroom(id, at).catch(() => undefined)
    const saved = await this.get(id)
    if (saved === null) throw new Conflict(`swap ${id} disappeared while it was written`)
    return saved
  }

  // A line for the operator in the swap's history: how long the payment is held for, and how much of that is spare.
  private async noteHeadroom(id: SwapId, at: number): Promise<void> {
    const raw = await this.driver.get<Raw>('SELECT htlc_expires_at, created_at FROM receive_swap WHERE id = ?', [id])
    if (raw === undefined || raw.htlc_expires_at === null) return
    const timesOutAt = Number(raw.htlc_expires_at)
    const spare = timesOutAt - Number(raw.created_at) - (MAX_REFUND_HORIZON + SETTLE_SAFETY_MARGIN)
    await this.driver.run(
      "INSERT INTO receive_swap_event (swap_id, at, from_state, to_state, detail) VALUES (?, ?, 'armed', 'armed', ?)",
      [id, at, `cltv headroom ${timesOutAt - at}s — ${spare}s spare`],
    )
  }

  private async row(id: SwapId): Promise<ReceiveSwapRecord | null> {
    const raw = await this.driver.get<Raw>('SELECT * FROM receive_swap WHERE id = ?', [id])
    return raw === undefined ? null : recordOf(raw)
  }

  private async load(row: ReceiveSwapRecord): Promise<Swap> {
    if (!isFailed(row.state)) return swapFromReceiveRow(row)
    const failure = await this.driver.get<{ from_state: string | null }>(
      `SELECT from_state FROM receive_swap_event
       WHERE swap_id = ? AND to_state = ? AND from_state != to_state ORDER BY id DESC LIMIT 1`,
      [row.id, row.state],
    )
    return swapFromReceiveRow(row, (failure?.from_state ?? null) as Lived | null)
  }

  private async one(sql: string, params: unknown[]): Promise<Swap | null> {
    const raw = await this.driver.get<Raw>(sql, params)
    return raw === undefined ? null : this.load(recordOf(raw))
  }

  private async many(sql: string, params: unknown[]): Promise<Swap[]> {
    const rows = await this.driver.all<Raw>(sql, params)
    return Promise.all(rows.map((raw) => this.load(recordOf(raw))))
  }
}
