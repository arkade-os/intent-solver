/**
 * Boarded sats become float, run by this service — `signerMigration.ts`'s reason
 * exactly. `settlementConfig: false` stops the boarding poll, the ONLY caller of
 * `runPeriodicSettle`, so sats at the address `ops/arkadeFunds.ts` offers
 * confirm on L1 and stay there silently.
 *
 * BOARDING ONLY, never a VTXO: a no-argument `wallet.settle()` prices both
 * correctly and still spends float outside the reservation ledger, onto one
 * coin. Boarding inputs are L1 outputs no lockup funding can select.
 *
 * Pure. `ops/float.ts` owns the call.
 */

import { Estimator, ArkAddress, type IntentFeeConfig } from '@arkade-os/sdk'
import { hex } from '@scure/base'
import { splitRenewalOutputs, MAX_SPLIT_OUTPUTS, type PoolRung } from './vtxoPool.js'

/** The slice of an `ExtendedCoin` this reads. */
export interface BoardingUtxo {
  txid: string
  vout: number
  value: number
  status: { confirmed: boolean }
}

/** Why a pass settled nothing. Ordinary but for `over-capacity`, which no later pass clears. */
export type BoardingSettleSkip =
  'nothing-boarded' | 'nothing-settleable' | 'below-its-own-fee' | 'below-dust' | 'over-capacity'

export type BoardingSettlePlan<U> =
  { settle: false; reason: BoardingSettleSkip } | { settle: true; inputs: U[]; outputs: bigint[] }

export interface BoardingSettleArgs<U extends BoardingUtxo> {
  /** Everything at the boarding address — `IWallet.getBoardingUtxos`. */
  boarding: readonly U[]
  /**
   * `IVtxoManager.getExpiredBoardingUtxos` as `txid:vout`. Past its exit timelock
   * an input cannot be onboarded at all and one fails the whole intent.
   */
  expired: ReadonlySet<string>
  intentFee: IntentFeeConfig
  vtxoMaxAmount: bigint
  dust: bigint
  address: string
  target: readonly PoolRung[]
}

/**
 * What to settle, and what it should come back as. Mirrors the SDK's
 * `runPeriodicSettle` boarding leg — an ONCHAIN input program per input, an
 * offchain output program per piece — since the server evaluates the same ones.
 */
export const planBoardingSettle = <U extends BoardingUtxo>(args: BoardingSettleArgs<U>): BoardingSettlePlan<U> => {
  const { boarding, expired, intentFee, vtxoMaxAmount, dust, address, target } = args
  if (boarding.length === 0) return { settle: false, reason: 'nothing-boarded' }

  const settleable = boarding.filter((utxo) => utxo.status.confirmed && !expired.has(`${utxo.txid}:${utxo.vout}`))
  if (settleable.length === 0) return { settle: false, reason: 'nothing-settleable' }

  const estimator = new Estimator(intentFee)
  const script = hex.encode(ArkAddress.decode(address).pkScript)
  const outputFeeOn = (amount: bigint): bigint => BigInt(estimator.evalOffchainOutput({ amount, script }).satoshis)

  // WHAT ONE SETTLEMENT MAY CARRY, the bound a renewal already applies: the
  // ceiling bounds each OUTPUT, the split emits at most `MAX_SPLIT_OUTPUTS` of
  // them, and `settle` pays the operator everything selected past the product.
  const capacity = vtxoMaxAmount < 0n ? -1n : BigInt(MAX_SPLIT_OUTPUTS) * (vtxoMaxAmount + outputFeeOn(vtxoMaxAmount))

  const inputs: U[] = []
  let gross = 0n
  let overCapacity = 0
  for (const utxo of settleable) {
    const fee = estimator.evalOnchainInput({ amount: BigInt(utxo.value) })
    // Judged on the CEILED figure, which is what the deduction below spends:
    // `value` is a raw float, so guarding on it admits a coin whose fee rounds
    // up to its whole worth and which therefore contributes nothing.
    if (BigInt(fee.satoshis) >= BigInt(utxo.value)) continue
    const net = BigInt(utxo.value) - BigInt(fee.satoshis)
    // An L1 output this cannot divide, so ALONE is final; the deferral below is not.
    if (capacity >= 0n && net > capacity) {
      overCapacity += 1
      continue
    }
    if (capacity >= 0n && gross + net > capacity) continue
    inputs.push(utxo)
    gross += net
  }
  // `gross` never left zero, so every refusal was an input judged alone.
  if (inputs.length === 0) {
    return { settle: false, reason: overCapacity > 0 ? 'over-capacity' : 'below-its-own-fee' }
  }

  // The carve a renewal makes, for its reason: one output funds one swap at a
  // time, and is refused outright once it lands over the operator's ceiling.
  const outputs = splitRenewalOutputs({
    gross,
    target,
    dust,
    outputFeeOn,
    maxOutputs: MAX_SPLIT_OUTPUTS,
    maxAmount: vtxoMaxAmount,
  })
  const first = outputs[0]
  if (first === undefined || first < dust) return { settle: false, reason: 'below-dust' }

  return { settle: true, inputs, outputs }
}
