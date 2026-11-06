/**
 * The live-wallet half of the server-independent exit: everything
 * {@link UnilateralExitDeps} needs, built from an {@link ArkadeContext}.
 *
 * Separate from `unilateralExit.ts` so that the decisions — which leaf, which
 * role, whether the ladder holds — stay testable without a wallet, an indexer,
 * an Esplora endpoint or onchain funds. This file is the wiring, and it is
 * deliberately thin: everything it assembles is either read straight off the
 * context or is one SDK constructor call.
 */

import { OnchainWallet, Transaction, UnilateralExit, type ExitPackage, type NetworkName } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { findLockups, type ArkadeContext } from './wallet.js'
import {
  planUnilateralExit,
  prepareUnrolledClaim,
  type ExitContractAccess,
  type UnilateralExitDeps,
} from './unilateralExit.js'
import type { UnrolledSpendDeps } from './unrolledSpend.js'

/**
 * The `NetworkName` the exit package is stamped with, read off the wallet's own
 * network prefix.
 *
 * The SDK's `resolveNetworkName` restated rather than imported — it is not
 * exported — and it carries the SDK's own caveat verbatim: exact for `bitcoin`
 * and `regtest`, while the whole `tb` family collapses to `testnet`, signet and
 * mutinynet included. Getting it wrong is not silent: the executor checks the
 * label before it relays anything.
 */
export const exitNetworkName = (bech32: string): NetworkName => {
  if (bech32 === 'bc') return 'bitcoin'
  if (bech32 === 'bcrt') return 'regtest'
  return 'testnet'
}

/**
 * The contract row the exit resolves its leaf from, seen through the one
 * keyhole {@link ExitContractAccess} defines.
 *
 * `updateContract` merges and saves without re-deriving the script, and
 * `createScript` reads only the keys `deserializeParams` names — so patching
 * `preimage` in cannot move the pkScript this row is keyed by. Both facts are
 * load-bearing and both are the SDK's, not ours.
 */
const contractAccessFor = (ctx: ArkadeContext): ExitContractAccess => ({
  params: async (script) => {
    const manager = await ctx.wallet.getContractManager()
    const [contract] = await manager.getContracts({ script })
    return contract ? contract.params : null
  },
  patchParams: async (script, patch) => {
    const manager = await ctx.wallet.getContractManager()
    const [contract] = await manager.getContracts({ script })
    if (!contract) throw new Error(`contract ${script} vanished between reading and arming it`)
    // Merged onto what is there, never replacing it: the row's other params ARE
    // the script, and a replace would leave a row `createScript` cannot rebuild.
    await manager.updateContract(script, { params: { ...contract.params, ...patch } })
  },
})

/**
 * Assemble the dependencies a server-independent exit needs from a live wallet.
 *
 * The onchain wallet is built from the SAME identity the Arkade wallet signs
 * with, which is not a convenience: `UnilateralExit.prepare` refuses a
 * mismatched pair outright ("onchainWallet must share the wallet identity"),
 * because in `funded` mode the splitter's change has to be recoverable by the
 * wallet key.
 */
export const unilateralExitDepsFor = async (ctx: ArkadeContext): Promise<UnilateralExitDeps> => {
  const networkName = exitNetworkName(ctx.wallet.network.bech32)
  const onchainWallet = await OnchainWallet.create(ctx.identity, networkName, ctx.wallet.onchainProvider)
  return {
    exit: UnilateralExit,
    options: {
      wallet: ctx.wallet,
      onchainWallet,
      // The solver's own L1 address: an exit recovers its OWN capital. `mode` is
      // left to the SDK's `funded` default, the one a watchtower can execute.
      sweepAddress: onchainWallet.address,
      networkName,
    },
    contracts: contractAccessFor(ctx),
    findLockups: (pkScriptHex) => findLockups(ctx, pkScriptHex),
  }
}

export const paysSolverOnchain = (
  raw: Uint8Array,
  outpoint: { txid: string; vout: number },
  solverScript: Uint8Array,
): boolean => {
  const tx = Transaction.fromRaw(raw)
  if (tx.inputsLength !== 1 || tx.outputsLength !== 1) return false
  const input = tx.getInput(0)
  const output = tx.getOutput(0)
  return (
    input.txid !== undefined &&
    hex.encode(input.txid) === outpoint.txid &&
    input.index === outpoint.vout &&
    output.script !== undefined &&
    hex.encode(output.script) === hex.encode(solverScript) &&
    output.amount !== undefined &&
    output.amount > 0n
  )
}

export const unrolledClaimFallbackFor = (
  ctx: ArkadeContext,
  providerPubkey: string,
): NonNullable<UnrolledSpendDeps['solo']> => ({
  prepare: async (lockup) => {
    if (!('preimage' in lockup) || !lockup.claimRow) throw new Error('unrolled claim lacks its swap row')
    const status = await ctx.wallet.onchainProvider.getTxStatus(lockup.txid)
    if (!status?.confirmed) throw new Error('unrolled claim output is not confirmed')
    const plan = planUnilateralExit(lockup.claimRow, {
      solverPubkey: providerPubkey,
      preimage: hex.encode(lockup.preimage),
    })
    return prepareUnrolledClaim(await unilateralExitDepsFor(ctx), plan, {
      txid: lockup.txid,
      vout: lockup.vout,
    })
  },
  progress: async (pkg: ExitPackage) => {
    if (pkg.network !== exitNetworkName(ctx.wallet.network.bech32)) {
      return { kind: 'failed', reason: 'unrolled claim package network differs from the wallet' }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_500)
    try {
      const executor = new UnilateralExit.Executor(pkg, ctx.wallet.onchainProvider, {
        signal: controller.signal,
        pollIntervalMs: 500,
      })
      for await (const event of executor) {
        if (event.status === 'failed') return { kind: 'failed', reason: event.reason ?? 'exit step failed' }
        if (event.kind === 'sweep' && event.status === 'confirmed') return { kind: 'confirmed' }
        if (event.status === 'warning') continue
        return { kind: 'pending' }
      }
      return { kind: 'pending' }
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'pending' }
      throw error
    } finally {
      clearTimeout(timer)
    }
  },
  ownsSpend: async (lockup, txid) => {
    const raw = await ctx.wallet.onchainProvider.getRawTransaction(txid)
    const onchainWallet = await OnchainWallet.create(
      ctx.identity,
      exitNetworkName(ctx.wallet.network.bech32),
      ctx.wallet.onchainProvider,
    )
    return paysSolverOnchain(raw, lockup, onchainWallet.onchainP2TR.script)
  },
})
