import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { decodeInvoice } from '@arkade-os/solver-core/invoice/decode.js'

let dir: string
let statePath: string
let backend: FakeLightningBackend
let now = 1_800_000_000
const clock = () => now

beforeEach(() => {
  now = 1_800_000_000
  dir = mkdtempSync(join(tmpdir(), 'fake-ln-'))
  statePath = join(dir, 'state.json')
  backend = new FakeLightningBackend(statePath, 'bcrt', clock)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FakeLightningBackend — existing SendBackend behavior (regression lock)', () => {
  it('forges a payable invoice and pays it back, revealing the preimage', async () => {
    const { invoice, paymentHash } = backend.forgeInvoice(1000)
    const result = await backend.payInvoice({ invoice, maxFeeSats: 10, idempotencyKey: 'k', maxCltvBlocks: 450 })
    expect(result.status).toBe('succeeded')
    expect(result.preimage).toBeDefined()
    expect(hex.encode(sha256(hex.decode(result.preimage!)))).toBe(paymentHash)
  })

  it('fails an invoice it never forged', async () => {
    const foreign = backend.forgeInvoice(1000).invoice
    const other = new FakeLightningBackend(join(dir, 'other.json'), 'bcrt', clock)
    const result = await other.payInvoice({ invoice: foreign, maxFeeSats: 10, idempotencyKey: 'k', maxCltvBlocks: 450 })
    expect(result.status).toBe('failed')
  })

  it('getPayment polls back the same result payInvoice returned', async () => {
    const { invoice } = backend.forgeInvoice(1000)
    const paid = await backend.payInvoice({ invoice, maxFeeSats: 10, idempotencyKey: 'k', maxCltvBlocks: 450 })
    const polled = await backend.getPayment(paid.id)
    expect(polled).toEqual(paid)
  })

  it('getBalance reports an effectively unlimited balance', async () => {
    const balance = await backend.getBalance()
    expect(balance.availableSats).toBeGreaterThan(0)
  })
})

describe('FakeLightningBackend — ReceiveBackend', () => {
  it('createHoldInvoice mints a BOLT11 for the GIVEN hash, with no preimage known', async () => {
    const preimage = new Uint8Array(32).fill(7)
    const paymentHash = hex.encode(sha256(preimage))

    const held = await backend.createHoldInvoice({ amountSats: 5000, paymentHash, expirySeconds: 600 })
    expect(held.paymentHash).toBe(paymentHash)
    const decoded = decodeInvoice(held.invoice)
    expect(decoded.paymentHash).toBe(paymentHash)
    expect(decoded.amountSats).toBe(5000)
    expect(decoded.expiresAt).toBe(now + 600)

    // Paying it back through the SEND surface must fail: this fake never learned
    // the preimage for a hold invoice (by design — nobody tells it P), so a hold
    // invoice must not silently be payable the way a forged send invoice is.
    const result = await backend.payInvoice({
      invoice: held.invoice,
      maxFeeSats: 10,
      idempotencyKey: 'k',
      maxCltvBlocks: 450,
    })
    expect(result.status).toBe('failed')
  })

  it('getHoldState reports pending immediately after issuing, with no E yet', async () => {
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(1)))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })
    const state = await backend.getHoldState(paymentHash)
    expect(state.status).toBe('pending')
    expect(state.expiresAt).toBeNull()
  })

  it('getHoldState throws for a payment hash this backend never issued a hold for', async () => {
    await expect(backend.getHoldState('ab'.repeat(32))).rejects.toThrow()
  })

  it('armHold (test control) moves a hold to armed with a controllable E', async () => {
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(2)))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })

    backend.armHold(paymentHash, now + 3600)

    const state = await backend.getHoldState(paymentHash)
    expect(state.status).toBe('armed')
    expect(state.expiresAt).toBe(now + 3600)
  })

  it('armHold throws for a payment hash with no hold invoice issued', () => {
    expect(() => backend.armHold('cd'.repeat(32), now + 3600)).toThrow()
  })

  it('settleHold settles an armed hold and getHoldState reflects it', async () => {
    const preimage = new Uint8Array(32).fill(3)
    const paymentHash = hex.encode(sha256(preimage))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })
    backend.armHold(paymentHash, now + 3600)

    await backend.settleHold(hex.encode(preimage))

    const state = await backend.getHoldState(paymentHash)
    expect(state.status).toBe('settled')
  })

  it('settleHold rejects a preimage that does not match any armed hold — same contract as the real adapters', async () => {
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(4)))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })
    // Not armed yet.
    await expect(backend.settleHold(hex.encode(new Uint8Array(32).fill(4)))).rejects.toThrow()
  })

  it('settleHold rejects an unknown preimage entirely', async () => {
    await expect(backend.settleHold(hex.encode(new Uint8Array(32).fill(99)))).rejects.toThrow()
  })

  it('hold state survives across separate instances over the same state path (process-per-command)', async () => {
    const preimage = new Uint8Array(32).fill(5)
    const paymentHash = hex.encode(sha256(preimage))
    await backend.createHoldInvoice({ amountSats: 2000, paymentHash, expirySeconds: 600 })
    backend.armHold(paymentHash, now + 1800)

    const second = new FakeLightningBackend(statePath, 'bcrt', clock)
    const state = await second.getHoldState(paymentHash)
    expect(state.status).toBe('armed')
    expect(state.expiresAt).toBe(now + 1800)
  })

  it('does not confuse hold state with the unrelated send-side preimage map', async () => {
    // Forge (send-side) and create a hold (receive-side) that happen to differ —
    // the two maps must not collide on the same underlying file.
    const forged = backend.forgeInvoice(1000)
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(6)))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })

    const sent = await backend.payInvoice({
      invoice: forged.invoice,
      maxFeeSats: 10,
      idempotencyKey: 'k',
      maxCltvBlocks: 450,
    })
    expect(sent.status).toBe('succeeded')
    const held = await backend.getHoldState(paymentHash)
    expect(held.status).toBe('pending')
  })
})

describe('FakeLightningBackend — getOwnInvoiceState (the self-payment probe)', () => {
  it('reports a hold this backend minted, unpaid', async () => {
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(8)))
    await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })
    await expect(backend.getOwnInvoiceState(paymentHash)).resolves.toMatchObject({ status: 'pending' })
  })

  it('answers null for a hash it never minted — where getHoldState would throw', async () => {
    await expect(backend.getOwnInvoiceState('ab'.repeat(32))).resolves.toBeNull()
  })

  it('a hold it minted fails terminally when paid back to itself — the #41 repro shape', async () => {
    const paymentHash = hex.encode(sha256(new Uint8Array(32).fill(9)))
    const held = await backend.createHoldInvoice({ amountSats: 1000, paymentHash, expirySeconds: 600 })
    const result = await backend.payInvoice({
      invoice: held.invoice,
      maxFeeSats: 10,
      idempotencyKey: 'k',
      maxCltvBlocks: 450,
    })
    expect(result.status).toBe('failed')
    // ...and the probe still vouches: ours, and never paid.
    await expect(backend.getOwnInvoiceState(paymentHash)).resolves.toMatchObject({ status: 'pending' })
  })
})
