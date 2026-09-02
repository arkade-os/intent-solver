/**
 * The EVM port: what a corridor needs from an EVM chain, as pure types.
 *
 * Lives in core rather than beside a backend for the same reason the Lightning
 * and onchain ports do after the workspace split: a VENDOR package implements
 * this interface and must be able to do so without dragging another vendor's
 * code in. `rail -> core` is the only edge the DAG gives a rail, so the
 * contract types it speaks in live here.
 *
 * Moved out of `rails/evm/backend.ts` — which still re-exports all of it, so
 * existing importers keep working; vendor packages import from here directly.
 */

/** One chain call: a destination and calldata, plus optional native value. */
export interface EvmCall {
  /** The `ERC20Swap` deployment, 20 bytes. */
  to: Uint8Array
  data: Uint8Array
  /**
   * Native currency to attach, in wei. Absent means none.
   *
   * Only `lockPrepayMinerfee` uses it, and it is not decoration: that value IS
   * the claimant's gas money, forwarded to them by the contract in the same
   * transaction. Attaching zero would lock the tokens and fund nobody, leaving
   * a client who holds no native asset unable to claim — the failure the
   * function exists to prevent.
   */
  value?: bigint
}

/**
 * One JSON-RPC round trip.
 *
 * Narrow on purpose: the adapter uses four methods and this is the whole of
 * its dependency on a node. A test supplies a function; production supplies
 * something that speaks HTTP.
 */
export type JsonRpc = (method: string, params: readonly unknown[]) => Promise<unknown>

/**
 * The lock as the `ERC20Swap` contract keys it.
 *
 * The contract stores `swaps[keccak(preimageHash, amount, token, claim, refund,
 * timelock)]` — those six ARE the lock's name, so every field is part of its
 * identity and a restart that cannot reproduce all six byte-for-byte can
 * neither claim the lock nor refund it.
 */
export interface Erc20SwapLock {
  /** `sha256(preimage)`, 32 bytes. */
  preimageHash: Uint8Array
  /** Token base units. */
  amount: bigint
  /** The ERC-20 contract, 20 bytes. */
  tokenAddress: Uint8Array
  /** Who may claim with the preimage, 20 bytes. */
  claimAddress: Uint8Array
  /** Who may refund after the timelock, 20 bytes. */
  refundAddress: Uint8Array
  /** Block HEIGHT, not a timestamp - see `rails/evm/blockTime.ts`. */
  timelock: bigint
}

/**
 * What an EVM swap corridor needs from a chain: reads about locks, and the
 * calldata for every money move — the SIGNING stays with whoever holds the
 * solver's key (see the broadcaster seam), so this interface never carries a
 * private key.
 */
