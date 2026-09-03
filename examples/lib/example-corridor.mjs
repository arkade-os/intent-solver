// A corridor, whole, in plain code: the `Corridor` interface with nothing else
// in the way.
//
// The four built-in corridors are the same interface, but each carries a real
// state machine, a SQLite store and a settlement layer, so the shape is hard to
// see through them. This one settles NOTHING — it issues a paper voucher and
// calls it delivered — precisely so every line is about the interface rather
// than about money. Read `packages/solver-corridors/src/send/orchestrator.ts`
// for the real thing.
//
// Runnable host: `examples/corridor-host.mjs`.
// The written guide: `docs/repos/intent-solver/building-a-corridor.md`.
// What it costs, measured: `docs/authoring.md`.
//
// Everything imported here comes from the package entrypoint. That is the
// contract a consumer gets: reaching into `packages/*/src` is a gap worth
// reporting, not a workaround.

import { extractRfqId, phaseOfStates, rfqRefusalPayload } from '../../packages/solver-app/dist/index.js'

/** @typedef {import('../../packages/solver-app/dist/index.js').Corridor} Corridor */
/** @typedef {import('../../packages/solver-app/dist/index.js').CorridorDescriptor} CorridorDescriptor */

/**
 * @typedef {object} VoucherRow
 * @property {string} id
 * @property {string} rfqId
 * @property {string} state
 * @property {number} amountSats
 * @property {number} payoutSats
 * @property {string} pkScript
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * What the corridor DECLARES about itself. Every field is required, and that is
 * deliberate: `corridorDescriptor.ts` records that a field going optional with a
 * default would retire a money-critical question silently.
 *
 * `exposed` is a subset of `live` — a state can be both in flight and money-out,
 * and the console checks exposed first because that is the more urgent fact.
 * Nothing enforces that subset for a corridor outside this repo, so it is yours
 * to get right.
 *
 * @type {CorridorDescriptor}
 */
export const VOUCHER = {
  // The RFQ pair, and the registry key. A client puts this exact string on the
  // wire; the host dispatches on it and on nothing else.
  pair: 'arkade:BTC->voucher:BTC',
  // The env-variable stem, because `arkade:BTC->voucher:BTC` is not a legal
  // shell identifier. It must not collide with a built-in: two corridors
  // sharing a stem would make `<STEM>_ENABLED=false` dark a corridor the
  // operator never named, so `createCorridorSet` refuses that at composition
  // rather than letting it surface as a mystery at dispatch.
  envStem: 'VOUCHER',
  // Which rail's balance funds the payout. `arkade` because a voucher costs the
  // solver nothing; a corridor paying out somewhere this build has never heard
  // of names its own rail id, and the console reports UNKNOWN — never zero —
  // for a rail it cannot resolve.
  payoutRail: 'arkade',
  states: {
    live: ['quoted', 'issuing'],
    exposed: ['issuing'],
    delivered: ['issued'],
  },
}

const FEE_SATS = 7
const MIN_SATS = 1_000
const MAX_SATS = 1_000_000

/**
 * The single definition of "advance this row one step".
 *
 * Shared by `tick` and `tickAll` rather than written twice, so the two can never
 * drift on what a step MEANS — the drift `docs/authoring.md` measures across the
 * six shipped `tickAll` implementations starts exactly here.
 *
 * @param {Map<string, VoucherRow>} rows
 * @param {string} id
 * @param {() => number} now
 * @returns {Promise<boolean>} whether the row moved
 */
const advance = async (rows, id, now) => {
  // RE-READ the row rather than trusting one handed in: a tick may run
  // concurrently with the sweep, and acting on a stale copy is how a swap gets
  // driven twice from one observation.
  const row = rows.get(id)
  if (row === undefined) return false
  if (row.state === 'quoted') {
    rows.set(id, { ...row, state: 'issuing', updatedAt: now() })
    return true
  }
  if (row.state === 'issuing') {
    rows.set(id, { ...row, state: 'issued', updatedAt: now() })
    return true
  }
  return false
}

