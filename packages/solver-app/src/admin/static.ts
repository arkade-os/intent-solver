/**
 * Serving the console's own files.
 *
 * `pnpm build` is plain `tsc`, which does not copy non-TS files, so the assets
 * are read from disk at runtime rather than bundled. The directory is resolved
 * from `import.meta.url` so the same code works from `src/` under vitest and
 * from `dist/` in the container, where the Dockerfile copies the directory
 * alongside the compiled output.
 *
 * The only security-relevant line here is the traversal check. This port has
 * no authentication by deployment decision, so a path-traversal bug would hand
 * anything that can reach it the contents of the filesystem — including the
 * `.env` file holding the mnemonic. The check is therefore a resolved-path
 * containment test, not a string filter: `..` blocklists miss encodings, and
 * this must not depend on catching every spelling.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, normalize, resolve, sep, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the client lives on disk.
 *
 * Two candidates, because `tsc` does not copy non-TS files and `pnpm build` is
 * required to stay exactly `tsc`:
 *
 * 1. beside this module — true under vitest (`src/admin/static/`) and in the
 *    container, where the Dockerfile copies the directory into `dist/admin/`;
 * 2. this package's source tree, reached from `dist/admin/` — the case that
 *    made this a list rather than one path. Running the COMPILED cli locally
 *    (`pnpm start`, `node packages/solver-app/dist/cli.js serve`) resolves (1)
 *    to a directory tsc never created, so the console would 404 everything
 *    while working perfectly in Docker. Both hops stayed two levels deep when
 *    this tree became a package, so neither path changed.
 */
export const staticRoot = (): string => {
  const beside = resolve(fileURLToPath(new URL('./static', import.meta.url)))
  if (existsSync(beside)) return beside
  const fromSource = resolve(fileURLToPath(new URL('../../src/admin/static', import.meta.url)))
  return existsSync(fromSource) ? fromSource : beside
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export const contentTypeFor = (path: string): string => TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'

/**
 * Resolve a URL path inside `root`, or null if it escapes.
 *
 * Containment is checked on the RESOLVED absolute path, after normalisation,
 * so `%2e%2e`, `....//`, backslashes on Windows and symlink-free `..` chains
 * all fail the same way — by landing outside `root` — rather than each needing
 * its own pattern.
 */
export const resolveWithin = (root: string, urlPath: string): string | null => {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    // A malformed escape is not a path this server has any business guessing at.
    return null
  }
  // A NUL byte can truncate a path in a lower layer; nothing legitimate has one.
  if (decoded.includes('\0')) return null

  // REFUSE a traversal rather than neutralise it. `normalize()` would collapse
  // `/../../x` against the leading slash and quietly hand back `<root>/x`,
  // which is safe but is not what this function says it does — and "safe
  // because of the order two lines happen in" is exactly the property that
  // breaks when someone reorders them. Checking segments AFTER decoding is
  // sound where a raw-string blocklist would not be: `%2e%2e` is already `..`
  // by this point.
  const segments = decoded.split(/[/\\]+/)
  if (segments.some((segment) => segment === '..')) return null

  const relative = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolve(join(root, relative))
  // Belt and braces: even with the segment check above, containment is the
  // property that actually matters, so it is asserted on the resolved path.
  const prefix = root.endsWith(sep) ? root : root + sep
  if (candidate !== root && !candidate.startsWith(prefix)) return null
  return candidate
}

export interface StaticFile {
  body: Buffer
  contentType: string
}

/**
 * Read one asset, or null when it is missing or out of bounds.
 *
 * `/` and any path without an extension fall back to `index.html`, so the
 * client can own its routing without the server learning its view names.
 */
export const readStaticFile = async (urlPath: string, root = staticRoot()): Promise<StaticFile | null> => {
  const wanted = urlPath === '/' || extname(urlPath) === '' ? '/index.html' : urlPath
  const path = resolveWithin(root, wanted)
  if (!path) return null
  try {
    return { body: await readFile(path), contentType: contentTypeFor(path) }
  } catch {
    return null
  }
}