export interface EvmHtlcBackend {
  /** The chain tip. Every timelock question is relative to this. */
  currentBlock(): Promise<bigint>
  /**
   * Whether this exact lock is funded and unspent, per the contract's own
   * `swaps` mapping. False also means "claimed or refunded" — the flag is
   * deleted on both, and the contract keeps no history.
   */
  isLocked(lock: Erc20SwapLock): Promise<boolean>
  /**
   * The preimage, if this lock has been claimed since `fromBlock`.
   *
   * The cross-leg mechanism on a send corridor: the client claims the tokens
   * and this is how the solver learns the secret it needs for its own side.
   */
  findClaimPreimage(lock: Erc20SwapLock, fromBlock: bigint): Promise<Uint8Array | null>
  /**
   * The same question as {@link EvmHtlcBackend.isLocked}, asked at a HISTORICAL
   * block.
   *
   * THE HONEST SOURCE OF DEPTH. `isLocked` reads `latest`, so it goes true the
   * instant one block carries the lock — it answers whether the lock EXISTS,
   * never how buried it is. An acceptance policy fed from it is satisfied at
   * depth one however many confirmations the operator configured, which is the
   * whole of the reorg protection gone while the setting still reads as
   * enforced.
   *
   * Asked this way rather than by looking up the lock's transaction, because on
   * the receive leg the solver never sees one: it learns the client's lock
   * exists by reading the contract, and a contract read carries no transaction
   * hash. "Was it already there N blocks ago" is the same question as "is it N
   * deep", and needs nothing the solver has to be told.
   *
   * A node pruning that height answers as it would for any archival read; the
   * caller treats a failure as "not proven deep yet" rather than as absence.
   */
  isLockedAt(lock: Erc20SwapLock, block: bigint): Promise<boolean>
  /** A block's own timestamp, for the age half of the same policy. */
  blockTimestampAt(block: bigint): Promise<number>
  /**
   * What this contract may currently move of `token` on `owner`'s behalf.
   *
   * Read rather than assumed, because the safe approval sequence depends on it:
   * see {@link EvmHtlcBackend.approveCall}.
   */
  allowance(token: Uint8Array, owner: Uint8Array): Promise<bigint>
  /**
   * Calldata to fund this lock — the allowance above must already stand.
   *
   * Prefer {@link EvmHtlcBackend.lockCalls}, which establishes it. Alone this
   * reverts against a token the solver has not approved, and a revert is not
   * distinguishable downstream from a lock that has not landed yet.
   */
  lockCall(lock: Erc20SwapLock): EvmCall
  /**
   * Every call the lock needs, in order — approval included. The LAST is always
   * the lock itself.
   *
   * Returning a LIST rather than doing the broadcasting keeps this module free
   * of the nonce source and the signer, and keeps the decision about how many
   * transactions a lock costs in one readable place.
   */
  lockCalls(lock: Erc20SwapLock, currentAllowance: bigint): readonly EvmCall[]
  /**
   * The same lock, forwarding `prepayWei` of native currency to the claimant so
   * a client holding no gas can still claim.
   *
   * The contract sets `refundAddress` to `msg.sender`, so `lock.refundAddress`
   * MUST be the address that will sign this — otherwise the swap key the
   * contract stores is not the one we derive, and we lose track of our own
   * lock. Refused here rather than discovered on chain.
   *
   * ONLY VALID WHEN THE CLAIMANT IS THE SUBMITTER, and that is not checkable
   * here. The contract forwards the value to `claimAddress`:
   *
   * ```solidity
   * TransferHelper.transferEther(claimAddress, msg.value);
   * ```
   *
   * That is right when `claimAddress` is the party who will send the claim
   * transaction — a self-custody client claiming its own tokens. It is WRONG
   * whenever the claimant and the submitter differ, and the clearest case is
   * paying a third party: Arkade BTC to a merchant's USDC. There
   * `claimAddress` is the merchant, who publishes an address and runs nothing,
   * while the claim is submitted by the payer or by a daemon holding the
   * preimage. The prepay then funds an address that will never spend it, and
   * the party who actually needs gas still has none — a silent subsidy to the
   * wrong account, with the swap failing for the original reason.
   *
   * Nothing at this layer knows who will submit, so the check belongs to
   * whatever builds the lock. Use {@link claimForCall} for the third-party
   * case, and fund that submitter separately.
   *
   * It also moves the tokens with `transferFrom` exactly as `lock` does, so
   * whoever wires it needs the allowance too. There is no `lockPrepayCalls`
   * sibling because there is no caller to shape one around — see
   * {@link EvmHtlcBackend.lockCalls}.
   */
  lockPrepayCall(lock: Erc20SwapLock, prepayWei: bigint, senderAddress: Uint8Array): EvmCall
  /** Calldata to claim it with a revealed preimage. Caller must be `claimAddress`. */
  claimCall(preimage: Uint8Array, lock: Erc20SwapLock): EvmCall
  /** Calldata to refund it after the timelock. Caller must be `refundAddress`. */
  refundCall(lock: Erc20SwapLock): EvmCall
  /**
   * The same claim, submittable BY ANYONE, with the tokens still going to
   * `lock.claimAddress`.
   *
   * This is the non-interactive path — what covclaimd provides on Arkade. The
   * contract's `claim` overload taking an explicit `claimAddress` is `public`
   * and does not read `msg.sender`, so a preimage that is already public is
   * enough for a third party to settle the swap. Use it when the party who
   * SHOULD claim has not: offline, out of gas, or simply gone.
   *
   * The sender pays gas and receives nothing, so this is a deliberate act by
   * someone with a reason — typically the solver, whose counter-leg is parked
   * until the claim lands.
   */
  claimForCall(preimage: Uint8Array, lock: Erc20SwapLock): EvmCall
  /**
   * The same refund, submittable by anyone once the timelock has matured, with
   * the tokens still returning to `lock.refundAddress`.
   */
  refundForCall(lock: Erc20SwapLock): EvmCall
  /**
   * How much the swap contract may currently move of `owner`'s tokens.
   *
   * Read against the TOKEN named by `lock.tokenAddress`, not the swap contract,
   * and needed before approving rather than only as an optimisation — some
   * tokens revert an approve that moves a non-zero allowance to another
   * non-zero value. See {@link approvalStepFor}.
   */
  allowanceOf(lock: Erc20SwapLock, owner: Uint8Array): Promise<bigint>
  /**
   * Calldata to let the swap contract move `amount` of the caller's tokens.
   *
   * ADDRESSED TO THE TOKEN, not to `contractAddress` like every other call
   * here — `lock.tokenAddress` is the `to`. Sending this to the swap
   * contract would revert with nothing that names the cause.
   *
   * `lock` does `transferFrom`, so without this the first real lock fails on
   * a step this port documented and never took.
   */
  approveCall(lock: Erc20SwapLock, amount: bigint): EvmCall
}

export interface EvmHtlcBackendDeps {
  /** The `ERC20Swap` deployment, 20 bytes. Configuration, never a constant. */
  contractAddress: Uint8Array
  rpc: JsonRpc
}
