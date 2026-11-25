/** Every SQL statement the rebalance RFQ record store runs, with its schema. */

export const SCHEMA =
  'CREATE TABLE IF NOT EXISTS rebalance_rfq (rfq_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, fund_amount INTEGER NOT NULL, valid_until INTEGER NOT NULL)'

export const insertRfq = 'INSERT INTO rebalance_rfq (rfq_id, record_json, fund_amount, valid_until) VALUES (?, ?, ?, ?)'

export const rfqById = 'SELECT record_json, fund_amount, valid_until FROM rebalance_rfq WHERE rfq_id = ?'

export const saveRecord = 'UPDATE rebalance_rfq SET record_json = ? WHERE rfq_id = ?'

export const allRecords = 'SELECT record_json FROM rebalance_rfq'

export const deleteRfq = 'DELETE FROM rebalance_rfq WHERE rfq_id = ?'
