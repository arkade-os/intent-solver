/**
 * In-memory `OnchainSendBackend`/`OnchainReceiveBackend` for regtest
 * orchestrator-level tests — no real chain interaction, mirrors the role
 * `src/ln/fake/backend.ts` plays for Lightning. Real end-to-end proof of the
 * onchain HTLC script + broadcast + confirmation watching uses the LND
 * adapter against a regtest LND node (Task 5), the same way the send leg's
 * real E2E proof already runs today.
 */

import { randomBytes } from 'node:crypto'
import { hex } from '@scure/base'
import { Address, Transaction } from '@scure/btc-signer'
import { ONCHAIN_NETWORKS, type OnchainNetworkProfile } from '@arkade-os/solver-rails/onchain/htlc.js'
import type {
  FundedOnchainOutput,
  OnchainBalance,
  OnchainReceiveBackend,
  OnchainSendBackend,
  OnchainTxOutcome,
} from '@arkade-os/solver-core/ports/onchain.js'

/** A realistic-length fake txid — 32 bytes, like a real one, not `randomUUID`'s 16. */
const fakeTxid = (): string => hex.encode(randomBytes(32))

interface Output {
  txid: string
  vout: number
  address: string
  valueSats: number
  minedAtBlock: number | null
  spentByWitness: Uint8Array[] | null
}

export class FakeOnchainBackend implements OnchainSendBackend, OnchainReceiveBackend {
  private readonly outputs: Output[] = []
  private readonly broadcasts = new Map<string, number | null>()
  private currentBlock = 0
  private readonly feeRateSatsPerVbyte: number
  private readonly fundingVout: number
  private readonly receiveAddress: string

  // fundingVout defaults to 0, but is configurable: a fake that always
  // returns 0 can't tell apart a caller correctly threading fund()'s real
  // vout from one that's quietly hardcoded it back to 0 — exactly the bug
  // class this PR fixes. Tests proving that threading works should
  // construct with a non-zero value instead.
  //
  // `network` only shapes newReceiveAddress()'s HRP, but it has to be right:
  // the CLI decodes that address against the CONFIGURED network, and a
  // regtest address handed to a mainnet deployment would throw at startup.
  constructor(feeRateSatsPerVbyte = 5, fundingVout = 0, network: OnchainNetworkProfile = ONCHAIN_NETWORKS.regtest) {
    this.feeRateSatsPerVbyte = feeRateSatsPerVbyte
    this.fundingVout = fundingVout
    // A fixed P2WPKH rather than a random one: deterministic, so a test can
    // assert the exact address a refund is expected to pay.
    this.receiveAddress = Address(network).encode({ type: 'wpkh', hash: new Uint8Array(20).fill(0x11) })
  }

  /** `idempotencyKey` is unused: nothing here can be paid twice, there being no chain. */
  async fund(params: {
    address: string
    amountSats: number
    idempotencyKey: string
  }): Promise<{ txid: string; vout: number }> {
    const txid = fakeTxid()
    this.outputs.push({
      txid,
      vout: this.fundingVout,
      address: params.address,
      valueSats: params.amountSats,
      minedAtBlock: null,
      spentByWitness: null,
    })
    return { txid, vout: this.fundingVout }
  }

  /**
   * The ONE place a stored output becomes the port's shape. Shared by
   * {@link findOutputs} and {@link unspentOutputs} so the confirmation count a
   * balance is bucketed by and the one a funding check reads can never drift
   * apart — there is a single store and a single way to read it.
   */
  private toFundedOutput(output: Output): FundedOnchainOutput {
    return {
      txid: output.txid,
      vout: output.vout,
      valueSats: output.valueSats,
      confirmations: output.minedAtBlock === null ? 0 : this.currentBlock - output.minedAtBlock + 1,
    }
  }

  async findOutputs(params: { address: string }): Promise<FundedOnchainOutput[]> {
    return this.outputs.filter((o) => o.address === params.address).map((o) => this.toFundedOutput(o))
  }

