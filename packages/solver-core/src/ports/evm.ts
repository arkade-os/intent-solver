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

/** One chain call: a destination and calldata. Every call is ERC-20, so none carries native value. */
export interface EvmCall {
  /** The `ERC20Swap` deployment, 20 bytes. */
  to: Uint8Array
  data: Uint8Array
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
 * What became of a transaction the solver broadcast. `pending` is "no answer
 * yet" — including a node that never saw the hash — never evidence of failure.
 */
export type EvmTransactionOutcome = 'pending' | 'success' | 'reverted'

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

export interface EvmClaimFinalityPolicy {
  minConfirmations: number
  minAgeSeconds: number
  nowSeconds: number
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
   *
   * `fromBlock` MUST NOT be later than the lock's own block.
   */
  findClaimPreimage(lock: Erc20SwapLock, fromBlock: bigint, policy?: EvmClaimFinalityPolicy): Promise<Uint8Array | null>
  /** A refund of THIS lock proven mined since `fromBlock`, whoever sent it -
   * the row's txid need not be the winner. False is "not proven", not "no". */
  findRefund(lock: Erc20SwapLock, fromBlock: bigint): Promise<boolean>
  /**
   * The height a transaction was mined at - the floor `findClaimPreimage` is
   * asked from, where null is "no floor is proven".
   */
  transactionBlock(txid: string): Promise<bigint | null>
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
   * The only read that distinguishes a REVERTED money call from one that has
   * not landed: every other read asks the contract about a lock, and a revert
   * leaves none — the same answer as pending, and as never sent.
   */
  transactionOutcome(txid: string): Promise<EvmTransactionOutcome>
  /**
   * What this contract may currently move of `token` on `owner`'s behalf.
   *
   * Read rather than assumed, because the safe approval sequence depends on it:
   * see {@link EvmHtlcBackend.lockCalls}.
   */
  allowance(token: Uint8Array, owner: Uint8Array): Promise<bigint>
  /**
   * Every call the lock needs, in order — approval included. The LAST is always
   * the lock itself.
   *
   * Returning a LIST rather than doing the broadcasting keeps this module free
   * of the nonce source and the signer, and keeps the decision about how many
   * transactions a lock costs in one readable place.
   */
  lockCalls(lock: Erc20SwapLock, currentAllowance: bigint): readonly EvmCall[]
  /** Calldata to claim it with a revealed preimage. Caller must be `claimAddress`. */
  claimCall(preimage: Uint8Array, lock: Erc20SwapLock): EvmCall
  /** Calldata to refund it after the timelock. Caller must be `refundAddress`. */
  refundCall(lock: Erc20SwapLock): EvmCall
  /**
   * The same refund, submittable by anyone once the timelock has matured, with
   * the tokens still returning to `lock.refundAddress`.
   */
  refundForCall(lock: Erc20SwapLock): EvmCall
}

export interface EvmHtlcBackendDeps {
  /** The `ERC20Swap` deployment, 20 bytes. Configuration, never a constant. */
  contractAddress: Uint8Array
  rpc: JsonRpc
  /** Blocks per `eth_getLogs` request; over a provider's cap it is REJECTED. */
  logScanRange?: number
}
