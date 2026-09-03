/**
 * Driving `UnilateralExit` at a covenant lockup, and the checks around it.
 *
 * The SDK primitive is injected rather than reached: `estimate` and `prepare`
 * both need a live indexer, an Esplora endpoint and a funded onchain wallet, and
 * `prepare` BROADCASTS a funding splitter as a side effect. What is testable
 * here — and what decides whether money moves the right way — is everything
 * around the call: that the contract row the SDK resolves the leaf from says
 * what we think it says, that the preimage is on it before a claim leg is
 * attempted, and that what came back is the leaf we planned.
 *
 * The leaf check reads the DELAY, not a label. `resolveUnilateralPath` reports
 * `<type>:unilateral` whichever leaf it chose, so the label cannot distinguish
 * them; the two leaves' CSVs differ by the solo-refund headroom, and
 * `planUnilateralExit` refuses any row where they do not. That is what makes the
 * delay a faithful proxy for the leaf.
 */
import { describe, it, expect, vi } from 'vitest'
import { hex } from '@scure/base'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { CovenantScriptRow } from '@arkade-os/solver-arkade/arkade/covenantRow.js'
import {
  planUnilateralExit,
  quoteUnilateralExit,
  startUnilateralExit,
  type ExitContractAccess,
  type UnilateralExitDeps,
} from '@arkade-os/solver-arkade/arkade/unilateralExit.js'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const RECEIVER = hex.encode(key(1))
const SERVER = hex.encode(key(3))
const EMULATOR = hex.encode(key(9))
const CLIENT = hex.encode(key(11))
const PREIMAGE = new Uint8Array(32).fill(7)
const PREIMAGE_HEX = hex.encode(PREIMAGE)
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE))

const CLAIM_DELAY = 4096
const SOLO_REFUND_DELAY = 8192

const row = (): CovenantScriptRow => {
  const base = {
    id: 'swap-1',
    receiverPubkey: RECEIVER,
    serverPubkey: SERVER,
    paymentHash: PAYMENT_HASH,
    refundLocktime: 1_800_000_000,
    claimDelay: CLAIM_DELAY,
    emulatorPubkey: EMULATOR,
    refundPkScript: hex.encode(p2tr(key(5))),
    pkScript: '',
    clientRefundPubkey: CLIENT,
    refundWithoutReceiverDelay: SOLO_REFUND_DELAY,
    refundDelay: 4096,
    receiverPkScript: hex.encode(p2tr(key(13))),
    nonInteractiveParameters: true,
  }
  const script = new CovenantSwapScript({
    receiver: hex.decode(base.receiverPubkey),
    server: hex.decode(base.serverPubkey),
    preimageHash: ripemd160(hex.decode(base.paymentHash)),
    refundLocktime: base.refundLocktime,
    claimDelay: base.claimDelay,
    client: hex.decode(base.clientRefundPubkey),
    clientRefundDelay: base.refundWithoutReceiverDelay,
    refundWithoutServerDelay: base.refundDelay,
    nonInteractiveParameters: {
      emulatorPubkey: hex.decode(base.emulatorPubkey),
      receiverPkScript: hex.decode(base.receiverPkScript),
      senderPkScript: hex.decode(base.refundPkScript),
    },
  })
  return { ...base, pkScript: hex.encode(script.pkScript) }
}

/** The registered contract row, as the SDK's own handler serializes one. */
const registeredParams = (over: Record<string, string> = {}): Record<string, string> => ({
  sender: CLIENT,
  receiver: RECEIVER,
  server: SERVER,
  hash: hex.encode(ripemd160(hex.decode(PAYMENT_HASH))),
  refundLocktime: '1800000000',
  claimDelay: '4194312',
  refundDelay: '4194312',
  refundNoReceiverDelay: '4194320',
  ...over,
})

const contractsWith = (
  params: Record<string, string> | null,
): ExitContractAccess & { written: Record<string, string> } => {
  const store = { ...(params ?? {}) }
  return {
    written: store,
    params: async () => (params === null ? null : store),
    patchParams: async (_script, patch) => {
      Object.assign(store, patch)
    },
  }
}

/** One unspent outpoint at the lockup, and a quote/package that includes it. */
const OUTPOINT = { txid: 'aa'.repeat(32), vout: 0 }

const infoFor = (delay: { type: 'seconds' | 'blocks'; value: number }) => ({
  outpoint: `${OUTPOINT.txid}:0`,
  value: 100_000,
  sweepFee: 300,
  path: 'vhtlc-v2:unilateral',
  delay,
})

const depsWith = (
  over: Partial<UnilateralExitDeps> & { infos?: unknown[]; contracts?: ExitContractAccess } = {},
): UnilateralExitDeps => {
  const infos = over.infos ?? [infoFor({ type: 'seconds', value: SOLO_REFUND_DELAY })]
  return {
    exit: {
      estimate: vi.fn(async () => ({ vtxos: infos, totals: { txCount: 3 } })),
      prepare: vi.fn(async () => ({ vtxos: infos, steps: [] })),
      ...(over.exit ?? {}),
    },
    options: { sweepAddress: 'bcrt1qexample' },
    contracts: over.contracts ?? contractsWith(registeredParams()),
    findLockups: over.findLockups ?? (async () => [OUTPOINT]),
  } as unknown as UnilateralExitDeps
}

const refundPlan = () => planUnilateralExit(row(), { solverPubkey: CLIENT })
const claimPlan = () => planUnilateralExit(row(), { solverPubkey: RECEIVER, preimage: PREIMAGE_HEX })

