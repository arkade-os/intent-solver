import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hex } from '@scure/base'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { AdmissionControl } from '@arkade-os/solver-core/core/admission.js'
import { betterSqliteDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { ReceiveSwapService } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { DriveSwap } from '@arkade-os/solver-next/application/drive_swap.js'
import { SwapId } from '@arkade-os/solver-next/domain/shared/ids.js'
import { UnixSeconds } from '@arkade-os/solver-next/domain/shared/time.js'
import { lnReceivePolicies } from '@arkade-os/solver-next/domain/swap/ln_receive.js'
import { ArkadeLockup } from '@arkade-os/solver-next/infrastructure/arkade/lockup.js'
import { ReceiveSwapTable } from '@arkade-os/solver-next/infrastructure/db/receive_swap_table.js'
import { HeldPayment } from '@arkade-os/solver-next/infrastructure/lightning/held_payment.js'
import { FakeLightningBackend } from '@arkade-os/solver-rails-fake/ln/fake/backend.js'
import { legacyArkadeLockups } from '../bridge/legacyArkadeLockups.js'

// The whole Lightning receive corridor, run twice on identical worlds: once by the legacy service, once by the
// new parts put together. After every tick the two databases must hold the same rows.

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])
const HRP = 'tark'
const PREIMAGE = new Uint8Array(32).fill(42)
const HASH = hex.encode(sha256(PREIMAGE))
const HOUR = 3_600
const PAYOUT_ADDRESS = new CovenantSwapScript({
  receiver: key(6),
  server: key(2),
  preimageHash: new Uint8Array(20).fill(9),
  refundLocktime: 1_800_000_000,
  claimDelay: 512,
  client: key(11),
  clientRefundDelay: 1024,
  refundWithoutServerDelay: 2048,
  nonInteractiveParameters: { emulatorPubkey: key(3), receiverPkScript: p2tr(key(13)), senderPkScript: p2tr(key(6)) },
})
  .address(HRP, key(2))
  .encode()

let now: number
const clock = (): number => now

/** Arkade as both engines see it: what the indexer shows and what the wallet does. */
class FakeArkade {
  outputs: FundedOutput[] = []
  spent: FundedOutput[] = []
  claimed: Uint8Array | null = null
  payouts = 0
  refunds = 0

  /** The client claims our lockup and reveals the preimage. */
  clientClaims(): void {
    this.spent.push(...this.outputs)
    this.outputs = []
    this.claimed = PREIMAGE
  }

  readonly ops: ReceiveArkadeOps = {
    solverPubkey: hex.encode(key(1)),
    serverPubkey: hex.encode(key(2)),
    emulatorPubkey: hex.encode(key(3)),
    solverRefundPkScript: hex.encode(p2tr(key(4))),
    delays: { unilateralClaimDelay: 512, unilateralRefundDelay: 1024, unilateralRefundWithoutReceiverDelay: 1536 },
    hrp: HRP,
    findLockups: async () => this.outputs,
    findLockupOutpoints: async () => [
      ...this.outputs.map((o) => ({ ...o, spent: false, unrolled: false })),
      ...this.spent.map((o) => ({ ...o, spent: true, unrolled: false })),
    ],
    fund: async (_address, amountSats) => {
      this.payouts += 1
      this.outputs = [{ txid: `fund-${this.payouts}`, vout: 0, value: amountSats }]
      return `fund-${this.payouts}`
    },
    refund: async () => {
      this.refunds += 1
      this.spent.push(...this.outputs)
      this.outputs = []
      return 'refund-ark-txid'
    },
    findClaimPreimage: async () => this.claimed,
  }
}

interface World {
  readonly db: Database.Database
  readonly store: ReceiveSwapStore
  readonly node: FakeLightningBackend
  readonly arkade: FakeArkade
  /** One pass over the swap, by whichever engine drives this world. */
  tick(): Promise<unknown>
}

let dir: string
let id: SwapId
let legacy: World
let next: World

const open = async (name: string): Promise<Omit<World, 'tick'> & { driver: ReturnType<typeof betterSqliteDriver> }> => {
  const path = join(dir, `${name}.sqlite`)
  const driver = betterSqliteDriver(path)
  return {
    driver,
    db: new Database(path),
    store: await ReceiveSwapStore.open(driver, clock),
    node: new FakeLightningBackend(join(dir, `${name}-ln.json`), 'bcrt', clock),
    arkade: new FakeArkade(),
  }
}

const rows = ({ db }: World) => ({
  // `updated_at` is left out: the new table moves it by at least a second on every write, to serve as a version.
  swaps: (db.prepare('SELECT * FROM receive_swap ORDER BY id').all() as Record<string, unknown>[]).map(
    ({ updated_at: _, ...row }) => row,
  ),
  history: db.prepare('SELECT swap_id, at, from_state, to_state, detail FROM receive_swap_event ORDER BY id').all(),
})

