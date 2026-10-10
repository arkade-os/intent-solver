import { ArkAddress, type Identity, type IndexerProvider, type IWallet, type Wallet } from '@arkade-os/sdk'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import { messageOf } from '@arkade-os/solver-core/util/poll.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { ReceiveCarrierQuotes } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import {
  taxiClientCache,
  type CarrierCoin,
  type CarrierOutpoint,
  type CarrierPinLedger,
  type TaxiReceiveCarrierReader,
} from './assetRfqTaxi.js'
import {
  carrierFillSigner,
  createTaxiReceiveCarrierSettler,
  type CarrierAttemptStore,
  type CarrierTaxi,
} from './assetRfqTaxiSettle.js'
import { createTaxiReceiveCarrierObserver, type CarrierProofStore } from './assetRfqTaxiProof.js'
import { createCarrierConflictCanceller, type CarrierConflictStore } from './assetRfqTaxiCancel.js'
import { createCarrierFillRebuilder } from './assetRfqTaxiRebuild.js'
import { normalizeTaxiUrl, type TaxiUrlPolicy } from './taxiUrlGuard.js'

export interface TaxiCarrierFillComposition {
  /** Only a row naming no Taxi of its own needs it. */
  taxiUrl?: string
  policy: TaxiUrlPolicy
  store: CarrierAttemptStore & CarrierProofStore & CarrierConflictStore
  chain: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>
  pins: CarrierPinLedger
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  /** The two `Wallet` members are the conflict spend's, read only once one is due. */
  wallet: IWallet & Pick<Wallet, 'arkProvider' | 'serverUnrollScript'>
  identity: Identity
  arkServerUrl: string
  dustSats: bigint
  offerHex: (row: AssetRfqSwapRow) => string
  /** Where a fill pays this solver back — its own address, never the quote's. */
  proceedsAddress: string
  solverKeys: readonly string[]
  serverKey: () => Uint8Array
  now: () => number
}

/** Keyed on the row's MODE, never on URL equality: a named Taxi spelling `TAXI_URL` is still a payer's input. */
export const carrierTaxiFor = (
  deps: Pick<TaxiCarrierFillComposition, 'taxiUrl' | 'policy'>,
): ((row: AssetRfqSwapRow) => CarrierTaxi) => {
  const configured = deps.taxiUrl?.trim() || undefined
  const clientFor = taxiClientCache({ configuredUrl: configured, policy: deps.policy })
  return (row) => {
    const terms = row.carrierTerms
    if (terms?.mode === 'recycle_receiver') {
      let provider: string
      try {
        provider = normalizeTaxiUrl(terms.taxiUrl ?? '', deps.policy)
      } catch (cause) {
        throw new Error(
          `carrier fill ${row.id} names Taxi ${String(terms.taxiUrl)}, which this solver's URL policy refuses: ${messageOf(cause)}`,
          { cause },
        )
      }
      return { provider, providerKey: terms.taxiKey, fills: clientFor(provider, 'fill') }
    }
    // Throws first when no Taxi is configured, so `configured` is set below.
    const fills = clientFor(undefined)
    return { provider: configured!, fills }
  }
}

export const completeTaxiReceiveCarrier = (
  reader: TaxiReceiveCarrierReader,
  deps: TaxiCarrierFillComposition,
): ReceiveCarrierQuotes => {
  const proceedsScript = ArkAddress.decode(deps.proceedsAddress).pkScript
  return {
    ...reader,
    ...createTaxiReceiveCarrierSettler({
      store: deps.store,
      taxiFor: carrierTaxiFor(deps),
      resolve: reader.resolve,
      receiveQuote: reader.verified,
      coins: deps.coins,
      reserved: deps.reserved,
      reserve: deps.reserve,
      pins: deps.pins,
      dustSats: deps.dustSats,
      offerHex: deps.offerHex,
      proceedsScript,
      solverKeys: deps.solverKeys,
      serverKey: deps.serverKey,
      fill: {
        rebuild: createCarrierFillRebuilder({ wallet: deps.wallet, arkServerUrl: deps.arkServerUrl }),
        sign: carrierFillSigner(deps.identity),
      },
      now: deps.now,
    }),
    ...createTaxiReceiveCarrierObserver({
      store: deps.store,
      chain: deps.chain,
      pins: deps.pins,
      cancel: createCarrierConflictCanceller({
        store: deps.store,
        chain: deps.chain,
        pins: deps.pins,
        ark: () => deps.wallet.arkProvider,
        serverUnrollScript: () => deps.wallet.serverUnrollScript,
        signer: deps.identity,
        coins: deps.coins,
        solverKeys: deps.solverKeys,
        serverKey: deps.serverKey,
        now: deps.now,
      }),
    }),
  }
}
