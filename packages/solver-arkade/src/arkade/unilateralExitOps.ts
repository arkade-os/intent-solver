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

import { OnchainWallet, UnilateralExit, type ExitMode, type NetworkName } from '@arkade-os/sdk'
import { findLockups, type ArkadeContext } from './wallet.js'
import type { ExitContractAccess, UnilateralExitDeps } from './unilateralExit.js'

/**
 * The `NetworkName` the exit package is stamped with, read off the wallet's own
 * network prefix.
 *
 * The SDK's `resolveNetworkName` restated rather than imported — it is not
 * exported — and it carries the SDK's own caveat verbatim: exact for `bitcoin`
 * and `regtest`, while the whole `tb` family collapses to `testnet`. So signet
 * and mutinynet must be named explicitly by the caller. Getting it wrong is not
 * silent: the executor checks the label before it relays anything.
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

export interface UnilateralExitWiring {
  /**
   * Where the exited sats land — a Bitcoin L1 address, not an Arkade one: the
   * sweep is an ordinary onchain transaction.
   *
   * Defaults to the solver's own onchain address, derived from the same identity
   * the wallet signs with. That is the right default and not merely a
   * convenient one: an exit is the solver recovering its OWN capital, and any
   * other destination is a decision an operator has to make explicitly.
   */
  sweepAddress?: string
  /** sat/vB. Unset takes the onchain provider's estimate, floored at the SDK's minimum. */
  feeRate?: number
  /**
   * Fee-funding strategy. `funded` (the SDK's default) broadcasts a splitter at
   * prepare time and pre-signs the fee children, so the package then executes
   * with no keys at all; `graph` transports only the graph and funds the bumps
   * at execution time. `funded` is the one that makes a package handable to a
   * watchtower, so it is what this service means by an exit.
   */
  mode?: ExitMode
  /**
   * The network label stamped on the package. Unset reads it off the wallet's
   * own prefix, which is exact except on the `tb` family — see
   * {@link exitNetworkName}.
   */
  networkName?: NetworkName
}

/**
 * Assemble the dependencies a server-independent exit needs from a live wallet.
 *
 * The onchain wallet is built from the SAME identity the Arkade wallet signs
 * with, which is not a convenience: `UnilateralExit.prepare` refuses a
 * mismatched pair outright ("onchainWallet must share the wallet identity"),
 * because in `funded` mode the splitter's change has to be recoverable by the
 * wallet key.
 */
export const unilateralExitDepsFor = async (
  ctx: ArkadeContext,
  wiring: UnilateralExitWiring = {},
): Promise<UnilateralExitDeps> => {
  const networkName = wiring.networkName ?? exitNetworkName(ctx.wallet.network.bech32)
  const onchainWallet = await OnchainWallet.create(ctx.identity, networkName, ctx.wallet.onchainProvider)
  return {
    exit: UnilateralExit,
    options: {
      wallet: ctx.wallet,
      onchainWallet,
      sweepAddress: wiring.sweepAddress ?? onchainWallet.address,
      networkName,
      ...(wiring.feeRate === undefined ? {} : { feeRate: wiring.feeRate }),
      ...(wiring.mode === undefined ? {} : { mode: wiring.mode }),
    },
    contracts: contractAccessFor(ctx),
    findLockups: (pkScriptHex) => findLockups(ctx, pkScriptHex),
  }
}
