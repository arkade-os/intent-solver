/** `<STEM>_ENABLED`, strict: a typo'd `FALSE` or `0` meaning "on" leaves a corridor quoting while it reads as dark. */
export const corridorEnabledFrom = (name: string, raw: string | undefined): boolean => {
  const trimmed = raw?.trim()
  if (!trimmed) return true
  if (trimmed !== 'true' && trimmed !== 'false') {
    throw new Error(`${name} must be 'true' or 'false', got ${JSON.stringify(raw)}`)
  }
  return trimmed === 'true'
}
