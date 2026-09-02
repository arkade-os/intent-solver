import { describe, it, expect } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import type { CovenantScriptRow } from '@arkade-os/solver-corridors/send/orchestrator.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER = key(1)
const SERVER = key(3)
const EMULATOR = key(9)
const DEST = p2tr(key(5))
const CLIENT = key(11)
const RECEIVER_PAYOUT = p2tr(key(13))
const PAYMENT_HASH_HEX = hex.encode(sha256(new Uint8Array(32).fill(7)))
const PREIMAGE_HASH = ripemd160(sha256(new Uint8Array(32).fill(7)))
const REFUND_LOCKTIME = 1_800_000_000
const CLAIM_DELAY = 4096
const CLIENT_REFUND_DELAY = 6144
const REFUND_WITHOUT_SERVER_DELAY = 5120

const scriptParams = (nineLeaf: boolean) => ({
  receiver: RECEIVER,
  server: SERVER,
  preimageHash: PREIMAGE_HASH,
  refundLocktime: REFUND_LOCKTIME,
  claimDelay: CLAIM_DELAY,
  client: CLIENT,
  clientRefundDelay: CLIENT_REFUND_DELAY,
  refundWithoutServerDelay: REFUND_WITHOUT_SERVER_DELAY,
  nonInteractiveParameters: {
    emulatorPubkey: EMULATOR,
    receiverPkScript: RECEIVER_PAYOUT,
    senderPkScript: DEST,
    ...(nineLeaf ? {} : { legacy: 'preTimelockedRefund' as const }),
  },
})

/**
 * A `CovenantScriptRow` for a lockup actually funded against `script` —
 * `pkScript` is read off the script itself rather than independently
 * guessed, so a test that gets the flag wrong fails on a real pkScript
 * mismatch, the same way `assertScriptMatchesRow` would in production,
 * rather than comparing two fixtures that were never consistent to begin
 * with.
 */
const rowFundedAgainst = (script: CovenantSwapScript, nonInteractiveParameters: boolean | null): CovenantScriptRow => ({
  id: 'test-swap',
  receiverPubkey: hex.encode(RECEIVER),
  serverPubkey: hex.encode(SERVER),
  paymentHash: PAYMENT_HASH_HEX,
  refundLocktime: REFUND_LOCKTIME,
  claimDelay: CLAIM_DELAY,
  emulatorPubkey: hex.encode(EMULATOR),
  refundPkScript: hex.encode(DEST),
  pkScript: hex.encode(script.pkScript),
  clientRefundPubkey: hex.encode(CLIENT),
  refundWithoutReceiverDelay: CLIENT_REFUND_DELAY,
  refundDelay: REFUND_WITHOUT_SERVER_DELAY,
  receiverPkScript: hex.encode(RECEIVER_PAYOUT),
  nonInteractiveParameters,
})

/**
 * `covenantScriptFromRow` rebuilds a lockup's script FROM THE ROW, never
 * from what today's code would choose — its own doc comment says so, and
 * `send/arkadeOps.ts`'s `assertScriptMatchesRow` is what makes a wrong
 * rebuild loud (a signature error rather than a silently wrong refund
 * destination). The timelocked non-interactive refund leaf moves `pkScript` — a ninth
 * tapleaf — so it is exactly the kind of change that gate exists to catch:
 * a row funded before the leaf existed must still rebuild the eight-leaf
 * shape (`legacy: 'preTimelockedRefund'`), or the solver can no longer
 * claim or refund a swap it may already have paid out on.
 */
describe('covenantScriptFromRow — the timelocked non-interactive refund leaf', () => {
  it('rebuilds the eight-leaf shape for a row that predates the leaf, matching its stored pkScript', () => {
    // The regression this whole rework exists to prevent. `null` is not a
    // guess at "probably off" — `covenantScriptFromRow` must read it as
    // "rebuild exactly what was funded", the eight-leaf script, or every
    // in-flight swap from before this leaf shipped bricks on deploy.
    const funded = new CovenantSwapScript(scriptParams(false))
    expect(funded.leafCount).toBe(8)
    const row = rowFundedAgainst(funded, null)

    const rebuilt = covenantScriptFromRow(row)

    expect(rebuilt.leafCount).toBe(8)
    expect(hex.encode(rebuilt.pkScript)).toBe(row.pkScript)
  })

  it('rebuilds the nine-leaf shape for a row quoted with the leaf on, matching its stored pkScript', () => {
    const funded = new CovenantSwapScript(scriptParams(true))
    expect(funded.leafCount).toBe(9)
    const row = rowFundedAgainst(funded, true)

    const rebuilt = covenantScriptFromRow(row)

    expect(rebuilt.leafCount).toBe(9)
    expect(hex.encode(rebuilt.pkScript)).toBe(row.pkScript)
  })

  it('the two shapes derive different pkScripts — a row that gets this wrong cannot silently match', () => {
    // If both fixtures above happened to derive the SAME pkScript, neither
    // test could ever catch a dropped or wrongly-added flag. This is what
    // rules that out.
    const withFlag = new CovenantSwapScript(scriptParams(true))
    const withoutFlag = new CovenantSwapScript(scriptParams(false))
    expect(hex.encode(withFlag.pkScript)).not.toBe(hex.encode(withoutFlag.pkScript))
  })
})
