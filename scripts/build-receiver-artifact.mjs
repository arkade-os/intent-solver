import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { format, resolveConfig } from 'prettier'

const compiler = createRequire(import.meta.url)('solc')
if (!compiler.version().startsWith('0.8.30+commit.73712a01')) throw new Error('receiver requires pinned solc 0.8.30')
const source = readFileSync(
  new URL('../packages/solver-rails-evm/contracts/IntentReceiver.sol', import.meta.url),
  'utf8',
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
const output = JSON.parse(
  compiler.compile(
    JSON.stringify({ language: 'Solidity', sources: { 'IntentReceiver.sol': { content: source } }, settings }),
  ),
)
const errors = (output.errors ?? []).filter((error) => error.severity === 'error')
if (errors.length) throw new Error(errors.map((error) => error.formattedMessage).join('\n'))
const contract = output.contracts['IntentReceiver.sol'].IntentReceiver
const names = {}
const walk = (node) => {
  if (node.mutability === 'immutable') names[node.id] = node.name
  for (const child of node.nodes ?? []) walk(child)
}
walk(output.sources['IntentReceiver.sol'].ast)
const artifact = {
  compiler: compiler.version(),
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  optimizerRuns: 200,
  evmVersion: 'shanghai',
  creationBytecode: contract.evm.bytecode.object,
  runtimeTemplate: contract.evm.deployedBytecode.object,
  immutableReferences: Object.fromEntries(
    Object.entries(contract.evm.deployedBytecode.immutableReferences).map(([id, refs]) => [names[id], refs]),
  ),
}
const destination = new URL('../packages/solver-rails-evm/src/evm/receiverArtifact.ts', import.meta.url)
const content = await format(`export const receiverArtifact = ${JSON.stringify(artifact, null, 2)} as const\n`, {
  ...(await resolveConfig(destination.pathname)),
  parser: 'typescript',
})
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== content)
    throw new Error('receiver artifact does not match pinned source/compiler')
} else writeFileSync(destination, content)
