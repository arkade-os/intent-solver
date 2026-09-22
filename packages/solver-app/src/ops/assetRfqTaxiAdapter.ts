/**
 * The four-method adapter, assembled where the read half already is.
 *
 * The declared return type is the whole {@link ReceiveCarrierQuotes}, so the
 * compiler — not the orchestrator's runtime gate — is what proves this one is
 * complete. The gate still stands behind it for anything else handed in.
 */

import { ArkAddress, type Identity, type IndexerProvider, type IWallet } from '@arkade-os/sdk'
import { TaxiClient } from '@arkade-taxi/client'
import type { ReleaseReservation } from '@arkade-os/solver-arkade/arkade/reservations.js'
import type { AssetRfqSwapRow } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import type { ReceiveCarrierQuotes } from '@arkade-os/solver-corridors/asset/assetRfqOrchestrator.js'
import type { CarrierCoin, CarrierOutpoint, CarrierPinLedger } from './assetRfqTaxi.js'
import { carrierFillSigner, createTaxiReceiveCarrierSettler, type CarrierAttemptStore } from './assetRfqTaxiSettle.js'
import { createTaxiReceiveCarrierObserver, type CarrierProofStore } from './assetRfqTaxiProof.js'
import { createCarrierFillRebuilder } from './assetRfqTaxiRebuild.js'

export interface TaxiCarrierFillComposition {
  taxiUrl: string
  fetch?: typeof fetch
  store: CarrierAttemptStore & CarrierProofStore
  chain: Pick<IndexerProvider, 'getVtxos' | 'getVirtualTxs'>
  pins: CarrierPinLedger
  coins: () => Promise<readonly CarrierCoin[]>
  reserved: () => ReadonlySet<string>
  reserve: (outpoints: readonly CarrierOutpoint[]) => ReleaseReservation
  wallet: IWallet
  identity: Identity
  arkServerUrl: string
  dustSats: bigint
  offerHex: (row: AssetRfqSwapRow) => string
  /** Where a fill pays this solver back — its own address, never the quote's. */
  proceedsAddress: string
  solverKeys: readonly string[]
  now: () => number
}

export const completeTaxiReceiveCarrier = (
  reader: Pick<ReceiveCarrierQuotes, 'resolve' | 'available'>,
  deps: TaxiCarrierFillComposition,
): ReceiveCarrierQuotes => {
  const proceedsScript = ArkAddress.decode(deps.proceedsAddress).pkScript
  return {
    ...reader,
    ...createTaxiReceiveCarrierSettler({
      store: deps.store,
      swapFills: new TaxiClient({ baseUrl: deps.taxiUrl, fetch: deps.fetch }),
      resolve: reader.resolve,
      coins: deps.coins,
      reserved: deps.reserved,
      reserve: deps.reserve,
      pins: deps.pins,
      dustSats: deps.dustSats,
      offerHex: deps.offerHex,
      proceedsScript,
      solverKeys: deps.solverKeys,
      provider: deps.taxiUrl,
      fill: {
        rebuild: createCarrierFillRebuilder({ wallet: deps.wallet, arkServerUrl: deps.arkServerUrl }),
        sign: carrierFillSigner(deps.identity),
      },
      now: deps.now,
    }),
    ...createTaxiReceiveCarrierObserver({ store: deps.store, chain: deps.chain, pins: deps.pins }),
  }
}
