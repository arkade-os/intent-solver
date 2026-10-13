import { RestEmulatorProvider } from '@arkade-os/sdk'
import { createArkadeContext } from '@arkade-os/solver-arkade/arkade/wallet.js'
import { arkDbPath } from '@arkade-os/solver-app/config.js'
import { resolveLimits } from '@arkade-os/solver-core/core/limits.js'
import { NETWORKS } from '@arkade-os/solver-core/core/networks.js'
import { esploraUrl, loadE2eEnv } from './preflight.js'
import { e2eNetwork, type E2eArkade } from './stack.js'

export const openRebalanceArkade = async (
  options: { mnemonic?: string; databasePath?: string } = {},
): Promise<E2eArkade> => {
  loadE2eEnv()
  const network = e2eNetwork()
  if (network !== 'regtest') throw new Error('rebalance e2e requires regtest')
  const profile = NETWORKS[network]
  const mnemonic = options.mnemonic ?? process.env.ARK_MNEMONIC
  const arkServerUrl = process.env.ARK_SERVER_URL
  const emulatorUrl = process.env.EMULATOR_URL
  if (!mnemonic || !arkServerUrl || !emulatorUrl) throw new Error('rebalance e2e requires wallet and stack settings')
  const ctx = await createArkadeContext({
    mnemonic,
    arkServerUrl,
    databasePath: options.databasePath ?? arkDbPath(),
    isMainnet: false,
    arkadeHrp: profile.arkadeHrp,
    expectedArkdNetwork: profile.arkdNetwork,
    esploraUrl: esploraUrl(),
  })
  const info = await new RestEmulatorProvider(emulatorUrl).getInfo()
  const limits = resolveLimits(network)
  return {
    ctx,
    emulator: { url: emulatorUrl, pubkey: info.signerPubkey },
    network,
    profile,
    limits,
    maxExposedSats: limits.maxSats * 100,
    close: () => ctx.close(),
  }
}
