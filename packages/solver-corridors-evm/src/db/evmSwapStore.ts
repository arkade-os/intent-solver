/** The store `send_evm_swap` and `receive_evm_swap` share, driven by each table's shape. */

import type { SqlDriver } from '@arkade-os/solver-db/driver.js'
import { pageQuery, takePage, type PageOptions, type PageRawFields } from '@arkade-os/solver-core/core/page.js'
import { clampLedgerLimit, type LedgerWindow } from '@arkade-os/solver-core/analytics/economics.js'
import { announceTransition, type TransitionHook } from '@arkade-os/solver-core/core/businessEvent.js'
import { evmSwapSql, type EvmSwapSql } from './evmSwapStore.sql.js'

export type Raw = Record<string, string | number | null>

// `| undefined` because `noUncheckedIndexedAccess` makes every raw column
// lookup possibly-absent, and a column this store does not know about is
// absent rather than null.
export const text = (value: string | number | null | undefined): string | null =>
  value === null || value === undefined ? null : String(value)

const assertColumns = (columns: readonly string[], allowed: ReadonlySet<string>, where: string): void => {
  for (const column of columns) {
    if (!allowed.has(column)) throw new Error(where + ': unknown column ' + column)
  }
}

export const commonFields = (raw: Raw) => ({
  id: String(raw.id),
  createdAt: Number(raw.created_at),
  updatedAt: Number(raw.updated_at),
  paymentHash: String(raw.payment_hash),
  amountSats: Number(raw.amount_sats),
  // Rows quoted before a fee existed carry NULL and read back as the full
  // amount, which is exactly what they were quoted at.
  payoutSats: raw.payout_sats === null ? Number(raw.amount_sats) : Number(raw.payout_sats),
  evmAmount: String(raw.evm_amount),
  tokenAddress: String(raw.token_address),
  evmContractAddress: String(raw.evm_contract_address),
  evmChainId: Number(raw.evm_chain_id),
  evmTimeout: Number(raw.evm_timeout),
  validUntil: Number(raw.valid_until),
  minConfirmations: Number(raw.min_confirmations),
  minAgeSeconds: Number(raw.min_age_seconds),
  evmLockTxid: text(raw.evm_lock_txid),
  evmClaimTxid: text(raw.evm_claim_txid),
  evmClaimAddress: String(raw.evm_claim_address),
  evmRefundAddress: String(raw.evm_refund_address),
  refundLocktime: Number(raw.refund_locktime),
  providerPubkey: String(raw.provider_pubkey),
  serverPubkey: String(raw.server_pubkey),
  claimDelay: Number(raw.claim_delay),
  refundDelay: Number(raw.refund_delay),
  refundWithoutReceiverDelay: Number(raw.refund_without_receiver_delay),
  pkScript: String(raw.pk_script),
  lockupAddress: String(raw.lockup_address),
  refundPkScript: String(raw.refund_pk_script),
  emulatorPubkey: String(raw.emulator_pubkey),
  clientRefundPubkey: String(raw.client_refund_pubkey),
  receiverPkScript: String(raw.receiver_pk_script),
  nonInteractiveParameters:
    raw.non_interactive_parameters === null || raw.non_interactive_parameters === undefined
      ? null
      : raw.non_interactive_parameters === '1',
  preimage: text(raw.preimage),
  refundArkTxid: text(raw.refund_ark_txid),
  rfqId: text(raw.rfq_id),
  failureReason: text(raw.failure_reason),
})

type CommonQuote = Omit<
  ReturnType<typeof commonFields>,
  | 'createdAt'
  | 'updatedAt'
  | 'evmLockTxid'
  | 'evmClaimTxid'
  | 'preimage'
  | 'refundArkTxid'
  | 'failureReason'
  | 'nonInteractiveParameters'
> & { nonInteractiveParameters: boolean }

export interface EvmSwapShape<Row, State extends string> {
  /** Its events live in `<table>_event`. */
  table: string
  /** 'send' or 'receive', as error text names the row. */
  noun: string
  toRow: (raw: Raw) => Row
  nonTerminal: readonly State[]
  /** Columns `transition()` and `patch()` may set, so a typo cannot silently write nothing. */
  transitionColumns: ReadonlySet<string>
}