/**
 * One voucher corridor, ready to register.
 *
 * @param {{ now?: () => number }} [options]
 * @returns {Corridor}
 */
export const voucherCorridor = (options = {}) => {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))

  /**
   * The smallest store that can back the interface: a Map.
   *
   * A real corridor extends `BaseSwapStore`, whose `transition` is a
   * compare-and-swap — `WHERE id = ? AND state = ?` is what stops two sweeps
   * acting on one row. A Map cannot do that. This example is single-process and
   * settles nothing, so the omission costs nothing HERE and would cost a
   * double-spend anywhere real.
   *
   * @type {Map<string, VoucherRow>}
   */
  const rows = new Map()

  /**
   * Ids already being ticked. The guard belongs to the corridor, not the host:
   * only the corridor knows what "already in flight" means for its own row.
   *
   * @type {Set<string>}
   */
  const inFlight = new Set()

  /** @param {VoucherRow} row */
  const project = (row) => ({
    id: row.id,
    // The corridor's OWN state word, never normalised away — the console shows
    // this verbatim, which is why `states` above has to be honest.
    state: row.state,
    // Bucketed with the exported helper rather than by hand. A corridor that
    // invented its own mapping would file an unrecognised state under `done`,
    // which is the one bucket nobody looks at twice; `phaseOfStates` sends it
    // to `failed`, where an operator sees it.
    phase: phaseOfStates(VOUCHER.states, row.state),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })

  /** @param {VoucherRow} row */
  const isLive = (row) => VOUCHER.states.live.includes(row.state)

  return {
    descriptor: VOUCHER,

    /**
     * Validate the request against your OWN schema, and issue or refuse terms.
     *
     * The host has already checked that `pair` is present and served. Nothing
     * else about the payload is its business, which is exactly what lets a
     * corridor carry a wire shape this build was never compiled against.
     *
     * Three kinds, which HTTP maps to 201 / 422 / 400: `quote` (terms issued),
     * `refused` (a valid request declined), `invalid` (an unserviceable one).
     *
     * Build every refusal with `rfqRefusalPayload`. The refusal vocabulary is
     * CLOSED and the host re-checks it on the way out — a free-text reason, or
     * no reason at all, is replaced with `unsupported_payload` and your answer
     * never reaches the client. That gate exists so a solver does not narrate
     * its own validation to anyone who cares to ask.
     */
    quote: async (payload) => {
      const request = /** @type {{ amount?: unknown } | null} */ (payload)
      const rfqId = extractRfqId(payload)
      const amount = request?.amount
      if (rfqId === undefined || typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
        return {
          kind: 'invalid',
          payload: rfqRefusalPayload(rfqId, 'unsupported_payload'),
          // `detail` is for the LOG, never the wire — no payload builder reads
          // it, which is what makes it safe to be specific here. The coarse
          // reason above is all the client gets, on purpose.
          detail: 'rfq_id must be a string and amount a whole number of sats',
        }
      }
      if (amount < MIN_SATS || amount > MAX_SATS) {
        return { kind: 'refused', payload: rfqRefusalPayload(rfqId, 'amount_out_of_range') }
      }
      const at = now()
      const id = `voucher-${rows.size}`
      rows.set(id, {
        id,
        rfqId,
        state: 'quoted',
        amountSats: amount,
        payoutSats: amount - FEE_SATS,
        // A real corridor puts the lockup's script here; the sweep watches it
        // and `findRecoverable` hands it over.
        pkScript: '',
        createdAt: at,
        updatedAt: at,
      })
      return {
        kind: 'quote',
        payload: { v: 1, type: 'rfq_quote', rfq_id: rfqId, from_amount: amount, to_amount: amount - FEE_SATS },
      }
    },

    /**
     * NULL for an id you do not hold — never a refusal.
     *
     * A status request carries no `pair`, so the host asks every corridor in
     * turn and takes the first non-null answer. A refusal here would END that
     * fall-through and hide a live swap belonging to the corridor after you.
     */
    statusFor: async (rfqId) => {
      for (const row of rows.values()) {
        if (row.rfqId === rfqId) return { v: 1, type: 'rfq_status', rfq_id: rfqId, state: row.state }
      }
      return null
    },

    /**
     * Drive one swap one step. Must be re-entrant and re-read the row.
     *
     * Deliberately NOT gated on `inFlight`: a direct caller is a human or an
     * event asking once — an operator's recheck, a lockup-watcher callback, a
     * one-shot CLI tick — and throttling those would make the console lie about
     * what it just did. Only the periodic sweep needs slowing down.
     */
    tick: async (id) => {
      await advance(rows, id, now)
    },

    /**
     * Drive EVERY non-terminal row one step, and answer how many moved.
     *
     * Required rather than optional, and it is not `findRecoverable` + `tick` in
     * a loop. The lockup watcher only fires when a script sees activity, so it
     * advances a row waiting on FUNDING and never one waiting on a DEADLINE —
     * this periodic pass is what moves everything else. A corridor without it
     * appears to work right up until a swap needs to time out.
     *
     * Three properties the shipped corridors have and a naive loop drops. Two of
     * this repo's own corridors dropped them (measured in `docs/authoring.md`),
     * so they are spelled out here rather than assumed:
     *
     *   1. SKIP a row already in flight, instead of racing a second tick on it.
     *   2. ISOLATE a throw, so one bad row does not strand every row after it.
     *   3. Count what MOVED, so a caller's backoff measures real progress rather
     *      than the size of the queue.
     *
     * The snapshot (`[...rows.values()]`) is taken before the loop because
     * `advance` writes to the same map; iterating it live would visit rows this
     * pass just created.
     */
    tickAll: async () => {
      let driven = 0
      for (const row of [...rows.values()]) {
        if (!isLive(row) || inFlight.has(row.id)) continue
        inFlight.add(row.id)
        try {
          if (await advance(rows, row.id, now)) driven += 1
        } catch {
          // A swap fault, not a sweep fault. The next pass retries this row; a
          // rethrow here would end the sweep at the first bad one.
        } finally {
          inFlight.delete(row.id)
        }
      }
      return driven
    },

    /** Rows the sweep should drive, with the lockup scripts worth watching. */
    findRecoverable: async () =>
      [...rows.values()].filter(isLive).map((row) => ({ id: row.id, pkScript: row.pkScript })),

    /** Sats this corridor currently has at risk. LIVE rows only. */
    committedSats: async () =>
      [...rows.values()].filter(isLive).reduce((total, row) => total + row.amountSats, 0),

    /** Rows for the console. One page; a real store cursors through `page`. */
    page: async () => ({ swaps: [...rows.values()].map(project), nextCursor: null }),

    /**
     * One row plus its timeline, or NULL when this corridor has no such id —
     * "not mine" is a routine answer here rather than a fault, because the
     * console asks every corridor.
     */
    detail: async (id) => {
      const row = rows.get(id)
      if (row === undefined) return null
      return { raw: row, swap: project(row), history: [] }
    },

    close: async () => {
      rows.clear()
    },

    // ---- Optional capabilities. Absence IS the contract, not an oversight. ---
    //
    // `liveLockups`, `tickHot`, `refundSweep`, `refundNow` and `claimNow` are
    // all absent because a voucher has no lockup, no hot state, and nothing to
    // refund. A corridor claiming a capability it cannot honour is worse than
    // one that says nothing.
    //
    // ONE of those absences is not free elsewhere. `liveLockups` is optional in
    // the type and MANDATORY IN FACT for any corridor that funds lockups the
    // settlement layer must register: omitting it there loses renewal
    // protection and the recovery path for every one of them, and no layer can
    // tell that apart from a corridor with genuinely nothing to report.
  }
}
