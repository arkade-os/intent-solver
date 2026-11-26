import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const dockerfile = readFileSync(new URL('../../packages/solver-app/Dockerfile', import.meta.url), 'utf8')

describe('vendored package dependencies in the image', () => {
  it('copies the vendor directory before the frozen install reads its tarballs', () => {
    const copy = dockerfile.indexOf('COPY vendor ./vendor')
    const install = dockerfile.indexOf('RUN pnpm install --frozen-lockfile')

    expect(copy).toBeGreaterThan(-1)
    expect(copy).toBeLessThan(install)
  })
})
