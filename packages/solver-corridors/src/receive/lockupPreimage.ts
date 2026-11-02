import { hex } from '@scure/base'
import { paymentHashFromPreimage } from '@arkade-os/solver-core/core/preimage.js'
import type { OnchainBackend } from '@arkade-os/solver-core/ports/onchain.js'

type Outpoint = { txid: string; vout: number }

/** `P` out of whatever spent a receive lockup: the Arkade claim, then the L1 spend of an outpoint that LEFT
 * Arkade. A throw from either read is "could not find out", so the caller's tick retries. */
export class LockupPreimageReader {
  /** Once per row per process: the read repeats on every tick of the wait. */
  private readonly reported = new Set<string>()

  constructor(
    private readonly arkade: {
      findClaimPreimage(outpoints: readonly Outpoint[], paymentHashHex: string): Promise<Uint8Array | null>
    },
    private readonly onchain: Pick<OnchainBackend, 'findSpendWitness'> | undefined,
    private readonly report: (rowId: string, error: Error) => void,
  ) {}

  async find(
    row: { id: string; pkScript: string; paymentHash: string },
    outpoints: readonly (Outpoint & { unrolled?: boolean })[],
  ): Promise<Uint8Array | null> {
    if (outpoints.length === 0) return null
    const claimed = await this.arkade.findClaimPreimage(outpoints, row.paymentHash)
    if (claimed) return claimed

    const unrolled = outpoints.filter((outpoint) => outpoint.unrolled)
    if (unrolled.length === 0) return null
    if (!this.reported.has(row.id)) {
      this.reported.add(row.id)
      const named = unrolled.map((outpoint) => `${outpoint.txid}:${outpoint.vout}`).join(', ')
      const reading = this.onchain ? 'reading the claim witness onchain' : 'no L1 backend to read its claim from'
      this.report(row.id, new Error(`arkade lockup unrolled onto L1 (${named}) — ${reading}`))
    }
    if (!this.onchain) return null

    const outputScript = hex.decode(row.pkScript)
    let unread: { error: unknown } | undefined
    for (const outpoint of unrolled) {
      try {
        const witness = await this.onchain.findSpendWitness({ txid: outpoint.txid, vout: outpoint.vout, outputScript })
        const revealed = witness?.find(
          (item) => item.length === 32 && paymentHashFromPreimage(item) === row.paymentHash,
        )
        if (revealed) return revealed
      } catch (error) {
        // One unreadable outpoint must not hide `P` in another; unread, though, nothing here is "not found".
        unread ??= { error }
      }
    }
    if (unread) throw unread.error
    return null
  }
}
