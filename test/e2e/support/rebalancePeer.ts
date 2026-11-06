import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { matchFilter, type Filter } from 'nostr-tools/filter'
import { verifyEvent, type Event } from 'nostr-tools/pure'
import { LndLightningBackendAdapter } from '@arkade-os/solver-rails-lnd/ln/lnd/adapter.js'
import { counterpartyContainer, lncli } from './counterparty.js'

const run = promisify(execFile)

const peerSecret = async (name: 'CERT' | 'MACAROON', dir: string, container: string): Promise<string> => {
  const key = `E2E_LN_COUNTERPARTY_${name}`
  const inline = process.env[key]?.trim()
  const path = process.env[`${key}_PATH`]?.trim()
  if (inline && path) throw new Error(`set only one of ${key} or ${key}_PATH`)
  if (inline) return inline
  if (path) return readFileSync(path).toString('base64')
  const destination = join(dir, name === 'CERT' ? 'peer-tls.cert' : 'peer-admin.macaroon')
  const source = name === 'CERT' ? '/root/.lnd/tls.cert' : '/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon'
  await run('docker', ['cp', `${container}:${source}`, destination], { timeout: 30_000 })
  return readFileSync(destination).toString('base64')
}

export const openPeerLightning = async (dir: string): Promise<LndLightningBackendAdapter> => {
  const container = counterpartyContainer()
  const info = await lncli<{ identity_pubkey: string; chains: { chain: string; network: string }[] }>(container, [
    'getinfo',
  ])
  if (!info.chains.some((chain) => chain.chain === 'bitcoin' && chain.network === 'regtest'))
    throw new Error('rebalance counterparty must run on Bitcoin regtest')
  let socket = process.env.E2E_LN_COUNTERPARTY_SOCKET
  if (!socket) {
    const { stdout } = await run('docker', ['port', container, '10009/tcp'], { timeout: 30_000 })
    const port = /:(\d+)\s*$/m.exec(stdout)?.[1]
    if (!port) throw new Error('regtest counterparty LND has no published gRPC port')
    socket = `localhost:${port}`
  }
  const backend = await LndLightningBackendAdapter.create({
    socket,
    cert: await peerSecret('CERT', dir, container),
    macaroon: await peerSecret('MACAROON', dir, container),
  })
  if ((await backend.walletFingerprint()) !== info.identity_pubkey) {
    await backend.close()
    throw new Error('counterparty adapter does not match the verified regtest node')
  }
  return backend
}

export const startRebalanceRelay = async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const subscriptions = new Map<WebSocket, Map<string, Filter>>()
  const published: Event[] = []
  server.on('connection', (socket) => {
    const filters = new Map<string, Filter>()
    subscriptions.set(socket, filters)
    socket.on('close', () => subscriptions.delete(socket))
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as [string, ...unknown[]]
      if (frame[0] === 'REQ') {
        const id = frame[1] as string
        filters.set(id, frame[2] as Filter)
        socket.send(JSON.stringify(['EOSE', id]))
      } else if (frame[0] === 'CLOSE') {
        filters.delete(frame[1] as string)
      } else if (frame[0] === 'EVENT') {
        const event = frame[1] as Event
        if (!verifyEvent(event)) {
          socket.send(JSON.stringify(['OK', event.id, false, 'invalid signature']))
          return
        }
        published.push(event)
        socket.send(JSON.stringify(['OK', event.id, true, '']))
        for (const [peer, filters] of subscriptions)
          for (const [id, filter] of filters)
            if (matchFilter(filter, event)) peer.send(JSON.stringify(['EVENT', id, event]))
      }
    })
  })
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('rebalance relay did not bind')
  return {
    url: `ws://127.0.0.1:${address.port}`,
    published,
    close: async () => {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    },
  }
}
