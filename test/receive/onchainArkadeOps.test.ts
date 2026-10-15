import { describe, it, expect, vi } from 'vitest'
import { schnorr } from '@noble/curves/secp256k1.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64, hex } from '@scure/base'
import { CSVMultisigTapscript, MnemonicIdentity, Transaction } from '@arkade-os/sdk'
import { CovenantSwapScript } from '@arkade-os/solver-arkade/arkade/covenant.js'
import type { ArkadeContext, FundedOutput } from '@arkade-os/solver-arkade/arkade/wallet.js'
import type { CovenantScriptRow } from '@arkade-os/solver-corridors/send/orchestrator.js'

// `refundSwapScript` builds its own RestEmulatorProvider: mocking it is the only way to observe the WRONG path.
const emulatorSubmitTx = vi.fn(async (arkTxB64: string, _checkpointsB64: string[]) => ({ signedArkTx: arkTxB64 }))
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>()
  return {
    ...actual,
    RestEmulatorProvider: vi.fn().mockImplementation(() => ({ submitTx: emulatorSubmitTx })),
  }
})

const { onchainReceiveArkadeOpsFromContext } = await import('@arkade-os/solver-corridors/receive/onchainArkadeOps.js')

const key = (fill: number): Uint8Array => schnorr.getPublicKey(new Uint8Array(32).fill(fill))
const p2tr = (program: Uint8Array): Uint8Array => Uint8Array.from([0x51, 0x20, ...program])

const SOLVER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const solverIdentity = MnemonicIdentity.fromMnemonic(SOLVER_MNEMONIC, { isMainnet: false })
const SOLVER = await solverIdentity.xOnlyPublicKey()

const CLIENT = key(2)
const SERVER = key(3)
const EMULATOR = key(9)
const CLIENT_PAYOUT = p2tr(key(13))
const PREIMAGE = new Uint8Array(32).fill(7)
const PAYMENT_HASH = hex.encode(sha256(PREIMAGE))
const REFUND_LOCKTIME = 1_800_000_000
const CLAIM_DELAY = 512
const REFUND_WITHOUT_RECEIVER_DELAY = 6144
const REFUND_DELAY = 5120

/** The covenant this leg funds: the CLIENT is `receiver`, the SOLVER is `client`. */
const lockupScript = () =>
  new CovenantSwapScript({
    receiver: CLIENT,
    server: SERVER,
    preimageHash: ripemd160(sha256(PREIMAGE)),
    refundLocktime: REFUND_LOCKTIME,
    claimDelay: CLAIM_DELAY,
    client: SOLVER,
    clientRefundDelay: REFUND_WITHOUT_RECEIVER_DELAY,
    refundWithoutServerDelay: REFUND_DELAY,
    nonInteractiveParameters: {
      emulatorPubkey: EMULATOR,
      receiverPkScript: CLIENT_PAYOUT,
      senderPkScript: p2tr(SOLVER),
    },
  })

const SOLVER_ADDRESS = lockupScript().address('tark', SERVER).encode()

/** `receiveCovenantRowFor`'s mapping, written out: `receiverPubkey` is the client's key. */
const row = (): CovenantScriptRow => ({
  id: 'swap-1',
  receiverPubkey: hex.encode(CLIENT),
  serverPubkey: hex.encode(SERVER),
  paymentHash: PAYMENT_HASH,
  refundLocktime: REFUND_LOCKTIME,
  claimDelay: CLAIM_DELAY,
  emulatorPubkey: hex.encode(EMULATOR),
  refundPkScript: hex.encode(p2tr(SOLVER)),
  pkScript: hex.encode(lockupScript().pkScript),
  clientRefundPubkey: hex.encode(SOLVER),
  refundWithoutReceiverDelay: REFUND_WITHOUT_RECEIVER_DELAY,
  refundDelay: REFUND_DELAY,
  receiverPkScript: hex.encode(CLIENT_PAYOUT),
  nonInteractiveParameters: true,
})

const serverUnrollScript = CSVMultisigTapscript.encode({
  timelock: { type: 'seconds', value: 512n },
  pubkeys: [SERVER],
})

const buildFundingTx = (): { id: string; b64: string } => {
  const tx = new Transaction({ allowUnknown: true, allowUnknownInputs: true, allowUnknownOutputs: true })
  tx.addInput({ txid: 'c'.repeat(64), index: 0, witnessUtxo: { script: p2tr(SOLVER), amount: 100_000n } })
  tx.addOutput({ script: lockupScript().pkScript, amount: 50_000n })
  return { id: tx.id, b64: base64.encode(tx.toPSBT()) }
}

const FUNDING = buildFundingTx()
const FUNDED: FundedOutput[] = [{ txid: FUNDING.id, vout: 0, value: 50_000 }]

const arkSubmitTx = vi.fn(async (arkTxB64: string, checkpointsB64: string[]) => ({
  arkTxid: Transaction.fromPSBT(base64.decode(arkTxB64)).id,
  signedCheckpointTxs: checkpointsB64,
}))

const ctx = (): ArkadeContext =>
  ({
    identity: solverIdentity,
    unilateralDelays: {
      unilateralClaimDelay: CLAIM_DELAY,
      unilateralRefundDelay: REFUND_DELAY,
      unilateralRefundWithoutReceiverDelay: REFUND_WITHOUT_RECEIVER_DELAY,
    },
    hrp: 'tark',
    wallet: {
      serverUnrollScript,
      arkServerPublicKey: SERVER,
      getAddress: async () => SOLVER_ADDRESS,
      arkProvider: { submitTx: arkSubmitTx, finalizeTx: vi.fn(async () => undefined) },
      indexerProvider: { getVirtualTxs: vi.fn(async () => ({ txs: [FUNDING.b64] })) },
    } as unknown as ArkadeContext['wallet'],
  }) as ArkadeContext

describe('onchainReceiveArkadeOpsFromContext', () => {
  it('refunds through the refundWithoutReceiver leaf, which needs no client signature', async () => {
    arkSubmitTx.mockClear()
    emulatorSubmitTx.mockClear()
    const ops = await onchainReceiveArkadeOpsFromContext(ctx(), {
      url: 'http://emulator.test',
      pubkey: hex.encode(EMULATOR),
    })

    await ops.refund(row(), FUNDED)

    // The `refund` leaf needs the receiver, who is the client on this leg.
    expect(emulatorSubmitTx).not.toHaveBeenCalled()
    expect(arkSubmitTx).toHaveBeenCalledOnce()
    const [arkTxB64] = arkSubmitTx.mock.calls[0] as [string, string[]]
    const leaf = Transaction.fromPSBT(base64.decode(arkTxB64)).getInput(0).tapLeafScript!
    const committed = hex.encode(leaf[0]![1])
    expect(committed.slice(0, -2)).toBe(lockupScript().refundWithoutReceiverScript)
  })

  it('refuses a row whose rebuilt script is not the lockup that was funded', async () => {
    const ops = await onchainReceiveArkadeOpsFromContext(ctx(), {
      url: 'http://emulator.test',
      pubkey: hex.encode(EMULATOR),
    })

    await expect(ops.refund({ ...row(), pkScript: hex.encode(p2tr(key(21))) }, FUNDED)).rejects.toThrow(/derives/)
  })
})
