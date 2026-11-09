import type { SqlDriver } from '@arkade-os/solver-db/driver.js'
import type { EvmSwapStore } from '@arkade-os/solver-corridors-evm/db/evmSwapStore.js'

/** Rests a row in a state no edge enters (`funded`, `awaiting_lock`, `locked`) but the planners still handle. */
export const seedState = async <S extends string>(
  store: EvmSwapStore<unknown, S>,
  id: string,
  state: S,
  fields: Record<string, string> = {},
): Promise<void> => {
  const { driver, shape } = store as unknown as { driver: SqlDriver; shape: { table: string } }
  const columns = Object.keys(fields)
  await driver.run(
    `UPDATE ${shape.table} SET ${['state', ...columns].map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [state, ...columns.map((c) => fields[c]!), id],
  )
}
