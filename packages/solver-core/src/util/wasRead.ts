/** A value the planner must have read before the action that needs it. Missing means a planner bug, so it throws. */
export const wasRead = <T>(value: T | null, read: string): T => {
  if (value === null) throw new Error(`${read} was not read before the action that needs it`)
  return value
}
