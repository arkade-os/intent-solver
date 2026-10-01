import { describe, it, expect } from 'vitest'
import { createServicesBody, servicesSource } from '../support/createServicesBody.js'

describe('createServices boots with LND unreachable', () => {
  it('opens the LND rail rather than probing it, which crash-looped the solver while LND was down', () => {
    expect(servicesSource).toMatch(/LndLightningBackendAdapter\.open\(/)
    expect(servicesSource).toMatch(/LndOnchainAdapter\.open\(/)
    expect(servicesSource).not.toMatch(/Lnd(LightningBackend|Onchain)Adapter\.create\(/)
  })

  it('gates the rail corridors on a watcher it starts', () => {
    const body = createServicesBody()
    expect(body).toMatch(/railUp: rail\?\.probe \?/)
    expect(body).toMatch(/railWatch = watchRail\(/)
  })
})
