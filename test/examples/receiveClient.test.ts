// The receive reference client's claim gate. These drive `claimReceived` rather
// than the filter under it: the gate protects nothing unless signing runs it.

import { describe, it, expect } from 'vitest'
import { ArkAddress } from '@arkade-os/sdk'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { deriveUnilateralDelays } from '@arkade-os/solver-core/core/timelocks.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
// @ts-expect-error -- untyped .mjs example, which is the point: this is the file integrators copy
import { claimReceived, deriveReceiveLockup } from '../../examples/lib/receive-client.mjs'

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const SERVER = key(3)
const EMULATOR = key(9)
const PREIMAGE = new Uint8Array(32).fill(7)
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE))
const PAYOUT_PUBKEY = hex.encode(key(1))
const PAYOUT_ADDRESS = new ArkAddress(SERVER, key(2), 'tark').encode()
const PAYOUT_SATS = 4_900

const arkade = {
  wallet: { arkServerPublicKey: SERVER },
  unilateralDelays: deriveUnilateralDelays(4096),
  hrp: 'tark',
}

const quoteFor = (lockupAddress: string) => ({
  v: 1,
  type: 'rfq_quote',
  rfq_id: 'a'.repeat(64),
  pair: 'lightning:BTC->arkade:BTC',
  from_amount: 5_000,
  to_amount: PAYOUT_SATS,
  solver_pubkey: hex.encode(key(11)),
  valid_until: 2_000_000_000,
  refund_locktime: 1_800_000_000,
  profile: {
    payment_hash: PAYMENT_HASH,
    invoice: 'lnbcrt50u1p0fake',
    lockup_address: lockupAddress,
    solver_refund_pk_script: hex.encode(p2tr(key(5))),
  },
})

const derived = deriveReceiveLockup({
  quote: quoteFor('unused-by-derivation'),
  arkade,
  paymentHash: PAYMENT_HASH,
  payoutAddress: PAYOUT_ADDRESS,
  payoutPubkey: PAYOUT_PUBKEY,
  emulatorPubkey: hex.encode(EMULATOR),
})
const QUOTE = quoteFor(derived.candidates[0].address)

const output = (value: number, vout = 0): FundedOutput => ({ txid: 'f'.repeat(64), vout, value })

const runClaim = async (reads: FundedOutput[][], quote: ReturnType<typeof quoteFor> = QUOTE) => {
  const claimed: FundedOutput[][] = []
  let attempt = 0
  const promise = claimReceived({
    arkade,
    quote,
    preimage: PREIMAGE,
    payoutAddress: PAYOUT_ADDRESS,
    payoutPubkey: PAYOUT_PUBKEY,
    emulatorPubkey: hex.encode(EMULATOR),
    attempts: reads.length,
    intervalMs: 0,
    read: async () => reads[attempt++] ?? [],
    claim: async (_ctx: unknown, _script: unknown, outputs: FundedOutput[]) => {
      claimed.push(outputs)
      return 'claimtxid'
    },
  })
  return { promise, claimed, reads: () => attempt }
}

describe('receive reference client', () => {
  it('claims the quoted output once the indexer surfaces it', async () => {
    const run = await runClaim([[], [], [output(PAYOUT_SATS)]])
    await expect(run.promise).resolves.toMatchObject({ txid: 'claimtxid' })
    expect(run.claimed).toEqual([[output(PAYOUT_SATS)]])
  })

  it('refuses an underpaid lockup instead of claiming it', async () => {
    const run = await runClaim([[output(PAYOUT_SATS - 1)], [output(PAYOUT_SATS - 1)]])
    await expect(run.promise).rejects.toMatchObject({
      name: 'LockupAmountMismatch',
      expected: PAYOUT_SATS,
      found: [PAYOUT_SATS - 1],
    })
    expect(run.claimed).toEqual([])
  })

  it('names an empty script as a wait, not a mismatch', async () => {
    const run = await runClaim([[], []])
    await expect(run.promise).rejects.toMatchObject({ name: 'LockupNotFunded' })
    expect(run.claimed).toEqual([])
  })

  it('claims only the quoted output when a stray payment shares the script', async () => {
    const run = await runClaim([[output(546, 1), output(PAYOUT_SATS)]])
    await expect(run.promise).resolves.toMatchObject({ txid: 'claimtxid' })
    expect(run.claimed).toEqual([[output(PAYOUT_SATS)]])
  })

  it('claims both when the solver funded the quoted amount twice', async () => {
    const run = await runClaim([[output(PAYOUT_SATS), output(PAYOUT_SATS, 1)]])
    await expect(run.promise).resolves.toMatchObject({ txid: 'claimtxid' })
    expect(run.claimed).toEqual([[output(PAYOUT_SATS), output(PAYOUT_SATS, 1)]])
  })

  it('refuses without an emulator key of its own', async () => {
    await expect(
      claimReceived({
        arkade,
        quote: QUOTE,
        preimage: PREIMAGE,
        payoutAddress: PAYOUT_ADDRESS,
        payoutPubkey: PAYOUT_PUBKEY,
      }),
    ).rejects.toThrow(/emulatorPubkey or an emulatorUrl/)
  })

  it('refuses on the script before it ever reads the chain', async () => {
    const foreign = quoteFor(new ArkAddress(SERVER, key(4), 'tark').encode())
    const run = await runClaim([[output(PAYOUT_SATS)]], foreign)
    await expect(run.promise).rejects.toMatchObject({ name: 'AddressMismatch' })
    expect(run.reads()).toBe(0)
  })
})
