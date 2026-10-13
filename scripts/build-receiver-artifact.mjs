import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import { format, resolveConfig } from 'prettier'

const compiler = createRequire(import.meta.url)('solc')
if (!compiler.version().startsWith('0.8.30+commit.73712a01')) throw new Error('receiver requires pinned solc 0.8.30')
const root = fileURLToPath(new URL('../packages/solver-rails-evm/contracts/', import.meta.url))
const solidityFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? solidityFiles(join(dir, entry.name)) : entry.name.endsWith('.sol') ? [join(dir, entry.name)] : [],
  )
const sources = Object.fromEntries(
  solidityFiles(root)
    .map((path) => [relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8').replace(/\r\n/g, '\n')])
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([path, content]) => [path, { content }]),
)
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'shanghai',
  outputSelection: {
    '*': {
      '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'],
      '': ['ast'],
    },
  },
}
const output = JSON.parse(compiler.compile(JSON.stringify({ language: 'Solidity', sources, settings })))
const errors = (output.errors ?? []).filter((error) => error.severity === 'error')
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'))
const { IntentReceiver: receiver, IntentReceiverFactory: factory } = output.contracts['IntentReceiver.sol']
const names = {}
const walk = (node) => {
  if (node.mutability === 'immutable') names[node.id] = node.name
  for (const child of node.nodes ?? []) walk(child)
}
walk(output.sources['IntentReceiver.sol'].ast)
const sourceHash = createHash('sha256')
for (const [path, { content }] of Object.entries(sources)) sourceHash.update(`${path}\0${content}\0`)
const artifact = {
  compiler: compiler.version(),
  sourceSha256: sourceHash.digest('hex'),
  optimizerRuns: 200,
  evmVersion: 'shanghai',
  factoryCreationBytecode: factory.evm.bytecode.object,
  implementationRuntimeTemplate: receiver.evm.deployedBytecode.object,
  implementationImmutableReferences: Object.fromEntries(
    Object.entries(receiver.evm.deployedBytecode.immutableReferences).map(([id, refs]) => [names[id], refs]),
  ),
}
const destination = new URL('../packages/solver-rails-evm/src/evm/receiverArtifact.ts', import.meta.url)
const content = await format(`export const receiverArtifact = ${JSON.stringify(artifact, null, 2)} as const\n`, {
  ...(await resolveConfig(fileURLToPath(destination))),
  parser: 'typescript',
})
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8').replace(/\r\n/g, '\n') !== content)
    throw new Error('receiver artifact does not match pinned source/compiler')
} else writeFileSync(destination, content)
