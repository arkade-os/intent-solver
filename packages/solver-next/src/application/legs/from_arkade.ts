import { UnixSeconds } from '../../domain/shared/time.js'
import type { ClientLockupSeen } from '../../domain/swap/lightning_send.js'
import type { Swap } from '../../domain/swap/swap.js'
import type {
  ClientLockupContract,
  ClientLockupContracts,
  ClientLockupOutput,
  ClientLockups,
  Outpoint,
} from '../../ports/arkade.js'

export interface ClientLockup extends ClientLockupSeen {
  /** The outputs a claim can spend. These are what gets adopted. */
  readonly spendable: readonly ClientLockupOutput[]
}

const total = (outputs: readonly { value: number }[]): number => outputs.reduce((sum, output) => sum + output.value, 0)
const key = (output: Outpoint): string => `${output.txid}:${output.vout}`

// Each adopted output must still be there, with the value it had and nothing but sats in it.
const stillThere = (contract: ClientLockupContract, outputs: readonly ClientLockupOutput[]): boolean => {
  const { adopted, amountSats } = contract
  const held = total(outputs)
  const locked = contract.lockedSats ?? held
  if (locked !== amountSats) return false
  if (adopted === null) return outputs.length > 0 && held >= locked
  const now = new Map(outputs.map((output) => [key(output), output]))
  const unchanged = adopted.every((taken) => {
    const output = now.get(key(taken))
    return output?.value === taken.value && !output.assets?.length
  })
  return unchanged && total(adopted) === locked
}

/** The `from` leg of a send: the client locks the amount on Arkade, and we claim it with the preimage. */
export class FromArkade {
  constructor(
    private readonly contracts: ClientLockupContracts,
    private readonly arkade: ClientLockups,
    private readonly now: () => UnixSeconds,
  ) {}

  async state(swap: Swap): Promise<ClientLockup> {
    const all = await this.arkade.available(await this.contracts.contract(swap.id))
    const spendable = all.filter((output) => !output.assets?.length)
    return { heldSats: total(all), spendableSats: spendable.map((output) => output.value), spendable }
  }

  async refundOpensAt(swap: Swap): Promise<UnixSeconds> {
    const contract = await this.contracts.contract(swap.id)
    return UnixSeconds.of(await this.arkade.refundOpensAt(contract))
  }

  async secondsToRefundAlone(swap: Swap): Promise<number> {
    return this.arkade.secondsToRefundAlone(await this.contracts.contract(swap.id))
  }

  /**
   * The moment a payment against this lockup must be over by: the client's refund, or sooner where the
   * outputs expire with their batch first. It is now when the lockup is no longer what we adopted, so that
   * nothing is paid against it.
   */
  async payDeadline(swap: Swap, refundOpensAt: UnixSeconds): Promise<UnixSeconds> {
    const contract = await this.contracts.contract(swap.id)
    const outputs = await this.arkade.available(contract)
    if (!stillThere(contract, outputs)) return this.now()
    if (this.arkade.claimsOutlastTheBatch(contract)) return refundOpensAt

    // Only the outputs needed to cover the amount count, the longest-lived first.
    const locked = contract.lockedSats ?? total(outputs)
    const longestLivedFirst = [...outputs].sort((a, b) => (b.expiresAt ?? Infinity) - (a.expiresAt ?? Infinity))
    let deadline: number = refundOpensAt
    let covered = 0
    for (const output of longestLivedFirst) {
      if (covered >= locked) break
      covered += output.value
      if (output.expiresAt !== undefined) deadline = Math.min(deadline, output.expiresAt)
    }
    return UnixSeconds.of(deadline)
  }
}
