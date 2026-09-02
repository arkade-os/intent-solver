/**
 * Turning an {@link EvmCall} into a broadcast transaction.
 *
 * The piece both orchestrators inject rather than own, and it is injected for
 * one reason: the NONCE SOURCE IS PER ACCOUNT, not per corridor. Two corridors
 * signing with the same solver key must share one high-water mark or they will
 * hand out the same nonce twice and each will look like a replacement of the
 * other. Composing this inside either orchestrator would make that sharing
 * impossible to express.
 *
 * RELEASE ONLY ON A FAILURE THAT CANNOT HAVE REACHED A NODE. A reserved nonce
 * given back after the transaction did reach the mempool turns the next
 * transaction into a replacement of it - which on a claim means replacing the
 * claim. So the release is scoped to the signing step, where nothing has been
 * sent yet, and a failed SEND deliberately keeps the nonce burnt.
 */

import { createNonceSource, type NonceReader, type NonceSource } from './nonce.js'
import { priceTransaction, blocksBefore } from './fees.js'
import { addressFromPrivateKey, signTransaction, type Eip1559Fields } from './transaction.js'
import type { EvmCall } from './backend.js'

export interface EvmBroadcastDeps {
  /** JSON-RPC, already bound to the chain this corridor serves. */
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>
  privateKey: Uint8Array
  chainId: number
  /** Shared across every corridor signing with this key. @see NonceSource */
  nonces: NonceSource
  /** Gas ceiling for one call. */
  gasLimit: bigint
  /** The fee ceiling policy refuses to price above. */
  maxFeeCeilingPerGas: bigint
  /** How long the transaction must stay viable, seconds. */
  headroomSeconds: number
  /** The chain's fastest observed block time, for converting headroom to blocks. */
  fastestSecondsPerBlock: number
  /** Called when the fee ceiling bound the answer - NOT something to swallow. */
  onCappedByPolicy?: (call: EvmCall) => void
}

const quantity = (value: unknown, name: string): bigint => {
  if (typeof value !== 'string') throw new Error(name + ': expected a hex quantity, got ' + JSON.stringify(value))
  return BigInt(value)
}

export const createEvmBroadcaster = (deps: EvmBroadcastDeps) => {
  const from = addressFromPrivateKey(deps.privateKey)

  return async (call: EvmCall): Promise<string> => {
    const [blockRaw, tipRaw] = await Promise.all([
      deps.rpc('eth_getBlockByNumber', ['latest', false]),
      deps.rpc('eth_maxPriorityFeePerGas', []),
    ])
    const block = blockRaw as { baseFeePerGas?: unknown } | null
    if (!block) throw new Error('eth_getBlockByNumber returned no latest block')

    const priced = priceTransaction({
      baseFeePerGas: quantity(block.baseFeePerGas, 'baseFeePerGas'),
      tipPerGas: quantity(tipRaw, 'eth_maxPriorityFeePerGas'),
      blocksOfHeadroom: blocksBefore(deps.headroomSeconds, deps.fastestSecondsPerBlock),
      maxFeeCeilingPerGas: deps.maxFeeCeilingPerGas,
    })
    // Surfaced, never swallowed: a capped fee means the transaction is NOT priced
    // for its full window, which for a claim is a reason to act rather than a
    // line in a log. @see fees.ts
    if (priced.cappedByPolicy) deps.onCappedByPolicy?.(call)

    const nonce = await deps.nonces.next(from)
    let raw: string
    try {
      const tx: Eip1559Fields = {
        chainId: BigInt(deps.chainId),
        nonce,
        maxPriorityFeePerGas: priced.maxPriorityFeePerGas,
        maxFeePerGas: priced.maxFeePerGas,
        gas: deps.gasLimit,
        to: call.to,
        value: call.value ?? 0n,
        data: call.data,
      }
      raw = '0x' + Buffer.from(signTransaction(tx, deps.privateKey).raw).toString('hex')
    } catch (error) {
      // Nothing left this process, so the nonce is safe to give back. Past this
      // point it is not: a released nonce after a send makes the next
      // transaction a replacement of the one already in flight.
      deps.nonces.release(from, nonce)
      throw error
    }

    const hash = await deps.rpc('eth_sendRawTransaction', [raw])
    if (typeof hash !== 'string') {
      throw new Error('eth_sendRawTransaction: expected a hash, got ' + JSON.stringify(hash))
    }
    return hash
  }
}

/** A nonce source bound to one JSON-RPC endpoint, shared per solver key. */
export const nonceSourceFor = (rpc: (method: string, params: readonly unknown[]) => Promise<unknown>): NonceSource => {
  const read: NonceReader = async (address, block) => {
    const hex = Array.from(address, (b) => b.toString(16).padStart(2, '0')).join('')
    return quantity(await rpc('eth_getTransactionCount', ['0x' + hex, block]), 'eth_getTransactionCount')
  }
  return createNonceSource(read)
}
