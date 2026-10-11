import {
  assertSubmittedArkTxid,
  asset,
  buildOffchainTx,
  Extension,
  getArkPsbtFields,
  Intent,
  matchServerCheckpoints,
  MultisigTapscript,
  scriptFromTapLeafScript,
  Transaction,
  verifyTapscriptSignatures,
  VtxoScript,
  VtxoTaprootTree,
  type ArkProvider,
  type CSVMultisigTapscript,
  type Identity,
  type TapLeafScript,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import { attachEmulatorPackets, refundAssetPacket } from './wallet.js'

export interface DirectFillGraph {
  arkTx: string
  checkpoints: string[]
}

export interface DirectFillOutpoint {
  txid: string
  vout: number
}

export interface DirectFillFunding extends DirectFillOutpoint {
  value: number
  script: string
  assets?: readonly { assetId: string; amount: bigint | string }[]
}

export interface DirectFillCoin extends DirectFillFunding {
  forfeitTapLeafScript: TapLeafScript
  tapTree: Uint8Array
}

export interface DirectFillChain {
  getVtxos(opts: { outpoints: DirectFillOutpoint[] }): Promise<{
    vtxos: readonly (DirectFillOutpoint & {
      spentBy?: string
      arkTxId?: string
      script?: string
      value?: number
    })[]
  }>
  getVirtualTxs(txids: string[]): Promise<{ txs: readonly string[] }>
}

export interface DirectFillGraphDeps {
  ark: Pick<ArkProvider, 'submitTx' | 'finalizeTx' | 'getPendingTxs'>
  signer: Pick<Identity, 'sign'>
  serverKey: Uint8Array
  solverKeys: readonly string[]
}

const key = (point: DirectFillOutpoint): string => `${point.txid}:${point.vout}`
const parse = (psbt: string): Transaction => Transaction.fromPSBT(base64.decode(psbt))
const encode = (tx: Transaction): string => base64.encode(tx.toPSBT())
const inputPoint = (tx: Transaction, i: number): DirectFillOutpoint => {
  const input = tx.getInput(i)
  if (input.txid === undefined || input.index === undefined) throw new Error('direct fill has no input outpoint')
  return { txid: hex.encode(input.txid), vout: input.index }
}
const canonical = (value: unknown): unknown => {
  if (value instanceof Uint8Array) return hex.encode(value)
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, field]) => [name, canonical(field)]),
    )
  return value
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))

const assertCommitment = (got: Transaction, want: Transaction, allowRemovedMetadata = false): void => {
  if (got.id !== want.id) throw new Error('direct fill transaction id changed')
  for (let i = 0; i < want.inputsLength; i++) {
    const expected = want.getInput(i)
    const actual = got.getInput(i)
    if (!expected.witnessUtxo || !same(actual.witnessUtxo, expected.witnessUtxo)) {
      throw new Error('direct fill witness UTXO changed')
    }
    for (const field of ['tapLeafScript', 'tapInternalKey', 'tapMerkleRoot'] as const) {
      if (allowRemovedMetadata && actual[field] === undefined) continue
      if (!same(actual[field], expected[field])) throw new Error(`direct fill ${field} changed`)
    }
    const trees = (tx: Transaction) => getArkPsbtFields(tx, i, VtxoTaprootTree).map(hex.encode).sort()
    if (!(allowRemovedMetadata && trees(got).length === 0) && !same(trees(got), trees(want))) {
      throw new Error('direct fill taptree changed')
    }
  }
}

