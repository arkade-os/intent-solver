/**
 * `<STEM>_ENABLED`, strict. Unset is on, so a deployment that sets nothing serves what
 * it always served. Only the exact `true`/`false`: a typo'd `FALSE`, `0` or `no`
 * silently meaning "on" would leave a corridor quoting that its operator believes is
 * dark — and this knob exists for the case where that corridor loses money per swap.
 */
export const corridorEnabledFrom = (name: string, raw: string | undefined): boolean => {
  const trimmed = raw?.trim()
  if (!trimmed) return true
  if (trimmed !== 'true' && trimmed !== 'false') {
    throw new Error(`${name} must be 'true' or 'false', got ${JSON.stringify(raw)}`)
  }
  return trimmed === 'true'
}