/** Every public member {@link EvmSwapStore} gives both EVM swap tables. */
export interface EvmSwapRepository<Row, State extends string> {
  close(): Promise<void>
  get(id: string): Promise<Row>
  findByRfqId(rfqId: string): Promise<Row | null>
  findLiveByPaymentHash(paymentHash: string): Promise<Row | null>
  findByPkScript(pkScript: string): Promise<Row | null>
  committedSats(tokenAddress?: string): Promise<number>
  findByStates(states: readonly State[]): Promise<Row[]>
  findLive(): Promise<Row[]>
  history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]>
  ledgerRows(window: LedgerWindow, tokenAddress?: string): Promise<{ rows: Row[]; truncated: boolean }>
  page(options?: PageOptions): Promise<{ rows: Row[]; nextCursor: string | null }>
  transition(id: string, from: State, to: State, fields?: Record<string, unknown>): Promise<void>
  onTransition?: TransitionHook
  patch(id: string, fields: Record<string, unknown>): Promise<void>
  fail(id: string, from: State, reason: string): Promise<void>
}

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const assertIdentifier = (name: string): void => {
  if (!SQL_IDENTIFIER.test(name)) throw new Error(`not a plain SQL identifier: ${name}`)
}

export abstract class EvmSwapStore<Row, State extends string> implements EvmSwapRepository<Row, State> {
  protected constructor(
    protected readonly driver: SqlDriver,
    protected readonly now: () => number,
    private readonly shape: EvmSwapShape<Row, State>,
  ) {
    assertIdentifier(shape.table)
  }

