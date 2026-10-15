// The admin console over seeded fake data, for working on the client without a
// regtest stack. Dev tool only. Run: pnpm admin:dev [--live]
//
// The static files are served from packages/solver-app/src/admin/static, so an
// edit there shows on a browser reload. A change to the server needs the build
// this script's pnpm entry runs first.
import { serve } from '@hono/node-server'
import { buildAdminApp } from '../packages/solver-app/dist/admin/server.js'
import { DEMO_ENV, buildDemoConsole } from '../packages/solver-app/dist/ops/adminDemo.js'

const port = Number(process.env.ADMIN_PORT ?? 8788)
const host = process.env.ADMIN_HOST ?? '127.0.0.1'
const live = process.argv.includes('--live')

// The card route reads it per request rather than from the config the demo built.
process.env.SOLVER_NAME = DEMO_ENV.SOLVER_NAME

const demo = await buildDemoConsole({ live })
const server = serve({ fetch: buildAdminApp(demo.deps).fetch, port, hostname: host, overrideGlobalObjects: false })
console.log(`admin console demo on http://${host}:${port}${live ? ' (live: a swap moves every 15s)' : ''}`)

const stop = async () => {
  server.close()
  await demo.close()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
