import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The Dockerfile says "a Dockerfile cannot import a constant, so the two move
 * together by hand or not at all". This is the "or not at all" guard: a text
 * test, because what rots is the contract between the shell, the ENV block and
 * `cli.ts`, and every way it rots is a rename that still parses.
 */
const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const dockerfile = read('packages/solver-app/Dockerfile')
const cli = read('packages/solver-app/src/cli.ts')
const compose = read('docker-compose.yml')

/** One Dockerfile instruction, backslash continuations and all. */
const instruction = (source: string, keyword: string): string => {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith(keyword))
  if (start === -1) return ''
  const out: string[] = []
  for (let at = start; at < lines.length; at++) {
    out.push(lines[at]!)
    if (!lines[at]!.trimEnd().endsWith('\\')) break
  }
  return out.join('\n')
}

const healthcheck = instruction(dockerfile, 'HEALTHCHECK')

describe('the image healthcheck', () => {
  it('exists at all', () => {
    expect(healthcheck).toMatch(/^HEALTHCHECK/)
  })

  it('reads the path the ENV block sets, so the two cannot drift apart', () => {
    const declared = /RELAY_HEALTH_PATH=(\S+)/.exec(dockerfile)?.[1]
    expect(declared).toBe('/data/relay-health')
    expect(healthcheck).toContain(`RELAY_HEALTH_PATH:-${declared}`)
  })

  it('reads the path `relay` actually writes', () => {
    expect(cli).toContain('utimesSync(config.relayHealthPath')
    expect(read('packages/solver-app/src/config.ts')).toContain('process.env.RELAY_HEALTH_PATH')
  })

  // A heartbeat slowed without widening the bound goes unhealthy at random.
  it('allows several missed beats before it calls the solver dead', () => {
    const beatMs = Number(/RELAY_HEARTBEAT_MS = ([\d_]+)/.exec(cli)?.[1]?.replace(/_/g, ''))
    const staleSeconds = Number(/-lt (\d+)/.exec(healthcheck)?.[1])
    expect(beatMs).toBeGreaterThan(0)
    expect(staleSeconds).toBeGreaterThan(0)
    expect(staleSeconds * 1000).toBeGreaterThanOrEqual(beatMs * 3)
  })

  // Verified on the real images: curl and wget are absent from node:22-slim AND
  // node:24-slim, and a probe naming one is unhealthy forever with no error.
  it('shells out to nothing the slim base image lacks', () => {
    expect(healthcheck).not.toMatch(/\b(curl|wget)\b/)
    for (const binary of ['test', 'date', 'stat']) expect(healthcheck).toContain(binary)
  })

  it('is retried, so one filesystem hiccup cannot restart a money-mover', () => {
    expect(Number(/--retries=(\d+)/.exec(healthcheck)?.[1])).toBeGreaterThanOrEqual(2)
  })
})

describe('the serve-mode override an operator copies out of the compose file', () => {
  // `serve` never writes the heartbeat, so the image default can only fail there.
  it('probes a route and port the app really serves', () => {
    // The probe line, not the block: a ports comment below also carries 8787.
    const probe = compose.split('\n').find((line) => line.includes('/healthz')) ?? ''
    expect(probe).toContain('/healthz')
    expect(probe).toContain('8787')
    expect(read('packages/solver-transport/src/http/server.ts')).toContain("app.get('/healthz'")
    expect(read('packages/solver-app/src/config.ts')).toContain("intFromEnv('PORT', 8787")
  })
})