  #sql?: EvmSwapSql
  protected get sql(): EvmSwapSql {
    return (this.#sql ??= evmSwapSql(this.shape.table))
  }

  async close(): Promise<void> {
    await this.driver.close?.()
  }

  protected async insert(quote: CommonQuote, extra: Record<string, string | number | null> = {}): Promise<Row> {
    const values: Record<string, string | number | null> = {
      payment_hash: quote.paymentHash,
      amount_sats: quote.amountSats,
      payout_sats: quote.payoutSats,
      evm_amount: quote.evmAmount,
      token_address: quote.tokenAddress,
      evm_contract_address: quote.evmContractAddress,
      evm_chain_id: quote.evmChainId,
      evm_timeout: quote.evmTimeout,
      valid_until: quote.validUntil,
      min_confirmations: quote.minConfirmations,
      min_age_seconds: quote.minAgeSeconds,
      evm_claim_address: quote.evmClaimAddress,
      evm_refund_address: quote.evmRefundAddress,
      refund_locktime: quote.refundLocktime,
      provider_pubkey: quote.providerPubkey,
      server_pubkey: quote.serverPubkey,
      claim_delay: quote.claimDelay,
      refund_delay: quote.refundDelay,
      refund_without_receiver_delay: quote.refundWithoutReceiverDelay,
      pk_script: quote.pkScript,
      lockup_address: quote.lockupAddress,
      refund_pk_script: quote.refundPkScript,
      emulator_pubkey: quote.emulatorPubkey,
      client_refund_pubkey: quote.clientRefundPubkey,
      receiver_pk_script: quote.receiverPkScript,
      non_interactive_parameters:
        quote.nonInteractiveParameters === undefined ? null : quote.nonInteractiveParameters ? '1' : null,
      rfq_id: quote.rfqId,
      ...extra,
    }
    const columns = Object.keys(values)
    Object.keys(extra).forEach(assertIdentifier)
    const at = this.now()
    await this.driver.run(this.sql.insertQuoted(columns), [
      quote.id,
      at,
      at,
      ...columns.map((column) => values[column]),
    ])
    await this.driver.run(this.sql.insertQuotedEvent, [quote.id, at])
    return this.get(quote.id)
  }

  async get(id: string): Promise<Row> {
    const rows = (await this.driver.all(this.sql.selectById, [id])) as Raw[]
    const raw = rows[0]
    if (!raw) throw new Error('no evm ' + this.shape.noun + ' swap ' + id)
    return this.shape.toRow(raw)
  }

  async findByRfqId(rfqId: string): Promise<Row | null> {
    const rows = (await this.driver.all(this.sql.selectByRfqId, [rfqId])) as Raw[]
    return rows[0] ? this.shape.toRow(rows[0]) : null
  }

  async findLiveByPaymentHash(paymentHash: string): Promise<Row | null> {
    const rows = (await this.driver.all(this.sql.selectLiveByPaymentHash, [paymentHash])) as Raw[]
    return rows[0] ? this.shape.toRow(rows[0]) : null
  }

  async findByPkScript(pkScript: string): Promise<Row | null> {
    const rows = (await this.driver.all(this.sql.selectNewestByPkScript, [pkScript])) as Raw[]
    return rows[0] ? this.shape.toRow(rows[0]) : null
  }

  /** Non-terminal, not exposed-only: a quote binds until `valid_until`. One table backs every
   * token, so a corridor passes its own `token_address`; a caller summing whole STORES omits it. */
  async committedSats(tokenAddress?: string): Promise<number> {
    const { nonTerminal } = this.shape
    const rows = (await this.driver.all(
      this.sql.sumAmountInStates(nonTerminal.length, tokenAddress !== undefined),
      tokenAddress === undefined ? [...nonTerminal] : [...nonTerminal, tokenAddress],
    )) as Raw[]
    return Number(rows[0]?.total ?? 0)
  }

  async findByStates(states: readonly State[]): Promise<Row[]> {
    if (states.length === 0) return []
    const rows = (await this.driver.all(this.sql.selectInStates(states.length), [...states])) as Raw[]
    return rows.map(this.shape.toRow)
  }

  async findLive(): Promise<Row[]> {
    return this.findByStates(this.shape.nonTerminal)
  }

  async history(swapId: string): Promise<{ at: number; from: string | null; to: string; detail: string | null }[]> {
    const rows = (await this.driver.all(this.sql.selectHistory, [swapId])) as Raw[]
    return rows.map((raw) => ({
      at: Number(raw.at),
      from: text(raw.from_state),
      to: String(raw.to_state),
      detail: text(raw.detail),
    }))
  }

  /** @see BaseSwapStore.ledgerRows. `tokenAddress` narrows IN SQL: filtered after the `LIMIT`,
   * a busy token's rows would push a quiet one's out and it would report no profit. */
  async ledgerRows(window: LedgerWindow, tokenAddress?: string): Promise<{ rows: Row[]; truncated: boolean }> {
    const limit = clampLedgerLimit(window.limit)
    const raw = await this.driver.all<Raw>(
      this.sql.selectUpdatedInWindow(tokenAddress !== undefined),
      tokenAddress === undefined
        ? [window.since, window.until, limit + 1]
        : [window.since, window.until, tokenAddress, limit + 1],
    )
    return { rows: raw.slice(0, limit).map(this.shape.toRow), truncated: raw.length > limit }
  }

  async page(options: PageOptions = {}): Promise<{ rows: Row[]; nextCursor: string | null }> {
    const { sql, params, limit } = pageQuery(this.shape.table, options)
    const raw = await this.driver.all<Raw & PageRawFields>(sql, params)
    const { page, nextCursor } = takePage(raw, limit)
    return { rows: page.map(this.shape.toRow), nextCursor }
  }

  /** Guarded on `from`: of two racing ticks, the loser's UPDATE matches no row and it throws. */
  async transition(id: string, from: State, to: State, fields: Record<string, unknown> = {}): Promise<void> {
    const { noun } = this.shape
    const columns = Object.keys(fields)
    assertColumns(columns, this.shape.transitionColumns, 'transition()')
    const at = this.now()
    const result = await this.driver.run(this.sql.updateState(columns), [
      to,
      at,
      ...columns.map((column) => fields[column] as string | number | null),
      id,
      from,
    ])
    if ((result?.changes ?? 0) === 0) {
      throw new Error('evm ' + noun + ' swap ' + id + ' is not in state ' + from)
    }
    await this.driver.run(this.sql.insertEvent, [id, at, from, to])
    announceTransition(this.onTransition, id, from, to)
  }

  /** @see BaseSwapStore.onTransition */
  onTransition?: TransitionHook

  /** Set fields WITHOUT moving the row: via `transition` a txid would log a self-transition. */
  async patch(id: string, fields: Record<string, unknown>): Promise<void> {
    const columns = Object.keys(fields)
    if (columns.length === 0) return
    assertColumns(columns, this.shape.transitionColumns, 'patch()')
    await this.driver.run(this.sql.updateFields(columns), [
      this.now(),
      ...columns.map((column) => fields[column] as string | number | null),
      id,
    ])
  }

  async fail(id: string, from: State, reason: string): Promise<void> {
    // Both state unions carry 'stuck'; the generic cannot express that.
    await this.transition(id, from, 'stuck' as State, { failure_reason: reason })
  }
}
