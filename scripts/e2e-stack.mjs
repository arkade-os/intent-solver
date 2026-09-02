// Start the pieces of the e2e stack that are NOT arkade-regtest: a local EVM
// chain for the EVM corridors' e2e, and the flat price feed their fixtures
// read. Foreground - Ctrl+C stops the feed; the anvil container is left
// running on purpose (see below).
//
//   node scripts/e2e-stack.mjs          # anvil + feed, runs until interrupted
//   node scripts/e2e-stack.mjs down     # remove the anvil container
//
// WHY THIS EXISTS. The docker one-liner for anvil used to live in a comment in
// `test/e2e/evmSendSwap.e2e.test.ts`, and the feed on :8088 was not documented
// ANYWHERE - a fresh machine failed evmQuote/evmSendSwap "for no reason" until
// something happened to answer that port (observed: a hand-run static server
// answering {"btc":{"asset":100000000}}). Both prerequisites now live here,
// next to the regtest-fund/settle scripts they complement, and the runbook's
// walkthrough can point at one command.
//
// WHAT IT DOES NOT DO. Nothing Arkade-side - arkd, the emulator, boltz-lnd,
// esplora and the miner all still come from arkade-regtest (docs/runbook.md),
// and the wallet still wants settling before a run (scripts/regtest-settle.mjs).
// This script is only the two extras the EVM corridors bolt onto that stack.
//
// Idempotent by design: an already-healthy `lsw-anvil` container is reused, not
// recreated, and a feed already answering on :8088 with the expected shape is
// left alone. Anything ELSE occupying those ports is an error, not something
// to kill - it might be yours. On Ctrl+C the feed stops with this process and
// the container stays up, so the next run starts instantly; `down` removes it
// when you are done for good. (On Windows, killing the process from Task
// Manager or `Stop-Process` does not run signal handlers at all - the feed
// still dies with the process since it is in-process, and the container
// remains up either way, which is the intended end state.)
//
// The feed answers EVERY GET with the flat regtest price
// {"btc":{"asset":100000000}} - one token unit per sat, the rate the e2e
// fixtures assume - because `src/price/feed.ts` resolves the market's
// price_path as an RFC 6901 pointer IN THE BODY, not a URL suffix: whichever
// path a fixture names, `/btc/asset` or otherwise, the body carries it.
// Override the ports/image with E2E_ANVIL_PORT / E2E_FEED_PORT /
// E2E_ANVIL_IMAGE, and point the suite at a non-default feed with
// PRICEFEED_E2E_URL the way `test/e2e/evmSendSwap.e2e.test.ts` already allows.

import http from 'node:http'
import { connect } from 'node:net'
import { spawnSync } from 'node:child_process'

const ANVIL_NAME = 'lsw-anvil'
const ANVIL_IMAGE = process.env.E2E_ANVIL_IMAGE ?? 'ghcr.io/foundry-rs/foundry:latest'
const ANVIL_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8545)
const FEED_PORT = Number(process.env.E2E_FEED_PORT ?? 8088)
const FEED_BODY = JSON.stringify({ btc: { asset: 100_000_000 } })

const anvilUrl = () => `http://localhost:${ANVIL_PORT}`
const feedUrl = () => `http://localhost:${FEED_PORT}`

