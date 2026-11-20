import type { Account } from './account.js'
import type { JournalEntry } from './journal_entry.js'

export interface JournalRepository {
  // False when the key is already booked: appending is idempotent.
  append(entry: JournalEntry): Promise<boolean>
  // Debits minus credits.
  balance(account: Account): Promise<bigint>
}
