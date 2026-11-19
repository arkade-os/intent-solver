import type { Endpoint } from '../shared/endpoint.js'
import type { Route } from './route.js'

export interface RouteRepository {
  get(from: Endpoint, to: Endpoint): Promise<Route | null>
  list(): Promise<readonly Route[]>
  addOrUpdate(route: Route): Promise<void>
}
