import { describe, expect, it } from 'vitest'
import {
  CLAIM_UNPROVEN,
  claimClientLockup,
  type ClientLockupClaim,
} from '@arkade-os/solver-corridors/legs/clientLockupClaim.js'

type State = 'claiming' | 'claimed'
const PREIMAGE = 'cc'.repeat(32)
const OURS = { txid: 'f1', vout: 0, value: 1_000 }
const ADOPTED = JSON.stringify([OURS])

/** A claim against a recording store and a fake Arkade; `world` holds what the fake answers. */
const setUp = (over: { row?: object; flags?: Partial<ClientLockupClaim<State>> } = {}) => {
  const world = {
    lockups: [OURS] as { txid: string; vout: number; value: number }[],
    outpoints: undefined as
      undefined | { txid: string; vout: number; value: number; spent: boolean; unrolled: boolean }[],
    evidence: 'unspent' as 'spent' | 'unspent' | 'unknown',
    pending: undefined as undefined | string | null,
    revealed: undefined as undefined | Uint8Array | null,
    claim: 'claim-txid' as string | Error,
    refund: 'refund-txid' as string | Error,
    pastDeadline: false,
  }
  const calls: string[] = []
  const writes: unknown[][] = []
  const alerts: unknown[] = []
  const arkade = {
    providerPubkey: '00'.repeat(32),
    findLockups: async () => (calls.push('findLockups'), world.lockups),
    lockupSpendEvidence: async () => (calls.push('lockupSpendEvidence'), world.evidence),
    claim: async (_row: unknown, outputs: { txid: string }[]) => {
      calls.push(`claim(${outputs.map((o) => o.txid).join(',')})`)
      if (world.claim instanceof Error) throw world.claim
      return world.claim
    },
    refund: async (_row: unknown, outputs: { txid: string }[]) => {
      calls.push(`refund(${outputs.map((o) => o.txid).join(',')})`)
      if (world.refund instanceof Error) throw world.refund
      return world.refund
    },
    get findLockupOutpoints() {
      return world.outpoints === undefined
        ? undefined
        : async () => (calls.push('findLockupOutpoints'), world.outpoints!)
    },
    get findClaimPreimage() {
      return world.revealed === undefined ? undefined : async () => (calls.push('findClaimPreimage'), world.revealed!)
    },
    get finalizePendingClaim() {
      return world.pending === undefined ? undefined : async () => (calls.push('finalizePendingClaim'), world.pending!)
    },
  }
  const store = {
    patch: async (id: string, fields: object) => void writes.push(['patch', id, fields]),
    transition: async (id: string, from: State, to: State, fields: object = {}) => {
      writes.push(['transition', id, from, to, fields])
      return true
    },
    fail: async (id: string, from: State, reason: string) => {
      writes.push(['fail', id, from, reason])
      return true
    },
  }
  const run = () =>
    claimClientLockup<State>({
      store: store as never,
      arkade: arkade as never,
      row: {
        id: 'swap',
        pkScript: 'pk',
        paymentHash: 'hash',
        amountSats: 1_000,
        lockupOutpoints: ADOPTED,
        unrolledClaim: null,
        ...over.row,
      },
      covenantRow: {} as never,
      preimage: PREIMAGE,
      edge: { from: 'claiming', to: 'claimed' },
      now: () => 1_800_000_000,
      refundDeadlineReached: async () => (calls.push('deadline'), world.pastDeadline),
      readsDeadlineWithEvidence: false,
      recognisesOwnClaim: false,
      onTickError: (_id, error) => void alerts.push(error),
      ...over.flags,
    })
  return { world, calls, writes, alerts, run }
}

