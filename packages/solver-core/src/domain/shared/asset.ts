import { nonEmpty, type Brand } from './brand.js'

export type Asset = Brand<string, 'Asset'>

// Never normalised: ids are compared byte for byte, so a second spelling would be a second asset.
export const Asset = { of: (value: string): Asset => nonEmpty('asset', value) }
