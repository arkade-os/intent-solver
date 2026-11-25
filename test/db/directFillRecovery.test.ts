import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { OfferFillStore } from '@arkade-os/solver-corridors/db/offerFills.js'
import { AssetRfqSwapStore } from '@arkade-os/solver-corridors/db/assetRfqSwaps.js'
import { betterSqliteDriver, type SqlDriver } from '@arkade-os/solver-corridors/db/driver.js'
import { OFFER_CONTRACT_V1 } from '@arkade-os/solver-core/core/offerContract.js'

const deposit = 'aa'.repeat(32)
const original = 'bb'.repeat(32)
const conflict = 'cc'.repeat(32)
const script = `5120${'dd'.repeat(32)}`
const proof = { id: 'parent', depositTxid: deposit, depositVout: 0, offerPkScript: script }
const intent = (id: string) => ({
  id,
  offerTxid: deposit,
  offerVout: 0,
  offerPkScript: script,
  contractVersion: OFFER_CONTRACT_V1,
  wantAssetId: null,
  wantAmount: 10n,
  offerAssetId: null,
  offerAmount: 20n,
})
const quote = (id: string, rfqId: string) => ({
  id,
  rfqId,
  pair: 'arkade:BTC->arkade:BTC',
  fromAssetId: null,
  fromAmount: 20n,
  toAssetId: null,
  toAmount: 10n,
  makerPkScript: script,
  makerPublicKey: 'ee'.repeat(32),
  offerPkScript: script,
  offerAddress: 'ark1qoffer',
  solverPubkey: 'ff'.repeat(32),
  validUntil: 2000,
})