export const validateDirectFillGraph = (graph: DirectFillGraph, expected: readonly DirectFillOutpoint[]) => {
  const arkTx = parse(graph.arkTx)
  const checkpoints = graph.checkpoints.map(parse)
  if (
    expected.length === 0 ||
    new Set(expected.map(key)).size !== expected.length ||
    checkpoints.length !== expected.length ||
    arkTx.inputsLength !== expected.length ||
    new Set(checkpoints.map((tx) => tx.id)).size !== checkpoints.length
  )
    throw new Error('direct fill graph is not a bijection')
  for (let i = 0; i < expected.length; i++) {
    const checkpoint = checkpoints[i]!
    if (checkpoint.inputsLength !== 1 || key(inputPoint(checkpoint, 0)) !== key(expected[i]!)) {
      throw new Error('direct fill checkpoint spends a different input')
    }
    if (key(inputPoint(arkTx, i)) !== `${checkpoint.id}:0`) throw new Error('direct fill checkpoint link changed')
    if (!same(arkTx.getInput(i).witnessUtxo, checkpoint.getOutput(0))) {
      throw new Error('direct fill checkpoint output does not match its witness UTXO')
    }
    assertCommitment(checkpoint, checkpoint)
  }
  assertCommitment(arkTx, arkTx)
  return { txid: arkTx.id, checkpointTxids: checkpoints.map((tx) => tx.id), arkTx, checkpoints }
}

type Response = { arkTxid: string; finalArkTx?: string; signedCheckpointTxs: string[] }

export const validateDirectFillFundingAssets = (
  graph: DirectFillGraph,
  funding: readonly DirectFillFunding[],
): void => {
  const points = graph.checkpoints.map((psbt) => inputPoint(parse(psbt), 0))
  const { arkTx } = validateDirectFillGraph(graph, points)
  if (funding.length === 0) throw new Error('direct fill funding assets have no selected inputs')
  const selected = new Map<number, ReadonlyMap<string, bigint>>()
  for (const coin of funding) {
    const vin = points.findIndex((point) => key(point) === key(coin))
    if (vin < 0 || selected.has(vin)) throw new Error('direct fill funding assets name a missing or duplicate input')
    const expected = new Map<string, bigint>()
    for (const { assetId, amount } of coin.assets ?? []) {
      const canonicalAssetId = asset.AssetId.fromString(assetId).toString()
      if (expected.has(canonicalAssetId) || BigInt(amount) <= 0n)
        throw new Error('direct fill funding assets are not unique positive amounts')
      expected.set(canonicalAssetId, BigInt(amount))
    }
    selected.set(vin, expected)
  }
  const extensions = Array.from({ length: arkTx.outputsLength }, (_, i) => arkTx.getOutput(i).script).filter(
    (script): script is Uint8Array => script !== undefined && Extension.isExtension(script),
  )
  if (extensions.length > 1) throw new Error('direct fill funding assets have multiple extension outputs')
  const packet = extensions[0] === undefined ? null : Extension.fromBytes(extensions[0]).getAssetPacket()
  const declared = new Map<number, Map<string, bigint>>()
  for (const group of packet?.groups ?? []) {
    for (const input of group.inputs) {
      if (input.input.type !== asset.AssetInputType.Local || input.vin >= points.length) {
        throw new Error('direct fill funding assets require local graph inputs')
      }
      if (!selected.has(input.vin)) continue
      const assetId = group.assetId?.toString()
      const amounts = declared.get(input.vin) ?? new Map<string, bigint>()
      if (assetId === undefined || amounts.has(assetId) || input.amount <= 0n) {
        throw new Error('direct fill funding assets have duplicate or invalid declarations')
      }
      amounts.set(assetId, input.amount)
      declared.set(input.vin, amounts)
    }
  }
  for (const [vin, expected] of selected) {
    const actual = declared.get(vin) ?? new Map<string, bigint>()
    if (actual.size !== expected.size || [...expected].some(([assetId, amount]) => actual.get(assetId) !== amount)) {
      throw new Error(`direct fill funding assets differ at input ${vin}`)
    }
  }
}

export const assertDirectFillResponse = (
  graph: DirectFillGraph,
  returned: Response | { signedArkTx: string; signedCheckpointTxs: string[] },
): void => {
  const response =
    'signedArkTx' in returned
      ? {
          arkTxid: parse(returned.signedArkTx).id,
          finalArkTx: returned.signedArkTx,
          signedCheckpointTxs: returned.signedCheckpointTxs,
        }
      : returned
  const arkTx = parse(graph.arkTx)
  assertSubmittedArkTxid(response, arkTx, 'direct fill')
  if (response.finalArkTx !== undefined) assertCommitment(parse(response.finalArkTx), arkTx)
  for (const { server, local } of matchServerCheckpoints(
    response.signedCheckpointTxs,
    graph.checkpoints.map(parse),
    'direct fill',
  )) {
    assertCommitment(server, local)
  }
}

