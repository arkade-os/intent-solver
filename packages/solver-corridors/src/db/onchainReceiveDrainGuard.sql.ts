import { placeholders, tableInfo } from './baseSwapStore.sql.js'

// The onchain-receive corridor is gone; booting past live rows in its table would strand them.
const TABLE = 'receive_onchain_swap'

export const onchainReceiveDrainGuardSql = {
  tableInfo: tableInfo(TABLE),
  countInStates: (states: number) => `SELECT COUNT(*) AS n FROM ${TABLE} WHERE state IN (${placeholders(states)})`,
} as const
