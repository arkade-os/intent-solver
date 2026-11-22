// Random worlds for EVM receive's preimage read, each checked against what reading Arkade alone answers.
import { it, expect } from 'vitest'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { evmReceiveArkadeDeps } from '@arkade-os/solver-corridors-evm/receive/evmArkadeDeps.js'

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

it('keeps its invariants over random lockups, claims and L1 answers', async () => {
  const count = 1000
  const seen = { same: 0, l1Found: 0, l1Null: 0, l1FailedQuiet: 0, bothThrew: 0, noBackend: 0 }
  const bad: string[] = []
  for (let seed = 0; seed < count; seed++) {
    const rand = rng(seed)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const P = new Uint8Array(32).fill(1 + Math.floor(rand() * 200))
    const paymentHash = hex.encode(sha256(P))
    const row = { id: `row-${seed}`, pkScript: 'ab'.repeat(34), paymentHash } as never
    const outpoints = Array.from({ length: Math.floor(rand() * 4) }, (_, n) => ({
      txid: `t${n}`,
      vout: 0,
      value: 1000,
      spent: rand() < 0.5,
      ...(rand() < 0.4 ? { unrolled: true } : {}),
    }))
    const arkadeOutpoints = pick(['ok', 'ok', 'ok', 'throws'] as const)
    const arkadeClaim = pick(['none', 'none', 'P', 'throws'] as const)
    const witnessFor = new Map(
      outpoints.map((o) => [o.txid, pick(['null', 'P', 'garbage', 'other32', 'throws'] as const)]),
    )
    const hasBackend = rand() < 0.8
    const l1Calls: string[] = []
    const reads = {
      findLockupOutpoints: async () => {
        if (arkadeOutpoints === 'throws') throw new Error('indexer down')
        return outpoints
      },
      findClaimPreimage: async () => {
        if (arkadeClaim === 'throws') throw new Error('claim read down')
        return arkadeClaim === 'P' ? P : null
      },
    }
    const arkade = reads as never
    const onchain = {
      findSpendWitness: async ({ txid }: { txid: string }) => {
        l1Calls.push(txid)
        const kind = witnessFor.get(txid)
        if (kind === 'throws') throw new Error('esplora down')
        if (kind === 'P') return [new Uint8Array(64), P]
        if (kind === 'garbage') return [new Uint8Array(64), new Uint8Array(33)]
        if (kind === 'other32') return [new Uint8Array(32).fill(250)]
        return null
      },
    }
    const arkadeAlone = async (): Promise<string | null> => {
      const found = await reads.findLockupOutpoints()
      if (found.length === 0) return null
      const preimage = await reads.findClaimPreimage()
      return preimage === null ? null : hex.encode(preimage)
    }
    const settle = async (run: () => Promise<string | null>) =>
      run().then(
        (value) => ({ value }),
        (error: Error) => ({ error: error.message }),
      )
    const before = await settle(arkadeAlone)
    const reports: string[] = []
    const after = await settle(() =>
      evmReceiveArkadeDeps(arkade, hasBackend ? onchain : undefined, (_id, e) =>
        reports.push(e.message),
      ).arkadePreimage(row),
    )
    const unrolled = outpoints.filter((o) => 'unrolled' in o)
    const fail = (why: string) =>
      bad.length < 5 &&
      bad.push(`seed ${seed}: ${why} | before ${JSON.stringify(before)} after ${JSON.stringify(after)}`)

    if ('error' in before) {
      if (!('error' in after) || after.error !== before.error) fail('an Arkade read failure must surface unchanged')
      else seen.bothThrew++
      if (l1Calls.length > 0) fail('L1 was asked although the Arkade read failed')
      continue
    }
    if ('error' in after) {
      fail('threw where reading Arkade alone answers')
      continue
    }
    if (after.value !== null && hex.encode(sha256(hex.decode(after.value))) !== paymentHash)
      fail('a preimage that does not open the hash')
    if (before.value !== null) {
      if (after.value !== before.value) fail('lost a preimage reading Arkade alone finds')
      if (l1Calls.length > 0) fail('L1 was asked although Arkade already revealed the preimage')
      seen.same++
      continue
    }
    if (unrolled.length === 0 || !hasBackend) {
      if (after.value !== null) fail('found a preimage with nothing to read it from')
      if (l1Calls.length > 0) fail('L1 was asked with no unrolled outpoint')
      if (unrolled.length > 0 && !hasBackend) seen.noBackend++
      else seen.same++
      continue
    }
    const kinds = unrolled.map((o) => witnessFor.get(o.txid))
    if (
      l1Calls.slice().sort().join() !==
      unrolled
        .map((o) => o.txid)
        .sort()
        .join()
    )
      fail('L1 was not asked once per unrolled outpoint')
    if (kinds.includes('P')) {
      if (after.value !== hex.encode(P)) fail('P was on L1 and was not read')
      else seen.l1Found++
    } else if (after.value !== null) fail('a preimage from a witness that does not hold it')
    else if (kinds.includes('throws')) {
      if (!reports.includes('esplora down')) fail('an L1 failure was swallowed without a report')
      seen.l1FailedQuiet++
    } else seen.l1Null++
  }
  expect(bad).toEqual([])
  for (const reached of Object.values(seen)) expect(reached).toBeGreaterThan(0)
}, 30_000)
