/** Every statement the durable EVM sender's journal runs. */
export const evmTransactionJournalSql = {
  createJournalTable: `CREATE TABLE IF NOT EXISTS evm_transaction_journal (
    id TEXT PRIMARY KEY, chain_id TEXT NOT NULL, account TEXT NOT NULL, nonce TEXT NOT NULL,
    request TEXT NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
    UNIQUE(chain_id, account, nonce), UNIQUE(hash)
  )`,
  createAttemptsTable: `CREATE TABLE IF NOT EXISTS evm_transaction_attempts (
    id TEXT NOT NULL, sequence INTEGER NOT NULL, raw TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    max_fee TEXT NOT NULL, tip TEXT NOT NULL, ceiling TEXT NOT NULL, state TEXT NOT NULL,
    PRIMARY KEY(id, sequence)
  )`,
  selectAllJournal: 'SELECT * FROM evm_transaction_journal',
  backfillFirstAttempt:
    'INSERT OR IGNORE INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, 0, ?, ?, ?, ?, ?, ?)',
  selectAttempts: 'SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence',
  selectLatestAttempt: 'SELECT * FROM evm_transaction_attempts WHERE id = ? ORDER BY sequence DESC LIMIT 1',
  updateJournalTransaction: 'UPDATE evm_transaction_journal SET raw = ?, hash = ? WHERE id = ?',
  updateAttemptState: 'UPDATE evm_transaction_attempts SET state = ? WHERE id = ? AND sequence = ?',
  selectJournalById: 'SELECT * FROM evm_transaction_journal WHERE id = ?',
  selectHighestNonce:
    'SELECT nonce FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce DESC LIMIT 1',
  insertJournal:
    'INSERT INTO evm_transaction_journal (id, chain_id, account, nonce, request, raw, hash, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  insertAttempt:
    'INSERT INTO evm_transaction_attempts (id, sequence, raw, hash, max_fee, tip, ceiling, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  markAttempt: {
    submitting: "UPDATE evm_transaction_attempts SET state = 'submitting' WHERE id = ? AND sequence = ?",
    submitted: "UPDATE evm_transaction_attempts SET state = 'submitted' WHERE id = ? AND sequence = ?",
    unknown: "UPDATE evm_transaction_attempts SET state = 'unknown' WHERE id = ? AND sequence = ?",
  },
  markJournal: {
    submitted: "UPDATE evm_transaction_journal SET state = 'submitted' WHERE id = ?",
    unknown: "UPDATE evm_transaction_journal SET state = 'unknown' WHERE id = ?",
  },
  replaceJournalTransaction: "UPDATE evm_transaction_journal SET raw = ?, hash = ?, state = 'prepared' WHERE id = ?",
  selectJournalForAccount: 'SELECT * FROM evm_transaction_journal WHERE chain_id = ? AND account = ? ORDER BY nonce',
  selectAttemptByHash: 'SELECT * FROM evm_transaction_attempts WHERE hash = ?',
} as const