export const directFillFinalized = async (
  chain: DirectFillChain,
  graph: DirectFillGraph,
  expected: readonly DirectFillOutpoint[],
): Promise<boolean> => {
  const built = validateDirectFillGraph(graph, expected)
  const { vtxos: inputs } = await chain.getVtxos({ outpoints: [...expected] })
  for (let i = 0; i < expected.length; i++) {
    const matches = inputs.filter((coin) => key(coin) === key(expected[i]!))
    if (matches.length !== 1) return false
    const coin = matches[0]!
    if (!coin.spentBy && !coin.arkTxId) return false
    if (coin.spentBy && coin.spentBy !== built.checkpointTxids[i]) return false
    if (coin.arkTxId && coin.arkTxId !== built.txid) return false
  }
  const outputs = Array.from({ length: built.arkTx.outputsLength }, (_, vout) => ({
    txid: built.txid,
    vout,
    output: built.arkTx.getOutput(vout),
  })).filter(({ output }) => output.script?.length === 34 && output.script[0] === 0x51 && output.script[1] === 0x20)
  if (outputs.length === 0) throw new Error('direct fill has no virtual outputs')
  const { vtxos } = await chain.getVtxos({ outpoints: outputs.map(({ txid, vout }) => ({ txid, vout })) })
  for (const { txid, vout, output } of outputs) {
    const matches = vtxos.filter((coin) => coin.txid === txid && coin.vout === vout)
    if (matches.length !== 1) return false
    if (matches[0]!.script !== hex.encode(output.script!) || BigInt(matches[0]!.value ?? -1) !== output.amount) {
      throw new Error('direct fill finalized output differs from the committed graph')
    }
  }
  const wanted = [built.arkTx, ...built.checkpoints]
  const { txs } = await chain.getVirtualTxs(wanted.map((tx) => tx.id))
  const observed = txs.map(parse)
  for (const tx of wanted) {
    const matches = observed.filter((candidate) => candidate.id === tx.id)
    if (matches.length !== 1) return false
    assertCommitment(matches[0]!, tx, true)
  }
  return true
}

const requiredSigners = (tx: Transaction, index: number, serverKey: Uint8Array): string[] => {
  const leaf = tx.getInput(index).tapLeafScript
  if (leaf?.length !== 1) throw new Error('direct fill requires one committed collaborative leaf')
  const signers = MultisigTapscript.decode(scriptFromTapLeafScript(leaf[0]!)).params.pubkeys.map(hex.encode)
  if (new Set(signers).size !== signers.length || !signers.includes(hex.encode(serverKey))) {
    throw new Error('direct fill leaf does not name its server')
  }
  return signers
}

const mergeSignatures = (target: Transaction, original: Transaction): void => {
  for (let i = 0; i < target.inputsLength; i++) {
    const signatures = new Map<string, NonNullable<ReturnType<Transaction['getInput']>['tapScriptSig']>[number]>()
    for (const entry of [...(original.getInput(i).tapScriptSig ?? []), ...(target.getInput(i).tapScriptSig ?? [])]) {
      const id = `${hex.encode(entry[0].pubKey)}:${hex.encode(entry[0].leafHash)}`
      if (signatures.has(id) && !same(signatures.get(id), entry)) throw new Error('direct fill conflicting signatures')
      signatures.set(id, entry)
    }
    if (signatures.size) target.updateInput(i, { tapScriptSig: [...signatures.values()] })
  }
}

