/** Every SQL statement the durable EVM sender runs, with its schema. */

export const createJournalTable = `CREATE TABLE IF NOT EXISTS evm_transaction_journal (
    id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, account TEXT NOT NULL, nonce TEXT NOT NULL,
    request TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
    UNIQUE(chain_id, account, nonce), UNIQUE(hash)
  )`

export const createAttemptsTable = `CREATE TABLE IF NOT EXISTS evm_transaction_attempts (
    id TEXT NOT NULL, sequence INTEGER NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    max_fee TEXT NOT NULL, tip TEXT NOT NULL, ceiling TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(id, sequence)
  )`

export const allJournalRows = 'SELECT * FROM evm_transaction_journal'

export const copyJournalRowToAttempts =
  'INSERT OR IGNORE INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, 0, ?, ?, ?, ?, ?, ?)'

export const attemptsById = 'SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence'

export const latestAttempt = 'SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence DESC LIMIT 1'

export const setJournalRawAndHash = 'UPDATE evm_transaction_journal SET raw = ?, hash = ? WHERE id = ?'

export const setAttemptState = 'UPDATE evm_transaction_attempts SET state = ? WHERE id = ? AND sequence = ?'

export const journalById = 'SELECT * FROM evm_transaction_journal WHERE id = ?'

export const highestNonce =
  'SELECT nonce FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce DESC LIMIT 1'

export const insertJournal =
  'INSERT INTO evm_transaction_journal (id, chain_id, account, nonce, request, raw, hash, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

export const insertAttempt =
  'INSERT INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

export const markAttemptSubmitting =
  "UPDATE evm_transaction_attempts SET state = 'submitting' WHERE id = ? AND sequence = ?"

export const markAttemptSubmitted =
  "UPDATE evm_transaction_attempts SET state = 'submitted' WHERE id = ? AND sequence = ?"

export const markJournalSubmitted = "UPDATE evm_transaction_journal SET state = 'submitted' WHERE id = ?"

export const markAttemptUnknown = "UPDATE evm_transaction_attempts SET state = 'unknown' WHERE id = ? AND sequence = ?"

export const markJournalUnknown = "UPDATE evm_transaction_journal SET state = 'unknown' WHERE id = ?"

export const markJournalPrepared =
  "UPDATE evm_transaction_journal SET raw = ?, hash = ?, state = 'prepared' WHERE id = ?"

export const journalForAccount =
  'SELECT * FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce'

export const attemptByHash = 'SELECT * FROM evm_transaction_attempts WHERE hash = ?'
