/**
 * The states an EVM swap passes through, and which of them expose money.
 *
 * Split from the stores on purpose. The onchain corridors keep their state
 * machine beside their table because one table serves one direction; the EVM
 * corridors are parameterised by token, so BOTH directions and EVERY token
 * share these definitions and only the row differs. Putting them here is what
 * stops two tables drifting into two different ideas of "exposed".
 *
 * The shape mirrors the onchain corridors deliberately — `funding_evm` sits
 * where `funding_onchain` does — because the question each state answers is the
 * same and a reviewer who knows one should not have to relearn the other. What
 * differs is named for what actually differs: an EVM lock is a contract call,
 * not a broadcast, so it can revert rather than merely fail to confirm.
 */

/** `arkade:BTC -> ethereum:<token>`: the client locks sats, the solver locks ERC20. */
export type EvmSendSwapState =
  | 'quoted'
  | 'funded'
  | 'locking_evm'
  | 'awaiting_claim'
  | 'claiming'
  | 'claimed'
  | 'refunding_evm'
  | 'refunded'
  | 'refused'
  | 'stuck'

/** `ethereum:<token> -> arkade:BTC`: the client locks ERC20, the solver locks sats. */
export type EvmReceiveSwapState =
  | 'quoted'
  | 'awaiting_lock'
  | 'locked'
  | 'funding_arkade'
  | 'awaiting_claim'
  | 'claiming'
  | 'claimed'
  | 'refunding_arkade'
  | 'refunded'
  | 'refused'
  | 'stuck'

/**
 * States a swap can still leave, so a row in one counts against the cap.
 *
 * `stuck` is NOT here, and that is the same call the other corridors make: a
 * stuck row is a pager, not a live swap, and counting it against the cap would
 * let one incident starve every corridor until a human cleared it.
 */
export const EVM_SEND_NON_TERMINAL: readonly EvmSendSwapState[] = [
  'quoted',
  'funded',
  'locking_evm',
  'awaiting_claim',
  'claiming',
  'refunding_evm',
]

export const EVM_RECEIVE_NON_TERMINAL: readonly EvmReceiveSwapState[] = [
  'quoted',
  'awaiting_lock',
  'locked',
  'funding_arkade',
  'awaiting_claim',
  'claiming',
  'refunding_arkade',
]

/**
 * States where the SOLVER's money is committed and could still be lost.
 *
 * Narrower than non-terminal, and that difference is semantics, NOT cap
 * accounting: `committedSats()` in both stores sums NON_TERMINAL, because a
 * binding quote is a claim on the float whether or not the solver's own funds
 * have moved. These lists answer the narrower question — "on which states is
 * the solver's money literally at risk" — for everything downstream of that
 * distinction (admission reasoning, operator views, tests).
 *
 * On the send side exposure begins at `locking_evm` — the moment the ERC20 lock
 * is submitted, the solver's tokens are at risk even if the call later reverts,
 * because a revert is not observable until it is mined.
 *
 * On the receive side it begins at `funding_arkade` for the mirror reason. The
 * client's ERC20 lock existing (`locked`) costs the solver nothing; committing
 * sats against it does.
 */
export const EVM_SEND_EXPOSED: readonly EvmSendSwapState[] = [
  'locking_evm',
  'awaiting_claim',
  'claiming',
  'refunding_evm',
]

export const EVM_RECEIVE_EXPOSED: readonly EvmReceiveSwapState[] = [
  'funding_arkade',
  'awaiting_claim',
  'claiming',
  'refunding_arkade',
]