const assertFullySigned = (tx: Transaction, serverKey: Uint8Array): void => {
  for (let i = 0; i < tx.inputsLength; i++) {
    const signers = requiredSigners(tx, i, serverKey)
    if (
      tx
        .getInput(i)
        .tapScriptSig?.some(
          ([data, signature]) => signature.length !== 64 || !signers.includes(hex.encode(data.pubKey)),
        )
    ) {
      throw new Error('direct fill requires only its leaf signers with DEFAULT signatures')
    }
    verifyTapscriptSignatures(tx, i, signers)
  }
}

const finalizeResponse = async (
  deps: DirectFillGraphDeps,
  graph: DirectFillGraph,
  response: Response,
  owned: readonly DirectFillOutpoint[],
): Promise<void> => {
  assertDirectFillResponse(graph, response)
  if (response.finalArkTx === undefined) throw new Error('direct fill recovery has no signed Ark transaction')
  const finalArk = parse(response.finalArkTx)
  mergeSignatures(finalArk, parse(graph.arkTx))
  assertFullySigned(finalArk, deps.serverKey)
  const ownedKeys = new Set(owned.map(key))
  const final: string[] = []
  for (const { server, local } of matchServerCheckpoints(
    response.signedCheckpointTxs,
    graph.checkpoints.map(parse),
    'direct fill',
  )) {
    mergeSignatures(server, local)
    let signed = server
    if (ownedKeys.has(key(inputPoint(local, 0)))) {
      const signers = requiredSigners(local, 0, deps.serverKey)
      if (signers.length !== 2 || !deps.solverKeys.some((pubkey) => signers.includes(pubkey))) {
        throw new Error('direct fill checkpoint is not controlled by this solver')
      }
      if (!server.getInput(0).tapScriptSig?.some(([data]) => deps.solverKeys.includes(hex.encode(data.pubKey)))) {
        signed = await deps.signer.sign(server, [0])
        assertCommitment(signed, local)
      }
    }
    assertFullySigned(signed, deps.serverKey)
    final.push(encode(signed))
  }
  await deps.ark.finalizeTx(response.arkTxid, final)
}

export const recoverDirectFillGraph = async (
  deps: DirectFillGraphDeps,
  graph: DirectFillGraph,
  expected: readonly DirectFillOutpoint[],
  owned: readonly DirectFillOutpoint[],
): Promise<boolean> => {
  const built = validateDirectFillGraph(graph, expected)
  const ownedKeys = new Set(owned.map(key))
  const ownedCheckpoints = built.checkpoints.filter((tx) => ownedKeys.has(key(inputPoint(tx, 0))))
  for (const checkpoint of ownedCheckpoints) {
    const signers = requiredSigners(checkpoint, 0, deps.serverKey)
    if (signers.length !== 2 || !deps.solverKeys.some((pubkey) => signers.includes(pubkey))) {
      throw new Error('direct fill proof input is not controlled by this solver')
    }
  }
  const inputs = ownedCheckpoints.map((tx) => tx.getInput(0))
  if (inputs.length !== owned.length || inputs.length === 0)
    throw new Error('direct fill has no exact owned proof inputs')
  const message: Intent.GetPendingTxMessage = { type: 'get-pending-tx', expire_at: 0 }
  const proof = await deps.signer.sign(
    Intent.create(message, inputs),
    Array.from({ length: inputs.length + 1 }, (_, i) => i),
  )
  const pending = (await deps.ark.getPendingTxs({ proof: encode(proof), message })).filter(
    (tx) => tx.arkTxid === built.txid,
  )
  if (pending.length === 0) return false
  if (pending.length !== 1) throw new Error('direct fill provider returned duplicate pending transactions')
  await finalizeResponse(deps, graph, pending[0]!, owned)
  return true
}

