import {
  absoluteLocktimeIn,
  absoluteLocktimeReached,
  absoluteLocktimeSeconds,
  absoluteLocktimeUnit,
  relativeDelayFrom,
} from '@arkade-os/solver-core/core/timelocks.js'
import type { ChainTipProvider } from '@arkade-os/solver-rails/onchain/chainTip.js'

/**
 * A unix-seconds deadline as the locktime this deployment writes. The unit comes from
 * the unilateral LADDER, so the covenant's relative and absolute timelocks cannot
 * disagree about which clock the swap runs on.
 */
export const absoluteLocktimeFor = async (
  deadlineSeconds: number,
  ladderDelay: number,
  now: () => number,
  chainTip: ChainTipProvider | undefined,
): Promise<number> => {
  if (relativeDelayFrom(ladderDelay).unit === 'seconds') return deadlineSeconds
  if (!chainTip) {
    throw new Error(
      'this deployment has block-typed timelocks, so a refund deadline must be written as a height — ' +
        'but no chainTip provider is wired',
    )
  }
  return absoluteLocktimeIn(deadlineSeconds, 'blocks', { now: now(), tipHeight: await chainTip.height() })
}

/**
 * A stored refund locktime as unix seconds, for DURATION questions only — a height is
 * projected from the tip, so it is an estimate. Whether the deadline has OPENED is
 * {@link refundDeadlineReached}. `purpose` completes the missing-provider error.
 */
export const refundDeadlineSeconds = async (
  refundLocktime: number,
  now: () => number,
  chainTip: ChainTipProvider | undefined,
  purpose: string,
): Promise<number> => {
  const at = now()
  if (absoluteLocktimeUnit(refundLocktime) === 'seconds') return refundLocktime
  if (!chainTip) {
    throw new Error(
      `refund locktime ${refundLocktime} is a block height, but no chainTip provider is wired — ` +
        `a block-typed deployment needs one to ${purpose}`,
    )
  }
  return absoluteLocktimeSeconds(refundLocktime, { now: at, tipHeight: await chainTip.height() })
}

/** Has the refund deadline opened, asked in the locktime's OWN unit. */
export const refundDeadlineReached = async (
  refundLocktime: number,
  now: () => number,
  chainTip: ChainTipProvider | undefined,
): Promise<boolean> => {
  const at = now()
  if (absoluteLocktimeUnit(refundLocktime) === 'seconds') return at >= refundLocktime
  if (!chainTip) {
    // A wiring error, and guessing either answer moves money the wrong way: "not
    // reached" strands a refund forever, "reached" pushes one the chain will reject.
    throw new Error(
      `refund locktime ${refundLocktime} is a block height, but no chainTip provider is wired — ` +
        'a block-typed deployment needs one to tell whether a deadline has opened',
    )
  }
  return absoluteLocktimeReached(refundLocktime, { now: at, tipHeight: await chainTip.height() })
}