  async findSpendWitness(params: {
    txid: string
    vout: number
    outputScript: Uint8Array
  }): Promise<Uint8Array[] | null> {
    const output = this.outputs.find((o) => o.txid === params.txid && o.vout === params.vout)
    return output?.spentByWitness ?? null
  }

  /** The REAL txid: callers pre-commit their own, so a random one reads `unknown` forever. */
  async broadcastRaw(txHex: string): Promise<{ txid: string }> {
    const txid = Transaction.fromRaw(hex.decode(txHex), {
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
      allowLegacyWitnessUtxo: true,
    }).id
    this.broadcasts.set(txid, null)
    return { txid }
  }

  async transactionOutcome(txid: string): Promise<OnchainTxOutcome> {
    if (!this.broadcasts.has(txid)) return 'unknown'
    return this.broadcasts.get(txid) === null ? 'mempool' : 'confirmed'
  }

  async estimateFeeRate(): Promise<number> {
    return this.feeRateSatsPerVbyte
  }

  /**
   * Everything in the store that no witness has spent yet — the SAME rows
   * {@link findOutputs} reads, only filtered by spend rather than by address.
   * Deliberately not a second tally kept alongside `outputs`: a balance and a
   * funding check that disagree about what exists is the exact bug a fake is
   * supposed to make impossible.
   */
  private unspentOutputs(): FundedOnchainOutput[] {
    return this.outputs.filter((o) => o.spentByWitness === null).map((o) => this.toFundedOutput(o))
  }

  async getBalance(): Promise<OnchainBalance> {
    let confirmedSats = 0
    let unconfirmedSats = 0
    for (const output of this.unspentOutputs()) {
      if (output.confirmations > 0) confirmedSats += output.valueSats
      else unconfirmedSats += output.valueSats
    }
    return { confirmedSats, unconfirmedSats }
  }

  async newReceiveAddress(): Promise<string> {
    return this.receiveAddress
  }

  // -- test control surface, not part of OnchainSendBackend/OnchainReceiveBackend --

  /**
   * Simulate a THIRD PARTY (the client, on the receive leg) paying `address`
   * out of band — distinct from {@link fund}, which is this backend's own
   * wallet paying out. The receive leg never calls `fund()` at all (the
   * client funds their own onchain HTLC directly, outside this service), so
   * receive-side tests need a way to seed that deposit without going through
   * a send-only method.
   */
  receiveExternal(params: { address: string; amountSats: number; vout?: number }): { txid: string; vout: number } {
    const txid = fakeTxid()
    const vout = params.vout ?? 0
    this.outputs.push({
      txid,
      vout,
      address: params.address,
      valueSats: params.amountSats,
      minedAtBlock: null,
      spentByWitness: null,
    })
    return { txid, vout }
  }

  /** Advance the fake chain tip so previously-funded outputs gain confirmations. */
  mineBlocks(n: number): void {
    // Before any state moves: `mineBlocks(0)` leaves the tip alone yet would still
    // confirm the whole mempool, so a test that mined nothing reads like one that did.
    if (!Number.isInteger(n) || n < 1) throw new Error(`mineBlocks needs a whole number of blocks, got ${n}`)
    for (const output of this.outputs) {
      if (output.minedAtBlock === null) output.minedAtBlock = this.currentBlock + 1
    }
    for (const [txid, minedAt] of this.broadcasts) {
      if (minedAt === null) this.broadcasts.set(txid, this.currentBlock + 1)
    }
    this.currentBlock += n
  }

  dropFromMempool(txid: string): void {
    if (!this.broadcasts.delete(txid)) throw new Error(`no broadcast ${txid} to drop`)
  }

  /** Record a claim/refund spend of `(txid, vout)`, with the given witness stack. */
  spendClaim(txid: string, vout: number, witness: Uint8Array[]): void {
    const output = this.outputs.find((o) => o.txid === txid && o.vout === vout)
    if (!output) throw new Error(`no such output ${txid}:${vout}`)
    output.spentByWitness = witness
  }
}
