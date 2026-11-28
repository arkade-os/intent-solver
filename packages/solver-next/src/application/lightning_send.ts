import type { ValueOf } from '../domain/shared/brand.js'
import type { UnixSeconds } from '../domain/shared/time.js'
import {
  LONGEST_WAIT_FOR_THE_LOCKUP,
  clientMayRefundAloneEarly,
  whatStopsThePayment,
  whatToDoWithTheLockup,
  type HtlcBlocks,
} from '../domain/swap/lightning_send.js'
import type { Swap } from '../domain/swap/swap.js'
import type { ClientLockupOutput } from '../ports/arkade.js'
import type { FromArkade } from './legs/from_arkade.js'

export const SEND_KEY_ROTATED = 'provider key rotated since quote; refusing to pay an unclaimable lockup'
export const SEND_REFUND_ALONE_TOO_EARLY = 'refused to proceed: client solo refund opens before the quoted refund'

export const Do = {
  Wait: 'wait',
  Adopt: 'adopt',
  StartPaying: 'start_paying',
  /** Ends the swap: refused while nothing of ours is out, stuck otherwise. */
  Fail: 'fail',
} as const

export type Do = ValueOf<typeof Do>

export interface SendStep {
  readonly do: Do
  readonly reason?: string
  /** With `adopt`: the outputs taken on. */
  readonly outputs?: readonly ClientLockupOutput[]
  /** With `fail`: what the client has at the lockup to take back. */
  readonly heldSats?: number
}

/** What a send was quoted on. None of it changes afterwards, except what was locked. */
export interface SendTerms {
  readonly quotedAt: UnixSeconds
  readonly invoiceExpiresAt: UnixSeconds
  readonly amountSats: number
  /** Null until the lockup is adopted. */
  readonly lockedSats: number | null
  /** The refund deadline the quote was priced on, in seconds. Null on swaps quoted before it was kept. */
  readonly quotedRefundOpensAt: UnixSeconds | null
  readonly blocks: HtlcBlocks
  /** Whether the key that claims the lockup is still the one we hold. */
  readonly keyStillOurs: boolean
}

export interface SendSettings {
  readonly longestWaitForTheLockup?: number
  readonly maxLockupOutputs: number
}

const WAIT: SendStep = { do: Do.Wait }
const fail = (reason: string): SendStep => ({ do: Do.Fail, reason })

export class LightningSend {
  constructor(
    private readonly lockup: FromArkade,
    private readonly terms: { of(swap: Swap): Promise<SendTerms> },
    private readonly approves: (swap: Swap) => Promise<boolean>,
    private readonly now: () => UnixSeconds,
    private readonly settings: SendSettings,
  ) {}

  /** Reads, decides, changes nothing. Once the payment is started the next step is not decided here yet. */
  next(swap: Swap): Promise<SendStep> {
    switch (swap.state) {
      case 'quoted':
        return this.whenQuoted(swap)
      case 'funded':
        return this.whenFunded(swap)
      default:
        return Promise.resolve(WAIT)
    }
  }

  private async whenQuoted(swap: Swap): Promise<SendStep> {
    const lockup = await this.lockup.state(swap)
    const { amountSats, quotedAt, invoiceExpiresAt } = await this.terms.of(swap)
    const step = whatToDoWithTheLockup(
      lockup,
      {
        amountSats,
        maxOutputs: this.settings.maxLockupOutputs,
        quotedAt,
        invoiceExpiresAt,
        longestWait: this.settings.longestWaitForTheLockup ?? LONGEST_WAIT_FOR_THE_LOCKUP,
      },
      this.now(),
    )
    switch (step.do) {
      case 'adopt':
        return { do: Do.Adopt, outputs: lockup.spendable }
      case 'refuse':
        return step.heldSats === null ? fail(step.reason) : { ...fail(step.reason), heldSats: step.heldSats }
      default:
        return WAIT
    }
  }

  private async whenFunded(swap: Swap): Promise<SendStep> {
    const terms = await this.terms.of(swap)
    if (!terms.keyStillOurs) return fail(SEND_KEY_ROTATED)
    const refundOpensAt = await this.lockup.refundOpensAt(swap)
    const secondsToRefundAlone = await this.lockup.secondsToRefundAlone(swap)
    const quotedRefund = terms.quotedRefundOpensAt ?? refundOpensAt
    if (clientMayRefundAloneEarly(secondsToRefundAlone, quotedRefund, terms.quotedAt)) {
      return fail(SEND_REFUND_ALONE_TOO_EARLY)
    }
    const stops = whatStopsThePayment(
      {
        invoiceExpiresAt: terms.invoiceExpiresAt,
        refundOpensAt: await this.lockup.payDeadline(swap, refundOpensAt),
        lockedSats: terms.lockedSats ?? 0,
        expectedSats: terms.amountSats,
        blocks: terms.blocks,
      },
      this.now(),
    )
    if (stops !== null) return fail(`refused to pay: ${stops}`)
    return (await this.approves(swap)) ? { do: Do.StartPaying } : WAIT
  }
}
