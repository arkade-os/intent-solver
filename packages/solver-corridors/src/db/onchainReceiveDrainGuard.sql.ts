import { placeholders, tableInfo } from './baseSwapStore.sql.js'

// #292 removed the onchain-receive corridor with no boot guard, so an upgrade
// past it silently strands any row still mid-swap in the dead table below.
const TABLE = 'receive_onchain_swap'

export const onchainReceiveDrainGuardSql = {
  tableInfo: tableInfo(TABLE),
  countInStates: (states: number) => `SELECT COUNT(*) AS n FROM ${TABLE} WHERE state IN (${placeholders(states)})`,
} as const
