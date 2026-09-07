// The decision `regtest-settle.mjs` makes, split out so it is testable without a stack: #37 was a bad input, not I/O.
const asNumber = (v) => (typeof v === 'bigint' ? Number(v) : v)

/** Buckets that are not spendable as they stand. Unchanged by #37 — see below. */
export const unsettledSats = (balance) =>
  asNumber(balance?.preconfirmed ?? 0) + asNumber(balance?.recoverable ?? 0) + asNumber(balance?.boarding?.confirmed ?? 0)

/**
 * DIAGNOSTIC ONLY. `boarding.confirmed` sums explorer-confirmed boarding UTXOs
 * and no field records an unconfirmed spend, so this cannot tell a stale entry
 * from a genuine second deposit — it must never gate the settle (#37).
 */
export const staleBoardingSuspected = (balance) =>
  asNumber(balance?.boarding?.confirmed ?? 0) > 0 &&
  asNumber(balance?.settled ?? 0) + asNumber(balance?.preconfirmed ?? 0) > 0

export const settleTimeoutMessage = (balance, ms) => {
  const gaveUp = `settle() did not return within ${Math.round(ms / 1000)}s`
  if (!staleBoardingSuspected(balance)) return `${gaveUp}.`
  const boarding = asNumber(balance?.boarding?.confirmed ?? 0)
  const settled = asNumber(balance?.settled ?? 0)
  return (
    `${gaveUp}. boarding.confirmed ${boarding} sits beside settled ${settled}, which MAY be one deposit ` +
    'counted twice: if a previous settle already spent that boarding input, its commitment transaction has ' +
    'not confirmed yet and the input cannot be settled again — the sats are the ones already in `settled`. ' +
    'If it is instead a genuine second deposit, it is simply still unboarded. Either way: mine a block and ' +
    're-run.'
  )
}

export const DEFAULT_SETTLE_TIMEOUT_MS = 120_000

/** Past this, `setTimeout` wraps to a 1ms delay, inverting a longer override into no wait at all. */
export const MAX_SETTLE_TIMEOUT_MS = 2_147_483_647

export const settleTimeoutMs = (raw) => {
  const ms = Number(raw)
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_SETTLE_TIMEOUT_MS ? ms : DEFAULT_SETTLE_TIMEOUT_MS
}

/** Run `start()`, rejecting with `message` if it has not resolved after `ms`. */
export const settleWithin = async (start, ms, message) => {
  let timer
  try {
    return await Promise.race([
      start(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