describe('claimClientLockup: the lockup is there', () => {
  it('claims the adopted outputs and records the claim', async () => {
    const { calls, writes, run } = setUp()
    await run()
    expect(calls).toEqual(['findLockups', 'claim(f1)'])
    expect(writes).toEqual([['transition', 'swap', 'claiming', 'claimed', { claim_ark_txid: 'claim-txid' }]])
  })

  it('returns what was not adopted to the client, and only reports it when that fails', async () => {
    const stray = { txid: 'stray', vout: 0, value: 50 }
    const { world, calls, alerts, writes, run } = setUp()
    world.lockups = [OURS, stray]
    world.refund = new Error('refund refused')
    await run()
    expect(calls).toEqual(['findLockups', 'claim(f1)', 'refund(stray)'])
    expect(alerts).toEqual([world.refund])
    expect(writes).toEqual([['transition', 'swap', 'claiming', 'claimed', { claim_ark_txid: 'claim-txid' }]])
  })

  it('rethrows a failing claim before the refund deadline and writes nothing', async () => {
    const { world, writes, run } = setUp()
    world.claim = new Error('arkd down')
    await expect(run()).rejects.toThrow('arkd down')
    expect(writes).toEqual([])
  })

  it('hands a claim failing past the refund deadline to a human, with the way out', async () => {
    const { world, writes, run } = setUp()
    world.claim = new Error('arkd down')
    world.pastDeadline = true
    expect(await run()).toBe(false)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
    expect(writes[0]![3]).toMatch(/^claim failing past the refund deadline: arkd down — /)
  })

  it('does not record claimed while an adopted output is still out', async () => {
    // One claim spends at most 16 outputs, so the 17th stays out.
    const many = Array.from({ length: 17 }, (_, i) => ({ txid: `f${i}`, vout: 0, value: i === 0 ? 984 : 1 }))
    const spread = (pastDeadline: boolean) => {
      const set = setUp({ row: { lockupOutpoints: JSON.stringify(many) } })
      set.world.lockups = many
      set.world.outpoints = many.map((o) => ({ ...o, spent: false, unrolled: false }))
      set.world.pastDeadline = pastDeadline
      return set
    }
    const early = spread(false)
    await expect(early.run()).rejects.toThrow('not yet collected')
    expect(early.writes).toEqual([['patch', 'swap', { claim_ark_txid: 'claim-txid' }]])

    const late = spread(true)
    expect(await late.run()).toBe(false)
    expect(late.writes.at(-1)!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
    expect(late.writes.at(-1)![3]).toContain('uncollected at the refund deadline')
  })
})

describe('claimClientLockup: the lockup reads short', () => {
  const short = (flags: Partial<ClientLockupClaim<State>> = {}) => {
    const set = setUp({ flags })
    set.world.lockups = []
    return set
  }

  it('retries while no spend is provable and the refund is closed', async () => {
    const { calls, writes, run } = short()
    await expect(run()).rejects.toThrow('lockup holds 0 < 1000 while claiming but no spend is provable (unspent)')
    expect(calls).toEqual(['findLockups', 'lockupSpendEvidence', 'deadline'])
    expect(writes).toEqual([])
  })

  it('starts the deadline read beside the evidence read when asked to', async () => {
    const { calls, run } = short({ readsDeadlineWithEvidence: true })
    await expect(run()).rejects.toThrow('no spend is provable')
    expect(calls.slice(1, 3).sort()).toEqual(['deadline', 'lockupSpendEvidence'])
  })

  it('finishes a claim of ours that arkd accepted and never finalized', async () => {
    const { world, writes, run } = short()
    world.evidence = 'spent'
    world.pending = 'pending-txid'
    await run()
    expect(writes).toEqual([['transition', 'swap', 'claiming', 'claimed', { claim_ark_txid: 'pending-txid' }]])
  })

  it('needs a human for a spend it cannot call its own, in the words the boot-time re-arm looks for', async () => {
    const { world, writes, run } = short()
    world.evidence = 'spent'
    world.pending = null
    expect(await run()).toBe(false)
    expect(writes).toEqual([
      ['fail', 'swap', 'claiming', `lockup holds 0 < amount 1000 ${CLAIM_UNPROVEN}; needs review`],
    ])
    expect(CLAIM_UNPROVEN).toBe('while claiming; no claim txid recorded')
  })

  it('gives up the same way past the deadline with no spend proven', async () => {
    const { world, writes, run } = short()
    world.pastDeadline = true
    expect(await run()).toBe(false)
    expect(writes[0]!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
  })

  describe('recognising its own claim', () => {
    const spentByPreimage = (flags: Partial<ClientLockupClaim<State>>) => {
      const set = short(flags)
      set.world.evidence = 'spent'
      set.world.outpoints = [{ ...OURS, spent: true, unrolled: false }]
      set.world.revealed = new Uint8Array(32)
      return set
    }

    it('records claimed, with no txid, when the spend of every adopted output reveals our preimage', async () => {
      const { writes, run } = spentByPreimage({ recognisesOwnClaim: true })
      await run()
      expect(writes).toEqual([['transition', 'swap', 'claiming', 'claimed', { claim_ark_txid: null }]])
    })

    it('does not look when the corridor does not ask for it', async () => {
      const { calls, writes, run } = spentByPreimage({ recognisesOwnClaim: false })
      expect(await run()).toBe(false)
      expect(calls).not.toContain('findClaimPreimage')
      expect(writes[0]!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
    })

    it('needs a human when the spend does not reveal it', async () => {
      const set = spentByPreimage({ recognisesOwnClaim: true })
      set.world.revealed = null
      expect(await set.run()).toBe(false)
      expect(set.writes[0]!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
    })

    it('needs a human for a row with no adopted outputs to check against', async () => {
      const set = setUp({ row: { lockupOutpoints: null }, flags: { recognisesOwnClaim: true } })
      set.world.lockups = []
      set.world.evidence = 'spent'
      set.world.outpoints = [{ ...OURS, spent: true, unrolled: false }]
      set.world.revealed = new Uint8Array(32)
      expect(await set.run()).toBe(false)
      expect(set.writes[0]!.slice(0, 3)).toEqual(['fail', 'swap', 'claiming'])
    })
  })
})
