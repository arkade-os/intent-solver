import { describe, expect, it, vi } from 'vitest'
import {
  buildOffchainTx,
  CSVMultisigTapscript,
  createAssetPacket,
  Extension,
  MultisigTapscript,
  SingleKey,
  TapTreeCoder,
  Transaction,
  VtxoScript,
  VtxoTaprootTree,
} from '@arkade-os/sdk'
import { base64, hex } from '@scure/base'
import {
  assertDirectFillResponse,
  buildDirectFillConflict,
  directFillFinalized,
  recoverDirectFillGraph,
  submitDirectFillConflict,
  validateDirectFillConflict,
  validateDirectFillGraph,
  validateDirectFillFundingAssets,
  type DirectFillChain,
  type DirectFillGraph,
  type DirectFillGraphDeps,
  type DirectFillOutpoint,
} from '@arkade-os/solver-arkade/arkade/directFillGraph.js'
import { attachEmulatorPackets } from '@arkade-os/solver-arkade/arkade/wallet.js'

const solver = SingleKey.fromHex('11'.repeat(32))
const server = SingleKey.fromHex('22'.repeat(32))
const foreign = SingleKey.fromHex('33'.repeat(32))
const solverKey = await solver.xOnlyPublicKey()
const serverKey = await server.xOnlyPublicKey()
const foreignKey = await foreign.xOnlyPublicKey()
const unroll = CSVMultisigTapscript.encode({ pubkeys: [serverKey], timelock: { type: 'blocks', value: 10n } })
const ownTree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverKey, serverKey] }).script])
const foreignTree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [foreignKey, serverKey] }).script])
const proceeds = hex.encode(ownTree.pkScript)
const coin = (seed: number, tree = ownTree) => ({
  txid: seed.toString(16).padStart(64, '0'),
  vout: 0,
  value: 5_000,
  script: hex.encode(tree.pkScript),
  tapTree: tree.encode(),
  forfeitTapLeafScript: tree.leaves[0]!,
})
const encode = (tx: Transaction) => base64.encode(tx.toPSBT())
const parse = (psbt: string) => Transaction.fromPSBT(base64.decode(psbt))
const deps = (): DirectFillGraphDeps => ({
  serverKey,
  solverKeys: [hex.encode(solverKey)],
  signer: solver,
  ark: { submitTx: vi.fn(), finalizeTx: vi.fn(), getPendingTxs: vi.fn().mockResolvedValue([]) },
})
const fixture = async (depositTree = foreignTree) => {
  const inputs = [coin(1, depositTree), coin(2)]
  const built = buildOffchainTx(
    inputs.map((input) => ({ ...input, tapLeafScript: input.forfeitTapLeafScript })),
    [{ script: ownTree.pkScript, amount: 10_000n }],
    unroll,
  )
  let signed = await solver.sign(built.arkTx, [1])
  signed = await foreign.sign(signed, [0])
  const graph = { arkTx: encode(signed), checkpoints: built.checkpoints.map(encode) }
  const final = await server.sign(signed, [0, 1])
  const checkpoints = await Promise.all(
    built.checkpoints.map(async (checkpoint, i) => {
      const ownSigned = await (i === 0 ? foreign : solver).sign(checkpoint, [0])
      return server.sign(ownSigned, [0])
    }),
  )
  const response = { arkTxid: signed.id, finalArkTx: encode(final), signedCheckpointTxs: checkpoints.map(encode) }
  return { graph, inputs, response, built }
}
const emulator = SingleKey.fromHex('44'.repeat(32))
const emulatorKey = await emulator.xOnlyPublicKey()
// The directed `fulfill` leaf, with an untweaked stand-in for EMULATOR_KEY:fulfill.
const directedTree = new VtxoScript([MultisigTapscript.encode({ pubkeys: [solverKey, serverKey, emulatorKey] }).script])
const directed = async () => {
  const inputs = [coin(1, directedTree), coin(2)]
  const built = buildOffchainTx(
    inputs.map((input) => ({ ...input, tapLeafScript: input.forfeitTapLeafScript })),
    [{ script: ownTree.pkScript, amount: 10_000n }],
    unroll,
  )
  // What submitViaEmulator hands the emulator: every input and checkpoint the taker signs.
  const arkTx = await solver.sign(built.arkTx, [0, 1])
  const checkpoints = await Promise.all(built.checkpoints.map((checkpoint) => solver.sign(checkpoint, [0])))
  const finalArk = await server.sign(await emulator.sign(arkTx, [0]), [0, 1])
  const pending = async (stored: Transaction[]) => ({
    arkTxid: arkTx.id,
    finalArkTx: encode(finalArk),
    signedCheckpointTxs: await Promise.all(stored.map(async (tx) => encode(await server.sign(tx, [0])))),
  })
  return {
    graph: { arkTx: encode(arkTx), checkpoints: checkpoints.map(encode) },
    inputs,
    // arkd <= v0.9.21 countersigns its rebuilt, unsigned checkpoints.
    rebuilt: await pending(built.checkpoints),
    // arkd >= v0.9.24 keeps the signatures the emulator submitted.
    preserved: await pending([await emulator.sign(checkpoints[0]!, [0]), checkpoints[1]!]),
  }
}
const chainFor = (graph: DirectFillGraph, inputs: ReturnType<typeof coin>[]): DirectFillChain => {
  const built = validateDirectFillGraph(graph, inputs)
  return {
    getVtxos: vi.fn(async ({ outpoints }: { outpoints: DirectFillOutpoint[] }) => ({
      vtxos: outpoints.flatMap<Awaited<ReturnType<DirectFillChain['getVtxos']>>['vtxos'][number]>((point) => {
        const index = inputs.findIndex((input) => input.txid === point.txid && input.vout === point.vout)
        if (index >= 0) return [{ ...point, spentBy: built.checkpointTxids[index], arkTxId: built.txid }]
        if (point.txid !== built.txid) return []
        const output = built.arkTx.getOutput(point.vout)
        return [{ ...point, script: hex.encode(output.script!), value: Number(output.amount) }]
      }),
    })),
    getVirtualTxs: vi.fn(async () => ({ txs: [graph.arkTx, ...graph.checkpoints] })),
  }
}

