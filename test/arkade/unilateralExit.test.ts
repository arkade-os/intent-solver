/**
 * Which leaf a server-independent exit spends, and the refusals that stop it
 * spending the wrong one.
 *
 * The leaf is decided by which covenant ROLE the solver plays, and the roles
 * invert between legs: on `arkade:BTC->lightning:BTC` the client funds and the
 * solver receives, so the solver's solo path is `unilateralClaim`; on
 * `lightning:BTC->arkade:BTC` the SOLVER funds and the client receives, so it
 * is `unilateralRefundWithoutReceiver`. Getting that backwards does not fail —
 * it moves money the other way.
 *
 * The ladder assertion is the other half. `unilateralRefundWithoutReceiver`
 * opens `SOLO_REFUND_HEADROOM_SECONDS` AFTER `unilateralClaim` so that a funder
 * cannot refund out from under a claimant holding a valid preimage. Consensus
 * enforces each leaf's own CSV; nothing enforces that the two were written in
 * the right ORDER, and a row whose ladder inverted is one where the funder's
 * solo path opens first.
 */
import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import { planUnilateralExit, unilateralExitRecourse } from '@arkade-os/solver-arkade/arkade/unilateralExit.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER = key(1)
const SERVER = key(3)
const EMULATOR = key(9)
const CLIENT = key(11)
const SENDER_PAYOUT = p2tr(key(5))
const RECEIVER_PAYOUT = p2tr(key(13))

const PREIMAGE = new Uint8Array(32).fill(7)
const PREIMAGE_HEX = hex.encode(PREIMAGE)
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE))

const CLAIM_DELAY = 4096
/** The claim delay plus `SOLO_REFUND_HEADROOM_SECONDS`, as `deriveUnilateralDelays` builds it. */
const SOLO_REFUND_DELAY = 4096 + 4096
const REFUND_WITHOUT_SERVER_DELAY = 4096

/**
 * A row whose stored `pkScript` is the one its own fields derive, which is what
 * every read path already demands of a live lockup.
 */
const rowWith = (overrides: Partial<CovenantScriptRow> = {}): CovenantScriptRow => {
  const base: CovenantScriptRow = {
    id: 'swap-1',
    receiverPubkey: hex.encode(RECEIVER),
    serverPubkey: hex.encode(SERVER),
    paymentHash: PAYMENT_HASH,
    refundLocktime: 1_800_000_000,
    claimDelay: CLAIM_DELAY,
    emulatorPubkey: hex.encode(EMULATOR),
    refundPkScript: hex.encode(SENDER_PAYOUT),
    pkScript: '',
    clientRefundPubkey: hex.encode(CLIENT),
    refundWithoutReceiverDelay: SOLO_REFUND_DELAY,
    refundDelay: REFUND_WITHOUT_SERVER_DELAY,
    receiverPkScript: hex.encode(RECEIVER_PAYOUT),
    nonInteractiveParameters: true,
    ...overrides,
  }
  if (base.pkScript !== '') return base
  // Derived rather than pinned: the fixture must stay a row that agrees with
  // itself when a delay override moves the script.
  const script = new CovenantSwapScript({
    receiver: hex.decode(base.receiverPubkey),
    server: hex.decode(base.serverPubkey),
    // Same derivation `covenantScriptFromRow` uses: RIPEMD160 of the payment hash.
    preimageHash: ripemd160(hex.decode(base.paymentHash)),
    refundLocktime: base.refundLocktime,
    claimDelay: base.claimDelay,
    client: hex.decode(base.clientRefundPubkey!),
    clientRefundDelay: base.refundWithoutReceiverDelay,
    refundWithoutServerDelay: base.refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(base.emulatorPubkey!),
      receiverPkScript: hex.decode(base.receiverPkScript!),
      senderPkScript: hex.decode(base.refundPkScript!),
    },
  })
  return { ...base, pkScript: hex.encode(script.pkScript) }
}

