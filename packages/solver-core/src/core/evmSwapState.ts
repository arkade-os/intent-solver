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

import { defineMachine, type StateOf } from './stateMachine.js'

// `stuck` is terminal, as on every corridor: counting a pager against the cap would let one incident starve it.
// Exposure starts when the solver's own side is committed: the ERC20 lock is submitted (send), or sats
// are committed against the client's lock (receive). A revert is not observable until it is mined.
// `funded`, `awaiting_lock` and `locked` are planner states no transition writes; they keep the planner's edges.

/** `arkade:BTC -> ethereum:<token>`: the client locks sats, the solver locks ERC20. */
export const EvmSendMachine = defineMachine({
  quoted: { live: true, exposed: false, to: ['locking_evm', 'claiming', 'refused', 'stuck'] },
  funded: { live: true, exposed: false, to: ['locking_evm', 'claiming', 'refused', 'stuck'] },
  locking_evm: { live: true, exposed: true, to: ['awaiting_claim', 'claiming', 'refunding_evm', 'stuck'] },
  awaiting_claim: { live: true, exposed: true, to: ['claiming', 'refunding_evm', 'stuck'] },
  claiming: { live: true, exposed: true, to: ['claimed', 'stuck'] },
  claimed: { live: false, exposed: false, to: [] },
  refunding_evm: { live: true, exposed: true, to: ['claiming', 'refunded', 'stuck'] },
  refunded: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: [] },
})

/** `ethereum:<token> -> arkade:BTC`: the client locks ERC20, the solver locks sats. */
export const EvmReceiveMachine = defineMachine({
  quoted: { live: true, exposed: false, to: ['funding_arkade', 'claiming', 'refused', 'stuck'] },
  awaiting_lock: { live: true, exposed: false, to: ['funding_arkade', 'claiming', 'refused', 'stuck'] },
  // `refused` too: the shell re-checks the fund window before its CAS, and the planner funds `locked` unconditionally.
  locked: { live: true, exposed: false, to: ['funding_arkade', 'claiming', 'refused', 'stuck'] },
  funding_arkade: { live: true, exposed: true, to: ['awaiting_claim', 'claiming', 'stuck'] },
  awaiting_claim: { live: true, exposed: true, to: ['claiming', 'refunding_arkade', 'stuck'] },
  claiming: { live: true, exposed: true, to: ['claimed', 'stuck'] },
  claimed: { live: false, exposed: false, to: [] },
  refunding_arkade: { live: true, exposed: true, to: ['claiming', 'refunded', 'stuck'] },
  refunded: { live: false, exposed: false, to: [] },
  refused: { live: false, exposed: false, to: [] },
  stuck: { live: false, exposed: false, to: [] },
})

export type EvmSendSwapState = StateOf<typeof EvmSendMachine>
export type EvmReceiveSwapState = StateOf<typeof EvmReceiveMachine>

/** Live: counted against the cap, since a binding quote claims float whether or not funds moved. */
export const EVM_SEND_NON_TERMINAL = EvmSendMachine.live
export const EVM_RECEIVE_NON_TERMINAL = EvmReceiveMachine.live
/** Where the solver's own money is committed and could still be lost; narrower than live. */
export const EVM_SEND_EXPOSED = EvmSendMachine.exposed
export const EVM_RECEIVE_EXPOSED = EvmReceiveMachine.exposed
