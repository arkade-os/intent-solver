/**
 * The two ERC-20 calls the corridor needs, on the TOKEN contract.
 *
 * WHY THIS IS A SEPARATE FILE. Everything in `erc20Swap.ts` is addressed to the
 * `ERC20Swap` deployment. These two are not: they go to the token, which is a
 * different contract at a different address, chosen per swap by
 * `lock.tokenAddress`. Keeping them apart means a call site cannot reach for
 * the wrong `to` by having the wrong import in scope — the mistake this would
 * otherwise invite, and one that fails as an opaque revert rather than
 * anything that names the cause.
 *
 * WHY THEY ARE NEEDED AT ALL. `ERC20Swap.lock` moves the tokens with
 * `transferFrom`, so the swap contract must already hold an allowance from
 * whoever funds the lock. `backend.ts` states that ("the token transfer needs a
 * prior allowance") and nothing established one, so the first real lock would
 * revert on a step the code acknowledged and never took.
 *
 * The word encoders come from `erc20Swap.ts` rather than being re-derived here,
 * for the reason that file gives about never assembling a second, subtly
 * different argument set.
 */

import { addressWord, concat, selectorFor, uintWord } from './erc20Swap.js'

/**
 * `approve(address,uint256)` — selector `0x095ea7b3`, the canonical ERC-20 one.
 *
 * Pinned in the tests against 4byte.directory like every other selector here.
 * Worth knowing that this hex has three deliberate collisions registered
 * against it, so "some signature hashes to it" is not the same as "this one
 * does" — the check has to be that `approve(address,uint256)` is among them.
 */
export const APPROVE_SIGNATURE = 'approve(address,uint256)'
const APPROVE_SELECTOR = selectorFor(APPROVE_SIGNATURE)

/**
 * Allow `spender` to move `amount` of the caller's tokens.
 *
 * EXACT AMOUNTS, NOT UNLIMITED, and that is a deliberate cost. One infinite
 * approval per token would save a transaction per swap, and it is what most
 * integrations do. Here the approving party is the SOLVER and the balance being
 * exposed is its float, so an unlimited allowance means any flaw in
 * `ERC20Swap` — or in whatever address configuration points at — can take the
 * whole float rather than one lock's worth.
 *
 * That trade would be arguable against a maintained contract. Boltz is gone, so
 * nothing upstream will patch a flaw found later, and the deployment is ours to
 * run. Bounded exposure is the answer that does not depend on someone else
 * still being there.
 */
export const encodeApprove = (spender: Uint8Array, amount: bigint): Uint8Array =>
  concat([APPROVE_SELECTOR, addressWord(spender, 'spender'), uintWord(amount, 'amount')])

/** `allowance(address,address)` — selector `0xdd62ed3e`. */
export const ALLOWANCE_SIGNATURE = 'allowance(address,address)'
const ALLOWANCE_SELECTOR = selectorFor(ALLOWANCE_SIGNATURE)

/**
 * Read how much `spender` may currently move on `owner`'s behalf.
 *
 * Needed before approving, not merely as an optimisation: some widely-held
 * tokens (USDT is the usual example) REVERT on an `approve` that moves a
 * non-zero allowance to another non-zero value, as a defence against the
 * classic approve race. So the safe sequence is read, and if it is non-zero and
 * wrong, set it to zero before setting it to the amount wanted.
 *
 * USDC does not do this. Depending on that would be depending on which token
 * the operator configures, which is exactly the kind of assumption
 * `EVM_HTLC_ADDRESS` being configurable says not to make.
 */
export const encodeAllowance = (owner: Uint8Array, spender: Uint8Array): Uint8Array =>
  concat([ALLOWANCE_SELECTOR, addressWord(owner, 'owner'), addressWord(spender, 'spender')])

/** What to do before locking, given the allowance already in place. */
export type ApprovalStep =
  /** Enough is already approved. Lock directly. */
  | { kind: 'none' }
  /** Approve `amount`, then lock. */
  | { kind: 'approve'; amount: bigint }
  /**
   * Zero the allowance first, then approve `amount`, then lock.
   *
   * Two transactions before the lock, and unavoidable on a token that refuses a
   * non-zero-to-non-zero change.
   */
  | { kind: 'reset-then-approve'; amount: bigint }

/**
 * Decide the approval sequence for a lock of `amount`, given `current`.
 *
 * Separated from the encoding so the DECISION is testable without a chain: the
 * interesting cases are all about which of three sequences a given allowance
 * implies, and none of them is about calldata.
 *
 * Approving exactly `amount` when the existing allowance is larger is not a
 * saving to skip — it lowers the exposure, and the lock spends the allowance
 * anyway. Only an allowance that is already exactly right needs nothing.
 */
export const approvalStepFor = (current: bigint, amount: bigint): ApprovalStep => {
  if (amount <= 0n) throw new Error(`amount must be positive, got ${amount}`)
  if (current < 0n) throw new Error(`current allowance must not be negative, got ${current}`)
  if (current === amount) return { kind: 'none' }
  if (current === 0n) return { kind: 'approve', amount }
  return { kind: 'reset-then-approve', amount }
}
