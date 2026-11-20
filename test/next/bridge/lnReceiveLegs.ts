import { Reference, type Side } from '@arkade-os/solver-next/domain/swap/leg.js'
import type { LegStatus } from '@arkade-os/solver-next/domain/swap/observation.js'
import type { Swap } from '@arkade-os/solver-next/domain/swap/swap.js'
import { SendStatus, type RailService, type SendResult } from '@arkade-os/solver-next/ports/rail.js'
import type { ReceiveArkadeOps } from '@arkade-os/solver-arkade/arkade/arkadeOps.js'
import type { ReceiveSwapStore } from '@arkade-os/solver-corridors/db/receiveSwaps.js'
import { claimPacketStamp } from '@arkade-os/solver-corridors/receive/claimPacket.js'
import { FundNotSubmittedError } from '@arkade-os/solver-corridors/receive/fundLockup.js'
import { receiveCovenantRowFor } from '@arkade-os/solver-corridors/receive/orchestrator.js'
import { covenantScriptFromRow } from '@arkade-os/solver-corridors/send/arkadeOps.js'
import { lockupStatus, type LockupStatusDeps } from './lnReceiveStatus.js'

type Contracts = Pick<ReceiveSwapStore, 'get'>

const sent = (reference: string): SendResult => ({ status: SendStatus.Sent, reference: Reference.of(reference) })
const NOT_SENT: SendResult = { status: SendStatus.NotSent }
const UNKNOWN: SendResult = { status: SendStatus.Unknown }

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
