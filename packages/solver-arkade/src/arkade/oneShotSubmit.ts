/**
 * Vendored from ts-sdk#1069's `signAndSubmitOffchainTx`: checkpoints go out signed, so arkd v0.9.22+
 * finalizes inside `submitTx` and echoes our signatures back. An older arkd rebuilds them unsigned and
 * gets ours merged into `finalizeTx`. Nothing the server returns is ever signed.
 * ponytail: delete for the SDK's own once an @arkade-os/sdk release carries #1069.
 */

import {
  assertSubmittedArkTxid,
  buildOffchainTx,
  combineTapscriptSigs,
  ConditionWitness,
  getArkPsbtFields,
  matchServerCheckpoints,
  scriptFromTapLeafScript,
  ServerResponseMismatchError,
  setArkPsbtField,
  toXOnly,
  Transaction,
  verifyTapscriptSignatures,
  type ArkProvider,
  type Identity,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { tapLeafHash } from '@scure/btc-signer/payment.js'

// Input 0 only: buildOffchainTx gives every checkpoint exactly one input, the VTXO it spends.
const sigEntries = (checkpoint: Transaction): string[] =>
  (checkpoint.getInput(0).tapScriptSig ?? []).map(
    ([{ pubKey, leafHash }, sig]) => hex.encode(pubKey) + hex.encode(leafHash) + hex.encode(sig),
  )

const carriesSigs = (server: Transaction, ours: Transaction): boolean => {
  const echoed = new Set(sigEntries(server))
  const want = sigEntries(ours)
  return want.length > 0 && want.every((entry) => echoed.has(entry))
}

const assertServerSigned = (serverTx: Transaction, localTx: Transaction, index: number, server: string): void => {
  const leaf = localTx.getInput(index).tapLeafScript?.[0]
  if (!leaf) throw new ServerResponseMismatchError(`submitTx: input ${index} carries no spend leaf`)
  const script = scriptFromTapLeafScript(leaf)
  try {
    verifyTapscriptSignatures(serverTx, index, [server], undefined, undefined, tapLeafHash(script))
  } catch (error) {
    throw new ServerResponseMismatchError(
      `submitTx: input ${index} is not signed by the server on the leaf being spent (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

export const signAndSubmitOneShot = async (params: {
  identity: Pick<Identity, 'sign'>
  provider: Pick<ArkProvider, 'submitTx' | 'finalizeTx'>
  inputs: Parameters<typeof buildOffchainTx>[0]
  outputs: Parameters<typeof buildOffchainTx>[1]
  serverUnrollScript: Parameters<typeof buildOffchainTx>[2]
  verifyServerSignatures?: { serverPubkey: Uint8Array }
}): Promise<string> => {
  const { arkTx, checkpoints } = buildOffchainTx(params.inputs, params.outputs, params.serverUnrollScript)
  const signedArkTx = await params.identity.sign(arkTx)
  const signed = await Promise.all(checkpoints.map((c) => params.identity.sign(c.clone(), [0])))
  const response = await params.provider.submitTx(
    base64.encode(signedArkTx.toPSBT()),
    signed.map((c) => base64.encode(c.toPSBT())),
  )
  assertSubmittedArkTxid(response, signedArkTx, 'submitTx')
  const matched = matchServerCheckpoints(response.signedCheckpointTxs, checkpoints, 'submitTx')

  if (params.verifyServerSignatures) {
    const server = hex.encode(toXOnly(params.verifyServerSignatures.serverPubkey, 'server key'))
    const finalArkTx = Transaction.fromPSBT(base64.decode(response.finalArkTx))
    for (let i = 0; i < arkTx.inputsLength; i++) assertServerSigned(finalArkTx, arkTx, i, server)
    for (const { server: returned, local } of matched) assertServerSigned(returned, local, 0, server)
  }

  // matchServerCheckpoints pairs each returned copy with one of `checkpoints`, so every `local.id` is a key.
  const ours = new Map(checkpoints.map((c, i) => [c.id, signed[i]!]))
  if (matched.every(({ server, local }) => carriesSigs(server, ours.get(local.id)!))) return response.arkTxid

  const finalCheckpoints = matched.map(({ server, local }) => {
    const mine = ours.get(local.id)!
    combineTapscriptSigs(mine, server)
    // The rebuilt copy drops a claim's preimage, and finalizeTx checks the leaf's condition against it.
    const [witness] = getArkPsbtFields(mine, 0, ConditionWitness)
    if (witness && getArkPsbtFields(server, 0, ConditionWitness).length === 0) {
      setArkPsbtField(server, 0, ConditionWitness, witness)
    }
    return base64.encode(server.toPSBT())
  })
  await params.provider.finalizeTx(response.arkTxid, finalCheckpoints)
  return response.arkTxid
}