/** The same thing happens in both worlds, both engines get a tick, and the databases are compared. */
const then = async (happens: (world: World) => void = () => undefined, seconds = 1): Promise<void> => {
  now += seconds
  for (const world of [legacy, next]) happens(world)
  await legacy.tick()
  await next.tick()
  expect(rows(next)).toEqual(rows(legacy))
  expect([next.arkade.payouts, next.arkade.refunds]).toEqual([legacy.arkade.payouts, legacy.arkade.refunds])
}

const state = (world: World): unknown => rows(world).swaps[0]?.state
const payerHolds = (world: World): void => world.node.armHold(HASH, now + 4 * HOUR)

beforeEach(async () => {
  now = 1_800_000_000
  dir = mkdtempSync(join(tmpdir(), 'ln-receive-corridor-'))

  const old = await open('legacy')
  const service = new ReceiveSwapService({
    acceptUnilateralGap: false,
    store: old.store,
    ln: old.node,
    arkade: old.arkade.ops,
    limits: { minSats: 1_000, maxSats: 1_000_000 },
    maxExposedSats: 1_000_000,
    totalCommitted: () => old.store.committedSats(),
    admission: new AdmissionControl(),
    now: clock,
  })
  const quote = await service.quote({
    paymentHash: HASH,
    amountSats: 5_000,
    payoutAddress: PAYOUT_ADDRESS,
    payoutPubkey: hex.encode(key(5)),
    claimPacket: null,
  })
  if (!quote.accepted) throw new Error(`quote refused: ${quote.reason}`)
  id = SwapId.of(quote.swap.id)
  legacy = { ...old, tick: () => service.tick(id) }

  // The new engine has no quoting yet, so its world gets the same quote row and the same invoice.
  const fresh = await open('next')
  await fresh.store.insertQuote({
    ...quote.swap,
    nonInteractiveParameters: quote.swap.nonInteractiveParameters ?? true,
    rfqId: quote.swap.rfqId ?? undefined,
  })
  await fresh.node.createHoldInvoice({
    amountSats: quote.swap.amountSats,
    paymentHash: HASH,
    expirySeconds: quote.swap.invoiceExpiresAt - now,
    minFinalCltvBlocks: 40,
  })
  const table = new ReceiveSwapTable(fresh.driver, clock)
  const engine = new DriveSwap({
    swaps: table,
    policies: lnReceivePolicies({ acceptRefundAloneGap: false }),
    rails: {
      from: new HeldPayment(fresh.node),
      to: new ArkadeLockup(table, legacyArkadeLockups({ arkade: fresh.arkade.ops, now: clock })),
    },
    context: async () => ({ peer: null, keyCurrent: true, approval: 'not_required', ownInvoice: false }),
    now: () => UnixSeconds.of(now),
  })
  next = { ...fresh, tick: () => engine.drive(id) }
  expect(rows(next)).toEqual(rows(legacy))
})

afterEach(async () => {
  for (const world of [legacy, next]) {
    world.db.close()
    await world.store.close()
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('Lightning receive, both engines side by side', () => {
  it('waits, pays out when the payment is held, and settles once the client claims', async () => {
    await then()
    expect(state(next)).toBe('quoted')
    await then(payerHolds)
    expect(state(next)).toBe('funded')
    await then()
    await then((world) => world.arkade.clientClaims())
    expect(state(next)).toBe('settled')
    expect(next.arkade.payouts).toBe(1)
    expect((await next.node.getHoldState(HASH)).status).toBe('settled')
    await then()
  })

  it('refunds the payout when the client never claims', async () => {
    await then(payerHolds)
    await then(undefined, 2 * HOUR)
    expect(state(next)).toBe('refunded')
    expect(next.arkade.refunds).toBe(1)
    await then()
  })

  it('still settles when the claim shows up after the refund deadline but before the refund', async () => {
    await then(payerHolds)
    await then((world) => world.arkade.clientClaims(), 2 * HOUR)
    expect(state(next)).toBe('settled')
    expect(next.arkade.refunds).toBe(0)
  })

  it('refuses to pay out when the held payment times out too soon', async () => {
    await then((world) => world.node.armHold(HASH, now + HOUR))
    expect(state(next)).toBe('refused')
    expect(next.arkade.payouts).toBe(0)
    await then()
  })

  it('refuses a quote nobody paid and retires its invoice; only the wording of the reason differs', async () => {
    now += 3 * HOUR
    await legacy.tick()
    await next.tick()
    const [old, mine] = [rows(legacy).swaps[0]!, rows(next).swaps[0]!]
    expect({ ...mine, failure_reason: null }).toEqual({ ...old, failure_reason: null })
    expect(rows(next).history).toEqual(rows(legacy).history)
    expect([old.failure_reason, mine.failure_reason]).toEqual([
      'invoice expired before it was ever armed',
      'quote expired before the client funded',
    ])
    for (const world of [legacy, next]) expect((await world.node.getHoldState(HASH)).status).toBe('cancelled')
  })
})