describe('quoteUnilateralExit', () => {
  it('quotes against the lockup’s own unspent outpoints and touches no funds', async () => {
    const deps = depsWith()
    const outcome = await quoteUnilateralExit(deps, refundPlan())
    expect(outcome.outpoints).toEqual([OUTPOINT])
    expect(deps.exit.estimate).toHaveBeenCalledWith(expect.objectContaining({ vtxos: [OUTPOINT] }))
    // Quoting must never reach `prepare`, which broadcasts a funding splitter.
    expect(deps.exit.prepare).not.toHaveBeenCalled()
  })

  it('refuses a lockup with nothing unspent at it rather than quoting an empty exit', async () => {
    const deps = depsWith({ findLockups: async () => [] })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/nothing unspent/)
  })

  it('refuses when no contract is registered for the script — the SDK resolves the leaf from that row', async () => {
    const deps = depsWith({ contracts: contractsWith(null) })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/no contract registered/)
  })

  it('refuses when the registered row does not name the solver in the role the plan resolved', async () => {
    const deps = depsWith({ contracts: contractsWith(registeredParams({ sender: hex.encode(key(21)) })) })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/does not name the solver as its sender/)
  })

  it('refuses when the registered row names the solver in BOTH roles', async () => {
    const deps = depsWith({ contracts: contractsWith(registeredParams({ receiver: CLIENT })) })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/both/)
  })

  it('refuses when the delay that came back is not the planned leaf’s', async () => {
    const deps = depsWith({ infos: [infoFor({ type: 'seconds', value: CLAIM_DELAY })] })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/a leaf this plan did not choose/)
  })

  it('refuses when the delay that came back counts a different clock', async () => {
    const deps = depsWith({ infos: [infoFor({ type: 'blocks', value: SOLO_REFUND_DELAY })] })
    await expect(quoteUnilateralExit(deps, refundPlan())).rejects.toThrow(/a leaf this plan did not choose/)
  })

  it('reports a skipped outpoint rather than silently exiting the rest', async () => {
    const deps = depsWith({
      infos: [
        infoFor({ type: 'seconds', value: SOLO_REFUND_DELAY }),
        { outpoint: `${'bb'.repeat(32)}:1`, value: 400, skipped: 'uneconomic: value 400 <= sweep fee + dust' },
      ],
    })
    const outcome = await quoteUnilateralExit(deps, refundPlan())
    expect(outcome.skipped).toEqual([
      { outpoint: `${'bb'.repeat(32)}:1`, reason: 'uneconomic: value 400 <= sweep fee + dust' },
    ])
  })

  it('does not write a preimage onto a refund leg’s contract row — that leaf takes none', async () => {
    const contracts = contractsWith(registeredParams())
    await quoteUnilateralExit(depsWith({ contracts }), refundPlan())
    expect(contracts.written.preimage).toBeUndefined()
  })
})

describe('quoteUnilateralExit on a claim leg', () => {
  const claimInfos = [infoFor({ type: 'seconds', value: CLAIM_DELAY })]

  it('arms the contract row with the preimage, without which the SDK offers no path at all', async () => {
    const contracts = contractsWith(registeredParams())
    await quoteUnilateralExit(depsWith({ contracts, infos: claimInfos }), claimPlan())
    expect(contracts.written.preimage).toBe(PREIMAGE_HEX)
  })

  it('overwrites a preimage on the row that is not the one this plan verified', async () => {
    const contracts = contractsWith(registeredParams({ preimage: 'ff'.repeat(32) }))
    await quoteUnilateralExit(depsWith({ contracts, infos: claimInfos }), claimPlan())
    expect(contracts.written.preimage).toBe(PREIMAGE_HEX)
  })

  it('accepts the claim leaf’s own, shorter delay', async () => {
    const outcome = await quoteUnilateralExit(depsWith({ infos: claimInfos }), claimPlan())
    expect(outcome.plan.leaf).toBe('unilateralClaim')
    expect(outcome.skipped).toEqual([])
  })
})

describe('startUnilateralExit', () => {
  it('prepares the package — the one call that broadcasts a funding splitter', async () => {
    const deps = depsWith()
    const outcome = await startUnilateralExit(deps, refundPlan())
    expect(deps.exit.prepare).toHaveBeenCalledWith(expect.objectContaining({ vtxos: [OUTPOINT] }))
    expect(outcome.result).toEqual({ vtxos: expect.any(Array), steps: [] })
  })

  it('applies the same leaf check as the quote, so a wrong leaf is refused before the executor runs', async () => {
    const deps = depsWith({ infos: [infoFor({ type: 'seconds', value: CLAIM_DELAY })] })
    await expect(startUnilateralExit(deps, refundPlan())).rejects.toThrow(/a leaf this plan did not choose/)
  })

  it('arms the contract row BEFORE preparing, never after', async () => {
    const order: string[] = []
    const contracts: ExitContractAccess = {
      params: async () => registeredParams(),
      patchParams: async () => {
        order.push('arm')
      },
    }
    const deps = depsWith({
      contracts,
      infos: [infoFor({ type: 'seconds', value: CLAIM_DELAY })],
      exit: {
        estimate: vi.fn(),
        prepare: vi.fn(async () => {
          order.push('prepare')
          return { vtxos: [infoFor({ type: 'seconds', value: CLAIM_DELAY })], steps: [] }
        }),
      },
    } as never)
    await startUnilateralExit(deps, claimPlan())
    expect(order).toEqual(['arm', 'prepare'])
  })
})
