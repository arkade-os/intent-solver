import { Reference, type Side } from '@arkade-os/solver-core/domain/swap/leg.js'
import type { LegStatus } from '@arkade-os/solver-core/domain/swap/observation.js'
import type { Swap } from '@arkade-os/solver-core/domain/swap/swap.js'
import type { ReceiveBackend } from '@arkade-os/solver-core/ports/lightning.js'
import { SendStatus, type RailService, type SendResult } from '@arkade-os/solver-core/ports/rail.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ReceiveSwapStore } from '../db/receiveSwaps.js'
import { claimPacketStamp } from '../receive/claimPacket.js'
import { FundNotSubmittedError } from '../receive/fundLockup.js'
import { receiveCovenantRowFor } from '../receive/orchestrator.js'
import { covenantScriptFromRow } from '../send/arkadeOps.js'
import { holdStatus, lockupStatus, type LockupStatusDeps } from './lnReceiveStatus.js'

type Contracts = Pick<ReceiveSwapStore, 'get'>

const sent = (reference: string): SendResult => ({ status: SendStatus.Sent, reference: Reference.of(reference) })
const NOT_SENT: SendResult = { status: SendStatus.NotSent }
const UNKNOWN: SendResult = { status: SendStatus.Unknown }

/** The `from` leg of Lightning receive: the payment the client holds for us on our node. */
export class HeldPayment implements RailService {
  constructor(
    private readonly contracts: Contracts,
    private readonly ln: Pick<ReceiveBackend, 'getHoldState' | 'settleHold' | 'cancelHold'>,
  ) {}

  async status(swap: Swap): Promise<LegStatus> {
    return holdStatus(this.ln, await this.contracts.get(swap.id), swap)
  }

  async lock(swap: Swap, side: Side): Promise<SendResult> {
    throw new Error(`swap ${swap.id}: the ${side} leg is the client's payment; we never lock it`)
  }

  async claim(swap: Swap): Promise<SendResult> {
    const { preimage, hashlock } = swap
    if (preimage === null || hashlock === null) throw new Error(`swap ${swap.id}: no preimage to settle with`)
    try {
      await this.ln.settleHold(preimage)
      return sent(hashlock)
    } catch {
      // The node may have settled before it failed to answer. Its status says which.
      return UNKNOWN
    }
  }

  /** Lets the payer go. Only reached when nothing of ours is out. */
  async refund(swap: Swap): Promise<SendResult> {
    const { hashlock } = swap
    if (hashlock === null || !this.ln.cancelHold) return NOT_SENT
    try {
      await this.ln.cancelHold(hashlock)
      return sent(hashlock)
    } catch {
      return NOT_SENT
    }
  }
}

export interface ArkadeLockupDeps extends LockupStatusDeps {
  readonly arkade: LockupStatusDeps['arkade'] & Pick<ReceiveArkadeOps, 'fund' | 'refund'>
}

/** The `to` leg of Lightning receive: our payout, locked on Arkade for the client to claim. */
export class ArkadeLockup implements RailService {
  constructor(
    private readonly contracts: Contracts,
    private readonly deps: ArkadeLockupDeps,
  ) {}

  async status(swap: Swap): Promise<LegStatus> {
    return lockupStatus(this.deps, await this.contracts.get(swap.id), swap)
  }

  async lock(swap: Swap): Promise<SendResult> {
    const row = await this.contracts.get(swap.id)
    const stamp = claimPacketStamp(row.claimPacket, covenantScriptFromRow(receiveCovenantRowFor(row)))
    try {
      return sent(await this.deps.arkade.fund(row.lockupAddress, row.payoutSats, stamp))
    } catch (error) {
      // Only this error proves nothing left our wallet. Anything else may have paid out.
      return error instanceof FundNotSubmittedError ? NOT_SENT : UNKNOWN
    }
  }

  async claim(swap: Swap, side: Side): Promise<SendResult> {
    throw new Error(`swap ${swap.id}: the ${side} leg is claimed by the client, never by us`)
  }

  async refund(swap: Swap): Promise<SendResult> {
    const row = await this.contracts.get(swap.id)
    const outputs = await this.deps.arkade.findLockups(row.pkScript)
    if (outputs.length === 0) return NOT_SENT
    try {
      return sent(await this.deps.arkade.refund(receiveCovenantRowFor(row), outputs))
    } catch {
      return UNKNOWN
    }
  }
}
