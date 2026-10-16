import { messageOf } from '@arkade-os/solver-core/util/poll.js'

/** Read a value, or report why it could not be read: one dead backend degrades to one row, not a 500. */
export const attempt = async <T>(
  read: () => Promise<T>,
): Promise<{ value: T; error: null } | { value: null; error: string }> => {
  try {
    return { value: await read(), error: null }
  } catch (error) {
    return { value: null, error: messageOf(error) }
  }
}
