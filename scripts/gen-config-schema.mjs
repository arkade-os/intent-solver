/** Writes `solver-config.schema.json` for editors: `pnpm -r build && pnpm gen:config-schema`. */
import { writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'

const DECIMAL = 'decimal string'

// To zod a 256-bit amount is a custom check, which converts to "anything"; an editor needs the type.
const typeDecimals = (node) => {
  if (Array.isArray(node)) return node.map(typeDecimals)
  if (!node || typeof node !== 'object') return node
  const typed = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, typeDecimals(value)]))
  return typed.description === DECIMAL ? { ...typed, type: 'string', pattern: '^\\d+$' } : typed
}

export const configJsonSchema = (documentSchema) => ({
  ...typeDecimals(zodToJsonSchema(documentSchema, { $refStrategy: 'none', target: 'jsonSchema7' })),
  title: 'Arkade intent-solver config document',
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { documentSchema } = await import('../packages/solver-app/dist/config/document.js')
  const target = fileURLToPath(new URL('../solver-config.schema.json', import.meta.url))
  writeFileSync(target, `${JSON.stringify(configJsonSchema(documentSchema([])), null, 2)}\n`)
  console.log(`wrote ${target}`)
}