export const validateDirectFillConflict = (
  graph: DirectFillGraph,
  funding: readonly DirectFillFunding[],
  proceedsScript: string,
) => {
  const built = validateDirectFillGraph(graph, funding)
  for (let i = 0; i < funding.length; i++) {
    const input = built.checkpoints[i]!.getInput(0).witnessUtxo!
    if (input.amount !== BigInt(funding[i]!.value) || hex.encode(input.script) !== funding[i]!.script) {
      throw new Error('direct fill conflict differs from its recorded funding')
    }
  }
  const packet = refundAssetPacket(
    funding.map((coin) => ({
      ...coin,
      assets: (coin.assets ?? []).map((entry) => ({ assetId: entry.assetId, amount: BigInt(entry.amount) })),
    })),
    'aggregate',
  )
  const extension = packet ? hex.encode(Extension.create([packet]).serialize()) : undefined
  const total = built.checkpoints.reduce((sum, tx) => sum + tx.getInput(0).witnessUtxo!.amount, 0n)
  const output = built.arkTx.getOutput(0)
  if (hex.encode(output.script ?? new Uint8Array()) !== proceedsScript || output.amount !== total) {
    throw new Error('direct fill conflict does not return all sats to its recorded proceeds script')
  }
  let extensionCount = 0
  let anchorCount = 0
  for (let i = 1; i < built.arkTx.outputsLength; i++) {
    const extra = built.arkTx.getOutput(i)
    const script = hex.encode(extra.script ?? new Uint8Array())
    if (extra.amount !== 0n || (script !== '51024e73' && script !== extension)) {
      throw new Error('direct fill conflict has an additional spendable output')
    }
    if (script === extension) extensionCount++
    if (script === '51024e73') anchorCount++
  }
  if (anchorCount !== 1 || extensionCount !== (packet ? 1 : 0))
    throw new Error('direct fill conflict does not preserve its exact asset packet')
  return built
}

export const buildDirectFillConflict = async (
  deps: Pick<DirectFillGraphDeps, 'signer' | 'serverKey' | 'solverKeys'> & {
    serverUnrollScript: CSVMultisigTapscript.Type
  },
  coins: readonly DirectFillCoin[],
  proceedsScript: string,
): Promise<DirectFillGraph> => {
  for (const coin of coins) {
    const tree = VtxoScript.decode(coin.tapTree)
    const leaf = scriptFromTapLeafScript(coin.forfeitTapLeafScript)
    const signers = MultisigTapscript.decode(leaf).params.pubkeys.map(hex.encode)
    if (
      hex.encode(tree.pkScript) !== coin.script ||
      !tree.leaves.some((candidate) => same(candidate, coin.forfeitTapLeafScript)) ||
      signers.length !== 2 ||
      !signers.includes(hex.encode(deps.serverKey)) ||
      !deps.solverKeys.some((pubkey) => signers.includes(pubkey))
    )
      throw new Error('direct fill conflict input is not controlled by this solver')
  }
  const { arkTx, checkpoints } = buildOffchainTx(
    coins.map((coin) => ({ ...coin, tapLeafScript: coin.forfeitTapLeafScript })),
    [{ script: hex.decode(proceedsScript), amount: coins.reduce((sum, coin) => sum + BigInt(coin.value), 0n) }],
    deps.serverUnrollScript,
  )
  const packet = refundAssetPacket(
    coins.map((coin) => ({
      ...coin,
      assets: (coin.assets ?? []).map((entry) => ({ assetId: entry.assetId, amount: BigInt(entry.amount) })),
    })),
    'aggregate',
  )
  if (packet) attachEmulatorPackets(arkTx, [packet])
  const signed = await deps.signer.sign(
    arkTx,
    coins.map((_, i) => i),
  )
  assertCommitment(signed, arkTx)
  const graph = { arkTx: encode(signed), checkpoints: checkpoints.map(encode) }
  validateDirectFillConflict(graph, coins, proceedsScript)
  return graph
}

export const submitDirectFillConflict = async (
  deps: DirectFillGraphDeps,
  graph: DirectFillGraph,
  funding: readonly DirectFillOutpoint[],
): Promise<void> => {
  validateDirectFillGraph(graph, funding)
  if (await recoverDirectFillGraph(deps, graph, funding, funding)) return
  const response = await deps.ark.submitTx(graph.arkTx, [...graph.checkpoints])
  await finalizeResponse(deps, graph, response, funding)
}