describe('direct fill committed graph recovery', () => {
  it('binds all original funding asset declarations to immutable selected-coin metadata', () => {
    const assetA = `${'aa'.repeat(32)}0000`
    const assetB = `${'bb'.repeat(32)}0000`
    const assetC = `${'cc'.repeat(32)}0000`
    const deposit = { ...coin(1, foreignTree), assets: [{ assetId: assetB, amount: 12n }] }
    const funding = [
      {
        ...coin(2),
        assets: [
          { assetId: assetA, amount: 9n },
          { assetId: assetC, amount: 3n },
        ],
      },
      { ...coin(3), assets: [] },
    ]
    const inputs = [deposit, ...funding]
    const build = (declared: Map<number, { assetId: string; amount: bigint }[]>): DirectFillGraph => {
      const built = buildOffchainTx(
        inputs.map((input) => ({ ...input, tapLeafScript: input.forfeitTapLeafScript })),
        [{ script: ownTree.pkScript, amount: 15_000n }],
        unroll,
      )
      const totals = new Map<string, bigint>()
      for (const assets of declared.values())
        for (const { assetId, amount } of assets) totals.set(assetId, (totals.get(assetId) ?? 0n) + amount)
      attachEmulatorPackets(built.arkTx, [
        createAssetPacket(declared, [
          { address: '', assets: [...totals].map(([assetId, amount]) => ({ assetId, amount })) },
        ]),
      ])
      return { arkTx: encode(built.arkTx), checkpoints: built.checkpoints.map(encode) }
    }
    const graph = build(
      new Map([
        [1, funding[0]!.assets!],
        [0, deposit.assets],
      ]),
    )
    expect(Extension.fromTx(parse(graph.arkTx)).getAssetPacket()!.groups[0]!.assetId!.toString()).toBe(assetA)
    expect(() => validateDirectFillFundingAssets(graph, funding)).not.toThrow()
    expect(() => validateDirectFillFundingAssets(graph, funding.toReversed())).not.toThrow()
    expect(() =>
      validateDirectFillFundingAssets(
        graph,
        funding.map((input) => ({ ...input, assets: [] })),
      ),
    ).toThrow('funding assets')
    const missing = build(
      new Map([
        [1, [{ assetId: assetA, amount: 9n }]],
        [0, deposit.assets],
      ]),
    )
    expect(() => validateDirectFillFundingAssets(missing, funding)).toThrow('funding assets')
    const changed = build(
      new Map([
        [
          1,
          [
            { assetId: assetA, amount: 8n },
            { assetId: assetC, amount: 3n },
          ],
        ],
        [0, deposit.assets],
      ]),
    )
    expect(() => validateDirectFillFundingAssets(changed, funding)).toThrow('funding assets')
    const misindexed = build(
      new Map([
        [2, funding[0]!.assets!],
        [0, deposit.assets],
      ]),
    )
    expect(() => validateDirectFillFundingAssets(misindexed, funding)).toThrow('funding assets')
  })
  it('requires every deposit and funding checkpoint exactly once in order', async () => {
    const { graph, inputs } = await fixture()
    expect(validateDirectFillGraph(graph, inputs).checkpointTxids).toHaveLength(2)
    expect(() => validateDirectFillGraph(graph, inputs.toReversed())).toThrow('different input')
    expect(() =>
      validateDirectFillGraph({ ...graph, checkpoints: [graph.checkpoints[0]!, graph.checkpoints[0]!] }, inputs),
    ).toThrow('bijection')
    expect(() => validateDirectFillGraph(graph, [inputs[0]!, inputs[0]!])).toThrow('bijection')
  })

  it('rejects unchanged txids with changed witness UTXO or tap metadata', async () => {
    const { graph, response } = await fixture()
    const altered = parse(response.signedCheckpointTxs[0]!)
    const input = altered.getInput(0)
    const unsigned = parse(graph.checkpoints[0]!)
    unsigned.updateInput(0, { witnessUtxo: { ...input.witnessUtxo!, amount: 1n } })
    expect(unsigned.id).toBe(altered.id)
    expect(() =>
      assertDirectFillResponse(graph, {
        ...response,
        signedCheckpointTxs: [encode(unsigned), response.signedCheckpointTxs[1]!],
      }),
    ).toThrow('witness UTXO')
    const changedLeaf = parse(graph.checkpoints[0]!)
    expect(() => changedLeaf.updateInput(0, { tapLeafScript: [ownTree.leaves[0]!] })).toThrow('Taproot commitment')
    expect(() =>
      assertDirectFillResponse(graph, { signedArkTx: graph.arkTx, signedCheckpointTxs: graph.checkpoints }),
    ).not.toThrow()
  })

  it('recovers only the original pending graph and never resubmits it', async () => {
    const { graph, inputs, response } = await fixture()
    const context = deps()
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([response])
    context.signer = { sign: vi.fn(solver.sign.bind(solver)) }
    expect(await recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).toBe(true)
    expect(context.ark.submitTx).not.toHaveBeenCalled()
    expect(context.ark.finalizeTx).toHaveBeenCalledOnce()
    const finalized = vi.mocked(context.ark.finalizeTx).mock.calls[0]!
    expect(finalized[0]).toBe(response.arkTxid)
    expect(finalized[1].map((psbt) => parse(psbt).id)).toEqual(graph.checkpoints.map((psbt) => parse(psbt).id))
    expect(vi.mocked(context.signer.sign).mock.calls).toHaveLength(1)
  })

  it('does not finalize absent, under-signed, forged or unrelated pending evidence', async () => {
    const { graph, inputs, response } = await fixture()
    const context = deps()
    expect(await recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).toBe(false)
    const serverOnly = await server.sign(parse(graph.checkpoints[0]!), [0])
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([
      { ...response, signedCheckpointTxs: [encode(serverOnly), response.signedCheckpointTxs[1]!] },
    ])
    await expect(recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).rejects.toThrow('Missing signatures')
    const forged = parse(graph.checkpoints[0]!)
    const signatures = parse(response.signedCheckpointTxs[0]!).getInput(0).tapScriptSig!
    forged.updateInput(0, {
      tapScriptSig: signatures.map(([data, signature], i) => [data, i === 0 ? new Uint8Array(64) : signature]),
    })
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([
      { ...response, signedCheckpointTxs: [encode(forged), response.signedCheckpointTxs[1]!] },
    ])
    await expect(recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).rejects.toThrow('Invalid signature')
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([{ ...response, arkTxid: 'aa'.repeat(32) }])
    expect(await recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).toBe(false)
    vi.mocked(context.ark.getPendingTxs).mockRejectedValue(new Error('indexer unavailable'))
    await expect(recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).rejects.toThrow('unavailable')
    expect(context.ark.finalizeTx).not.toHaveBeenCalled()
    expect(context.ark.submitTx).not.toHaveBeenCalled()
  })

  it('cannot finalize a pending directed fill from rebuilt checkpoints: only the emulator can sign its deposit', async () => {
    const { graph, inputs, rebuilt } = await directed()
    const context = deps()
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([rebuilt])
    await expect(recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).rejects.toThrow(
      `Missing signatures from: ${hex.encode(emulatorKey).slice(0, 16)}...`,
    )
    expect(context.ark.finalizeTx).not.toHaveBeenCalled()
    expect(context.ark.submitTx).not.toHaveBeenCalled()
  })

  it('finalizes a pending directed fill that kept its submitted signatures, signing only its proof', async () => {
    const { graph, inputs, preserved } = await directed()
    const context = deps()
    context.signer = { sign: vi.fn(solver.sign.bind(solver)) }
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([preserved])
    expect(await recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).toBe(true)
    expect(vi.mocked(context.signer.sign).mock.calls).toHaveLength(1)
    expect(vi.mocked(context.ark.finalizeTx).mock.calls[0]![1].map((psbt) => parse(psbt).id)).toEqual(
      graph.checkpoints.map((psbt) => parse(psbt).id),
    )
    expect(context.ark.submitTx).not.toHaveBeenCalled()
  })

  it('adds only the missing solver checkpoint signature after authenticating the committed graph', async () => {
    const { graph, inputs, response } = await fixture()
    const context = deps()
    context.signer = { sign: vi.fn(solver.sign.bind(solver)) }
    const ownServerOnly = await server.sign(parse(graph.checkpoints[1]!), [0])
    vi.mocked(context.ark.getPendingTxs).mockResolvedValue([
      { ...response, signedCheckpointTxs: [response.signedCheckpointTxs[0]!, encode(ownServerOnly)] },
    ])
    expect(await recoverDirectFillGraph(context, graph, inputs, [inputs[1]!])).toBe(true)
    expect(vi.mocked(context.signer.sign).mock.calls).toHaveLength(2)
    expect(vi.mocked(context.signer.sign).mock.calls[1]![0].id).toBe(ownServerOnly.id)
    await expect(recoverDirectFillGraph(context, graph, inputs, [inputs[0]!])).rejects.toThrow('not controlled')
  })

  it('requires actual finalized outputs and matching graph bytes, not a spent hint', async () => {
    const { graph, inputs } = await fixture()
    const chain = chainFor(graph, inputs)
    expect(await directFillFinalized(chain, graph, inputs)).toBe(true)
    vi.mocked(chain.getVirtualTxs).mockResolvedValue({ txs: [] })
    expect(await directFillFinalized(chain, graph, inputs)).toBe(false)
    const incomplete = chainFor(graph, inputs)
    vi.mocked(incomplete.getVtxos)
      .mockResolvedValueOnce({
        vtxos: inputs.map((input, i) => ({ ...input, spentBy: parse(graph.checkpoints[i]!).id })),
      })
      .mockResolvedValueOnce({ vtxos: [] })
    expect(await directFillFinalized(incomplete, graph, inputs)).toBe(false)
    const mixed = chainFor(graph, inputs)
    vi.mocked(mixed.getVtxos).mockResolvedValue({
      vtxos: inputs.map((input) => ({ ...input, spentBy: 'ff'.repeat(32) })),
    })
    expect(await directFillFinalized(mixed, graph, inputs)).toBe(false)
  })

  it.each([3, 5, 6])('accepts arkd depth metadata for a finalized %s-leaf checkpoint', async (count) => {
    const tree = new VtxoScript(
      Array.from(
        { length: count },
        (_, index) =>
          CSVMultisigTapscript.encode({
            pubkeys: [foreignKey, serverKey],
            timelock: { type: 'blocks', value: BigInt(index + 1) },
          }).script,
      ),
    )
    const { graph, inputs } = await fixture(tree)
    const checkpoint = parse(graph.checkpoints[0]!)
    const changed = (scripts: readonly Uint8Array[]) => {
      const copy = Transaction.fromPSBT(checkpoint.toPSBT())
      const raw = TapTreeCoder.encode(
        scripts.map((script, index) => ({
          depth: Math.min(index + 1, scripts.length - 1),
          version: 0xc0,
          script: Uint8Array.from(script),
        })),
      )
      const unknown = copy.getInput(0).unknown!.filter((entry) => VtxoTaprootTree.decode(entry) === null)
      copy.updateInput(0, { unknown: undefined })
      copy.updateInput(0, { unknown: [...unknown, VtxoTaprootTree.encode(raw)] })
      expect(copy.id).toBe(checkpoint.id)
      return encode(copy)
    }
    const chain = chainFor(graph, inputs)
    vi.mocked(chain.getVirtualTxs).mockResolvedValue({
      txs: [graph.arkTx, changed(tree.scripts), graph.checkpoints[1]!],
    })
    await expect(directFillFinalized(chain, graph, inputs)).resolves.toBe(true)
    vi.mocked(chain.getVirtualTxs).mockResolvedValue({
      txs: [graph.arkTx, changed([ownTree.scripts[0]!, ...tree.scripts.slice(1)]), graph.checkpoints[1]!],
    })
    await expect(directFillFinalized(chain, graph, inputs)).rejects.toThrow('taptree changed')
  })

  it('returns every selected coin, all sats and every asset to the recorded own script', async () => {
    const assetA = `${'aa'.repeat(32)}0000`
    const assetB = `${'bb'.repeat(32)}0000`
    const inputs = [
      {
        ...coin(2),
        assets: [
          { assetId: assetA, amount: 9n },
          { assetId: assetB, amount: '3' },
        ],
      },
      coin(3),
    ]
    const context = { ...deps(), serverUnrollScript: unroll }
    const graph = await buildDirectFillConflict(context, inputs, proceeds)
    const built = validateDirectFillConflict(graph, inputs, proceeds)
    expect(built.arkTx.getOutput(0)).toMatchObject({ amount: 10_000n, script: ownTree.pkScript })
    expect(
      Extension.fromTx(built.arkTx)
        .getAssetPacket()!
        .groups.map((group) => group.assetId?.toString()),
    ).toEqual([assetA, assetB])
    expect(() => validateDirectFillConflict(graph, inputs, hex.encode(foreignTree.pkScript))).toThrow('proceeds script')
    expect(() =>
      validateDirectFillConflict(
        graph,
        inputs.map((input) => ({ ...input, assets: [] })),
        proceeds,
      ),
    ).toThrow('additional spendable output')
    expect(() =>
      validateDirectFillConflict(
        graph,
        inputs.map((input) => ({ ...input, value: input.value + 1 })),
        proceeds,
      ),
    ).toThrow('recorded funding')
    await expect(buildDirectFillConflict(context, [coin(4, foreignTree)], proceeds)).rejects.toThrow('not controlled')
  })

  it('retries only stored conflict bytes, and a lost reply remains ambiguous', async () => {
    const inputs = [coin(2), coin(3)]
    const context = deps()
    const graph = await buildDirectFillConflict({ ...context, serverUnrollScript: unroll }, inputs, proceeds)
    vi.mocked(context.ark.submitTx).mockRejectedValue(new Error('lost response'))
    await expect(submitDirectFillConflict(context, graph, inputs)).rejects.toThrow('lost response')
    await expect(submitDirectFillConflict(context, graph, inputs)).rejects.toThrow('lost response')
    expect(context.ark.submitTx).toHaveBeenNthCalledWith(1, graph.arkTx, graph.checkpoints)
    expect(context.ark.submitTx).toHaveBeenNthCalledWith(2, graph.arkTx, graph.checkpoints)
    expect(context.ark.finalizeTx).not.toHaveBeenCalled()
  })

  it('recovers an accepted conflict after losing its reply without resubmitting it', async () => {
    const inputs = [coin(2), coin(3)]
    const context = deps()
    const graph = await buildDirectFillConflict({ ...context, serverUnrollScript: unroll }, inputs, proceeds)
    const finalArk = await server.sign(parse(graph.arkTx), [0, 1])
    const checkpoints = await Promise.all(
      graph.checkpoints.map(async (psbt) => encode(await server.sign(parse(psbt), [0]))),
    )
    const accepted = { arkTxid: finalArk.id, finalArkTx: encode(finalArk), signedCheckpointTxs: checkpoints }
    vi.mocked(context.ark.submitTx).mockImplementation(async () => {
      vi.mocked(context.ark.getPendingTxs).mockResolvedValue([accepted])
      throw new Error('lost accepted reply')
    })
    await expect(submitDirectFillConflict(context, graph, inputs)).rejects.toThrow('lost accepted reply')
    await submitDirectFillConflict(context, graph, inputs)
    expect(context.ark.submitTx).toHaveBeenCalledOnce()
    expect(context.ark.finalizeTx).toHaveBeenCalledOnce()
    expect(await directFillFinalized(chainFor(graph, inputs), graph, inputs)).toBe(true)
  })
})
