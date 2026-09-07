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
    `${gaveUp}. boarding.confirmed ${boarding} sits beside settled ${settled}, which is one deposit counted ` +
    'twice: a previous settle already spent that boarding input and its commitment transaction has not ' +
    'confirmed yet, so the input cannot be settled again. Mine a block and re-run. Nothing was lost — the ' +
    'sats are the ones already in `settled`.'
  )
}

export const DEFAULT_SETTLE_TIMEOUT_MS = 120_000

export const settleTimeoutMs = (raw) => {
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_SETTLE_TIMEOUT_MS
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