describe('planUnilateralExit', () => {
  it('gives the SEND legs’ solver — the covenant receiver — the unilateralClaim leaf', () => {
    const plan = planUnilateralExit(rowWith(), {
      solverPubkey: hex.encode(RECEIVER),
      preimage: PREIMAGE_HEX,
    })
    expect(plan.role).toBe('receiver')
    expect(plan.leaf).toBe('unilateralClaim')
    expect(plan.delay).toEqual({ unit: 'seconds', value: CLAIM_DELAY })
    expect(plan.preimage).toBe(PREIMAGE_HEX)
  })

  it('gives the RECEIVE legs’ solver — the covenant client — the unilateralRefundWithoutReceiver leaf', () => {
    const plan = planUnilateralExit(rowWith(), { solverPubkey: hex.encode(CLIENT) })
    expect(plan.role).toBe('sender')
    expect(plan.leaf).toBe('unilateralRefundWithoutReceiver')
    expect(plan.delay).toEqual({ unit: 'seconds', value: SOLO_REFUND_DELAY })
    // The leaf needs no preimage, so the plan carries none even when the solver
    // holds one — a witness item this leaf does not take makes the spend invalid.
    expect(plan.preimage).toBeNull()
  })

  it('drops a preimage the refund leaf does not take, even when one is supplied', () => {
    const plan = planUnilateralExit(rowWith(), {
      solverPubkey: hex.encode(CLIENT),
      preimage: PREIMAGE_HEX,
    })
    expect(plan.preimage).toBeNull()
  })

  it('refuses when the solver’s key plays neither role on the row', () => {
    expect(() => planUnilateralExit(rowWith(), { solverPubkey: hex.encode(key(21)) })).toThrow(
      /neither the receiver nor the client/,
    )
  })

  it('refuses when one key is named as BOTH roles rather than guessing which the solver meant', () => {
    const both = rowWith({ clientRefundPubkey: hex.encode(RECEIVER), pkScript: 'ff'.repeat(34) })
    expect(() => planUnilateralExit(both, { solverPubkey: hex.encode(RECEIVER) })).toThrow(
      /both the receiver and the client/,
    )
  })

  it('refuses the claim leaf with no preimage — the leaf’s witness cannot be built without one', () => {
    expect(() => planUnilateralExit(rowWith(), { solverPubkey: hex.encode(RECEIVER) })).toThrow(/needs the preimage/)
  })

  it('refuses a preimage that does not hash to the row’s payment hash', () => {
    expect(() =>
      planUnilateralExit(rowWith(), {
        solverPubkey: hex.encode(RECEIVER),
        preimage: hex.encode(new Uint8Array(32).fill(8)),
      }),
    ).toThrow(/does not hash to/)
  })

  it('refuses a preimage that is not 32 bytes, which the leaf’s OP_SIZE check pins', () => {
    expect(() => planUnilateralExit(rowWith(), { solverPubkey: hex.encode(RECEIVER), preimage: 'aabb' })).toThrow(
      /32 bytes/,
    )
  })

  /**
   * The headroom is the whole safety property. A row whose solo refund opens at
   * or before the claim lets the funder take money from a claimant who did
   * nothing wrong, and no consensus rule notices — both leaves are individually
   * valid.
   */
  it('refuses a ladder whose solo refund opens no later than the claim', () => {
    const inverted = rowWith({ refundWithoutReceiverDelay: CLAIM_DELAY, pkScript: 'ff'.repeat(34) })
    expect(() => planUnilateralExit(inverted, { solverPubkey: hex.encode(CLIENT) })).toThrow(/opens at or before/)
  })

  it('refuses the same inverted ladder from the CLAIMANT’s side too — it is the row that is unsafe', () => {
    const inverted = rowWith({ refundWithoutReceiverDelay: CLAIM_DELAY, pkScript: 'ff'.repeat(34) })
    expect(() => planUnilateralExit(inverted, { solverPubkey: hex.encode(RECEIVER), preimage: PREIMAGE_HEX })).toThrow(
      /opens at or before/,
    )
  })

  it('refuses a ladder whose two rungs count different clocks', () => {
    const mixed = rowWith({ claimDelay: 20, pkScript: 'ff'.repeat(34) })
    expect(() => planUnilateralExit(mixed, { solverPubkey: hex.encode(CLIENT) })).toThrow(/same clock/)
  })

  it('reads a block-typed ladder as blocks, and converts only for wall-clock reasoning', () => {
    const blocks = rowWith({ claimDelay: 20, refundWithoutReceiverDelay: 28, refundDelay: 20 })
    const plan = planUnilateralExit(blocks, { solverPubkey: hex.encode(CLIENT) })
    expect(plan.delay).toEqual({ unit: 'blocks', value: 28 })
    expect(plan.delaySeconds).toBe(28 * 600)
  })

  it('reports a seconds ladder’s delay as itself', () => {
    const plan = planUnilateralExit(rowWith(), { solverPubkey: hex.encode(CLIENT) })
    expect(plan.delaySeconds).toBe(SOLO_REFUND_DELAY)
  })

  /**
   * The lockup is identified by its script. A row whose stored `pkScript` is not
   * what its own fields derive would drive an exit against a script nothing is
   * funded at — the same refusal `lockupSource` already makes before
   * registering a contract.
   */
  it('refuses a row whose stored pkScript is not what its own fields derive', () => {
    const drifted = rowWith({ pkScript: 'ab'.repeat(34) })
    expect(() => planUnilateralExit(drifted, { solverPubkey: hex.encode(CLIENT) })).toThrow(
      /does not derive its own pkScript/,
    )
  })

  it('carries the row’s id and script through, so the plan names what it will spend', () => {
    const row = rowWith()
    const plan = planUnilateralExit(row, { solverPubkey: hex.encode(CLIENT) })
    expect(plan.swapId).toBe('swap-1')
    expect(plan.pkScript).toBe(row.pkScript)
  })
})

describe('unilateralExitRecourse', () => {
  it('names the leaf and the delay so a parked row says what the next step is', () => {
    const line = unilateralExitRecourse(rowWith(), { solverPubkey: hex.encode(CLIENT) })
    expect(line).toContain('unilateralRefundWithoutReceiver')
    expect(line).toContain('8192')
  })

  it('names the reason instead of throwing, so a failure path can always record it', () => {
    const line = unilateralExitRecourse(rowWith(), { solverPubkey: hex.encode(key(21)) })
    expect(line).toMatch(/no server-independent recourse/)
    expect(line).toContain('neither the receiver nor the client')
  })

  it('never throws, whatever the row', () => {
    expect(() =>
      unilateralExitRecourse({ id: 'x' } as unknown as CovenantScriptRow, { solverPubkey: 'zz' }),
    ).not.toThrow()
  })
})