for (const kind of ['public', 'rfq'] as const) {
  describe(`${kind} direct fill recovery`, () => {
    async function fixture(run: (store: OfferFillStore | AssetRfqSwapStore, driver: SqlDriver) => Promise<void>) {
      const directory = mkdtempSync(join(tmpdir(), 'solver-direct-fill-db-'))
      const path = join(directory, 'parents.sqlite')
      const driver = betterSqliteDriver(path)
      const store = kind === 'public' ? await OfferFillStore.open(driver) : await AssetRfqSwapStore.open(driver)
      try {
        if (store instanceof OfferFillStore) {
          await store.insertIntent(intent(proof.id))
          await store.transition(proof.id, 'fillable', 'filling')
        } else {
          await store.insertQuote(quote(proof.id, 'ee'.repeat(32)))
          await store.transition(proof.id, 'quoted', 'funded', { deposit_txid: deposit, deposit_vout: 0 })
          await store.transition(proof.id, 'funded', 'filling')
        }
        await run(store, driver)
      } finally {
        await store.close()
        if (
          dirname(resolve(directory)) !== resolve(tmpdir()) ||
          !basename(directory).startsWith('solver-direct-fill-db-')
        )
          throw new Error('unexpected temporary directory')
        rmSync(directory, { recursive: true })
      }
    }
    const events = (driver: SqlDriver) =>
      driver.all(`SELECT * FROM ${kind === 'public' ? 'offer_fill_event' : 'asset_rfq_swap_event'}`)
    for (const state of ['filling', 'stuck'] as const) {
      it(`recovers the original from ${state} exactly once`, () =>
        fixture(async (store, driver) => {
          if (state === 'stuck') await store.fail(proof.id, 'filling', 'lost reply')
          const before = (await events(driver)).length
          store.onTransition = vi.fn()
          expect(await store.recoverDirectFill(proof, original)).toBe(true)
          expect(await store.recoverDirectFill(proof, original)).toBe(true)
          expect(await store.recoverDirectFill(proof, conflict)).toBe(false)
          expect(await store.cancelDirectFill(proof, conflict)).toBe(false)
          expect(await store.findById(proof.id)).toMatchObject({
            state: 'filled',
            fillTxid: original,
            failureReason: null,
          })
          expect((await events(driver)).length).toBe(before + 1)
          expect(store.onTransition).toHaveBeenCalledExactlyOnceWith({ id: proof.id, from: state, to: 'filled' })
        }))
      it(`records a scoped conflict from ${state} exactly once`, () =>
        fixture(async (store, driver) => {
          if (state === 'stuck') await store.fail(proof.id, 'filling', 'lost reply')
          const before = (await events(driver)).length
          store.onTransition = vi.fn()
          expect(await store.cancelDirectFill(proof, conflict)).toBe(true)
          expect(await store.cancelDirectFill(proof, conflict)).toBe(true)
          expect(await store.cancelDirectFill(proof, original)).toBe(false)
          expect(await store.recoverDirectFill(proof, original)).toBe(false)
          const to = kind === 'public' ? 'stuck' : 'refused'
          expect(await store.findById(proof.id)).toMatchObject({
            state: to,
            fillTxid: null,
            failureReason: `direct fill cancelled by confirmed conflict ${conflict}`,
          })
          expect((await events(driver)).length).toBe(before + 1)
          expect(vi.mocked(store.onTransition!).mock.calls).toEqual(
            state === to ? [] : [[{ id: proof.id, from: state, to }]],
          )
        }))
    }
    it('records a proven fill on the stuck row, never retaking a key a later row now holds', () =>
      fixture(async (store, driver) => {
        await store.fail(proof.id, 'filling', 'lost reply')
        if (store instanceof OfferFillStore) await store.insertIntent(intent('later'))
        else await store.insertQuote(quote('later', 'dd'.repeat(32)))
        const before = (await events(driver)).length
        expect(await store.recoverDirectFill(proof, original)).toBe(true)
        expect(await store.recoverDirectFill(proof, original)).toBe(true)
        expect(await store.cancelDirectFill(proof, conflict)).toBe(false)
        expect(await store.findById(proof.id)).toMatchObject({
          state: 'stuck',
          fillTxid: original,
          failureReason: `direct fill recovered as ${original} after later took its ${kind === 'public' ? 'outpoint' : 'offer script'}`,
        })
        expect((await store.findById('later'))?.state).toBe(kind === 'public' ? 'fillable' : 'quoted')
        expect((await events(driver)).length).toBe(before + 1)
      }))
    for (const mismatch of [{ id: 'other' }, { depositTxid: conflict }, { depositVout: 1 }, { offerPkScript: '00' }]) {
      it(`rejects identity mismatch ${Object.keys(mismatch)[0]}`, () =>
        fixture(async (store, driver) => {
          const before = await events(driver)
          expect(await store.recoverDirectFill({ ...proof, ...mismatch }, original)).toBe(false)
          expect(await store.cancelDirectFill({ ...proof, ...mismatch }, conflict)).toBe(false)
          expect(await events(driver)).toEqual(before)
          expect((await store.findById(proof.id))?.state).toBe('filling')
        }))
    }
    for (const state of kind === 'public' ? ['fillable', 'lost', 'refused'] : ['quoted', 'funded', 'refused']) {
      it(`rejects parent state ${state}`, () =>
        fixture(async (store, driver) => {
          await driver.run(`UPDATE ${kind === 'public' ? 'offer_fill' : 'asset_rfq_swap'} SET state = ? WHERE id = ?`, [
            state,
            proof.id,
          ])
          expect(await store.recoverDirectFill(proof, original)).toBe(false)
          expect(await store.cancelDirectFill(proof, conflict)).toBe(false)
        }))
    }
    it('keeps generic stuck lifecycle edges closed', () =>
      fixture(async (store) => {
        await store.fail(proof.id, 'filling', 'lost reply')
        await expect(store.transition(proof.id, 'stuck', 'filled')).rejects.toThrow('illegal transition')
        await expect(store.transition(proof.id, 'stuck', 'refused')).rejects.toThrow('illegal transition')
      }))
    it('preserves recovery and idempotence after reopening SQLite', () =>
      fixture(async (store, driver) => {
        expect(await store.recoverDirectFill(proof, original)).toBe(true)
        const database = await driver.get<{ file: string }>('PRAGMA database_list')
        await store.close()
        const again = betterSqliteDriver(database!.file)
        const reopened = kind === 'public' ? await OfferFillStore.open(again) : await AssetRfqSwapStore.open(again)
        try {
          const before = await events(again)
          expect(await reopened.recoverDirectFill(proof, original)).toBe(true)
          expect(await reopened.findById(proof.id)).toMatchObject({ state: 'filled', fillTxid: original })
          expect(await events(again)).toEqual(before)
        } finally {
          await reopened.close()
        }
      }))
    if (kind === 'rfq') {
      for (const mode of ['recycle', 'recycle_receiver'] as const) {
        it(`excludes ${mode} carrier rows`, () =>
          fixture(async (store, driver) => {
            const terms =
              mode === 'recycle'
                ? {
                    mode,
                    quote_id: 'q',
                    physical_sats: '330',
                    loan_sats: '329',
                    receipt_sats: '1',
                    service_fare_sats: '0',
                    priced_sats: '1',
                    expires_at: 5000,
                  }
                : {
                    mode,
                    quote_id: 'q',
                    physical_sats: '330',
                    loan_sats: '330',
                    receipt_sats: '0',
                    service_fare_sats: '0',
                    priced_sats: '0',
                    expires_at: 5000,
                    taxi_url: 'http://localhost:3000',
                    taxi_key: '11'.repeat(32),
                  }
            await driver.run('UPDATE asset_rfq_swap SET carrier_terms = ? WHERE id = ?', [
              JSON.stringify(terms),
              proof.id,
            ])
            expect(await store.recoverDirectFill(proof, original)).toBe(false)
            expect(await store.cancelDirectFill(proof, conflict)).toBe(false)
          }))
      }
      it('excludes any existing carrier journal', () =>
        fixture(async (store, driver) => {
          await driver.run('UPDATE asset_rfq_swap SET carrier_attempt = ? WHERE id = ?', ['{}', proof.id])
          expect(await store.recoverDirectFill(proof, original)).toBe(false)
          expect(await store.cancelDirectFill(proof, conflict)).toBe(false)
        }))
    }
    it('does not overwrite a known different fill', () =>
      fixture(async (store, driver) => {
        await driver.run(
          `UPDATE ${kind === 'public' ? 'offer_fill' : 'asset_rfq_swap'} SET fill_txid = ? WHERE id = ?`,
          [conflict, proof.id],
        )
        expect(await store.recoverDirectFill(proof, original)).toBe(false)
        expect(await store.cancelDirectFill(proof, original)).toBe(false)
      }))
    it('rejects malformed transaction identities', () =>
      fixture(async (store) => {
        expect(await store.recoverDirectFill(proof, 'bad')).toBe(false)
        expect(await store.cancelDirectFill(proof, 'bad')).toBe(false)
      }))
    it('rolls back parent change when its audit insert fails', () =>
      fixture(async (store, driver) => {
        const run = driver.run.bind(driver)
        const spy = vi
          .spyOn(driver, 'run')
          .mockImplementation((sql, params) =>
            sql.startsWith('INSERT INTO') ? Promise.reject(new Error('audit failed')) : run(sql, params),
          )
        await expect(store.recoverDirectFill(proof, original)).rejects.toThrow('audit failed')
        spy.mockRestore()
        expect(await store.findById(proof.id)).toMatchObject({ state: 'filling', fillTxid: null })
      }))
    it('does not audit a lost compare-and-swap', () =>
      fixture(async (store, driver) => {
        const before = await events(driver)
        const run = driver.run.bind(driver)
        const spy = vi
          .spyOn(driver, 'run')
          .mockImplementation((sql, params) =>
            sql.startsWith('UPDATE') ? Promise.resolve({ changes: 0 }) : run(sql, params),
          )
        expect(await store.recoverDirectFill(proof, original)).toBe(false)
        spy.mockRestore()
        expect(await events(driver)).toEqual(before)
      }))
  })
}