const post = async (method, params) => {
  const response = await fetch(anvilUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await response.json()
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).slice(0, 200)}`)
  return json.result
}

/** eth_chainId answering, or false. */
const anvilHealthy = async () => {
  try {
    return typeof (await post('eth_chainId', [])) === 'string'
  } catch {
    return false
  }
}

/** Is anything accepting TCP on the port? */
const portBusy = (port) =>
  new Promise((resolve) => {
    const socket = connect({ host: 'localhost', port })
    const done = (busy) => {
      socket.destroy()
      resolve(busy)
    }
    socket.setTimeout(1_000)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

/**
 * The feed the suite expects, already running? Probed at /btc-asset - the
 * path the fixtures default to - and checked for the exact flat shape, so an
 * unrelated service on the port is not mistaken for it.
 */
const feedHealthy = async () => {
  try {
    const response = await fetch(`${feedUrl()}/btc-asset`, { signal: AbortSignal.timeout(2_000) })
    if (!response.ok) return false
    const body = await response.json()
    return typeof body?.btc?.asset === 'number'
  } catch {
    return false
  }
}

const docker = (...args) => {
  const run = spawnSync('docker', args, { stdio: 'inherit' })
  if (run.error) throw new Error(`docker ${args.join(' ')}: ${run.error.message} - is Docker running?`)
  if (run.status !== 0) throw new Error(`docker ${args.join(' ')} exited ${run.status}`)
}

/** Is our named container present (running or not)? Null when Docker itself
 * cannot be asked - anvil may still be healthy from a non-Docker install. */
const containerExists = () => {
  const run = spawnSync('docker', ['ps', '-aq', '-f', `name=^/${ANVIL_NAME}$`], { encoding: 'utf8' })
  if (run.error) return null
  return (run.stdout ?? '').trim().length > 0
}

const ensureAnvil = async () => {
  if (await anvilHealthy()) {
    const ours = containerExists()
    console.log(
      ours === null
        ? `anvil already answering on :${ANVIL_PORT} - using it`
        : ours
          ? `anvil already answering on :${ANVIL_PORT} - reusing the ${ANVIL_NAME} container`
          : `an anvil is already answering on :${ANVIL_PORT} (no ${ANVIL_NAME} container) - using it`,
    )
    return
  }
  if (await portBusy(ANVIL_PORT)) {
    throw new Error(
      `port ${ANVIL_PORT} is occupied by something that is not the ${ANVIL_NAME} container. ` +
        'Refusing to touch it - free the port or point the suite elsewhere with EVM_E2E_RPC_URL.',
    )
  }
  // A container that exists but does not answer (paused, or mid-image-pull
  // crash) is ours to replace; anything we rm here was named by us above.
  spawnSync('docker', ['rm', '-f', ANVIL_NAME], { stdio: 'ignore' })
  console.log(`starting anvil (${ANVIL_IMAGE}) on :${ANVIL_PORT}...`)
  docker(
    'run',
    '-d',
    '--name',
    ANVIL_NAME,
    '-p',
    `${ANVIL_PORT}:8545`,
    '--entrypoint',
    'anvil',
    ANVIL_IMAGE,
    '--host',
    '0.0.0.0',
    '--silent',
  )
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await anvilHealthy()) {
      console.log('anvil up')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('anvil did not answer eth_chainId within 60s - check `docker logs lsw-anvil`')
}

const serveFeed = async () => {
  if (await feedHealthy()) {
    console.log(`feed already answering on :${FEED_PORT} with the flat regtest price (leaving it alone)`)
    return null
  }
  if (await portBusy(FEED_PORT)) {
    throw new Error(
      `port ${FEED_PORT} is occupied by something that does not answer like the feed. ` +
        'Refusing to touch it - free the port, or serve the feed yourself and re-run.',
    )
  }
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(FEED_BODY)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(FEED_PORT, () => resolve(null))
  })
  console.log(`feed serving the flat regtest price on :${FEED_PORT} (one token unit per sat)`)
  return server
}

const down = () => {
  // The feed is in-process, so `down` has nothing to stop here; this removes
  // the container, which is the piece that outlives an `up`.
  const run = spawnSync('docker', ['rm', '-f', ANVIL_NAME], { stdio: 'pipe', encoding: 'utf8' })
  if (run.error) throw new Error(`docker rm: ${run.error.message} - is Docker running?`)
  if (run.status === 0) console.log(`${ANVIL_NAME} removed`)
  else if (typeof run.stderr === 'string' && /No such container/.test(run.stderr))
    console.log(`${ANVIL_NAME} was not running`)
  else throw new Error(`docker rm -f ${ANVIL_NAME} exited ${run.status}: ${run.stderr}`)
}

const up = async () => {
  await ensureAnvil()
  const feed = await serveFeed()
  // Stay in the foreground either way. When we own the feed its server keeps
  // the loop alive by itself; when it was reused there is no other handle, and
  // an `up` that exits the moment both checks pass reads as "the script
  // crashed" even though everything it promised is running.
  const hold = setInterval(() => {}, 60_000)
  const stop = () => {
    clearInterval(hold)
    if (feed !== null) {
      feed.close()
      console.log('feed stopped')
    }
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(
    [
      '',
      'e2e stack ready:',
      `  anvil  ${anvilUrl()}   (contract bytecode is injected per run by the suite)`,
      `  feed   ${feedUrl()}    (flat regtest price; override per-run with PRICEFEED_E2E_URL)`,
      '',
      'Arkade-side prerequisites are unchanged: arkade-regtest up (docs/runbook.md), wallet',
      'settled (scripts/regtest-settle.mjs), .env.regtest.lnd in place.',
      '',
      'Run the suite, for example:',
      '  node --env-file=.env.regtest.lnd --experimental-eventsource node_modules/vitest/vitest.mjs run --config vitest.e2e.config.ts',
      '',
      'The anvil container is left running between passes on purpose; `node scripts/e2e-stack.mjs down` removes it.',
      'Ctrl+C stops the feed.',
    ].join('\n'),
  )
}

const command = process.argv[2] ?? 'up'
if (command === 'up') {
  up().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
} else if (command === 'down') {
  try {
    down()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
} else {
  console.error(`usage: node scripts/e2e-stack.mjs [up|down]`)
  process.exit(1)
}
