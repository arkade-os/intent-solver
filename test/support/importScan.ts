/**
 * The static import scan, shared by every guard that needs one.
 *
 * Extracted from `packaging.test.ts` unchanged. That file's header records why
 * the scan is tsc's own preprocessor rather than regexes: two earlier regex
 * attempts produced silent false positives (the bare word `from` in prose, then
 * inside `z.enum(['from', 'to'])`). Nothing here may be reimplemented by hand.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

// Every extension tsc compiles, not just .ts — a .mts/.cts file would ship
// in dist/ while a .ts-only scan skipped it, which is the same silent gap
// this guard exists to close.
export const COMPILED = /\.(?:m|c)?ts$/

export const compiledFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && COMPILED.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))

const isBare = (specifier: string): boolean => !specifier.startsWith('.') && !specifier.startsWith('node:')

// Scoped packages keep two segments; everything else keeps one — `prune
// --prod` removes whole packages, so the package root is what matters.
const packageRoot = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

/**
 * Bare package specifiers imported by a file — no relative paths, no `node:`
 * builtins. The scan is tsc's own preprocessor rather than regexes: a
 * hand-rolled matcher has to be maintained against `import type`, multi-line
 * specifiers, side-effect imports, `import x = require()` and dynamic
 * imports, and this file's first two runs proved the failure mode is silent
 * false positives (the bare word `from` in prose, then inside
 * `z.enum(['from', 'to'])`). A miss in the other direction is worse: the
 * guard passes and the ERR_MODULE_NOT_FOUND it exists to prevent ships.
 */
export const externalImports = (source: string): string[] =>
  ts
    .preProcessFile(source, /* readImportFiles */ true, /* detectJavaScriptImports */ true)
    .importedFiles.map((file) => file.fileName)
    .filter(isBare)
    .map(packageRoot)

/**
 * Relative specifiers a file imports, as written — `../db/swaps.js`, not a
 * resolved path.
 *
 * The counterpart to {@link externalImports}, and it uses the same
 * `preProcessFile` source of truth rather than a second hand-rolled walk, so
 * both guards agree about what an import IS. Callers resolve these against the
 * importing file's directory; leaving that to them keeps this function free of
 * any assumption about where the tree is rooted.
 */
export const localImports = (source: string): string[] =>
  ts
    .preProcessFile(source, /* readImportFiles */ true, /* detectJavaScriptImports */ true)
    .importedFiles.map((file) => file.fileName)
    .filter((specifier) => specifier.startsWith('.'))

/** Whether tsc erases this import entirely, leaving no `require`/`import` in `dist/`. */
const isErasedImport = (node: ts.ImportDeclaration): boolean => {
  const clause = node.importClause
  // `import 'x'` — imported for side effects, so it survives into dist/.
  if (clause === undefined) return false
  // `import type { T } from 'x'`
  if (clause.isTypeOnly) return true
  // A default binding (`import x from`) or a namespace (`import * as x from`)
  // is a value.
  if (clause.name !== undefined) return false
  const bindings = clause.namedBindings
  if (bindings === undefined || !ts.isNamedImports(bindings)) return false
  // `import { type T, type U } from 'x'`. An empty `import {}` falls through to
  // false deliberately: whether tsc keeps it depends on settings, and a
  // needless flag costs nothing next to a missed one.
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)
}

/** The same question for a re-export, which can also carry a specifier. */
const isErasedExport = (node: ts.ExportDeclaration): boolean => {
  if (node.isTypeOnly) return true
  const clause = node.exportClause
  // `export * from 'x'` re-exports values.
  if (clause === undefined || !ts.isNamedExports(clause)) return false
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly)
}

/**
 * Package roots this file imports ONLY as types.
 *
 * A type-only import is erased by tsc — it emits no `import` into `dist/`, so
 * it cannot raise the ERR_MODULE_NOT_FOUND this guard exists to prevent, and
 * requiring one to sit in `dependencies` would ship a package into the runtime
 * image to satisfy something that does not survive compilation. That is the
 * opposite of what the prune is for.
 *
 * Subtractive on purpose. `preProcessFile` above stays the source of truth for
 * WHICH packages a file reaches, because it already handles the dynamic
 * `import()`, `import x = require()` and triple-slash forms a hand-rolled walk
 * would have to chase. This only removes the ones it can PROVE are erased, so
 * an unrecognised form leaves the package flagged — a false positive, which is
 * the direction this file is written to fail in.
 *
 * A package imported as a type in one place and as a value in another stays
 * flagged: the value import is what ships.
 */
export const typeOnlyImports = (source: string): Set<string> => {
  const parsed = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const erased = new Set<string>()
  const kept = new Set<string>()

  const record = (specifier: ts.Expression | undefined, isErased: boolean): void => {
    // A bare `export { x }` carries no specifier and reaches no package.
    if (specifier === undefined || !ts.isStringLiteral(specifier) || !isBare(specifier.text)) return
    ;(isErased ? erased : kept).add(packageRoot(specifier.text))
  }

  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) record(statement.moduleSpecifier, isErasedImport(statement))
    else if (ts.isExportDeclaration(statement)) record(statement.moduleSpecifier, isErasedExport(statement))
  }

  for (const pkg of kept) erased.delete(pkg)
  return erased
}

/**
 * Specifiers that SURVIVE compilation — every import tsc does not erase, bare
 * and relative alike.
 *
 * The inverse of the type-only question {@link typeOnlyImports} answers for
 * packages, and the one a "this module must pull in nothing at run time" guard
 * needs. Written additively (collect what is kept) rather than subtractively,
 * because here a missed form must read as "this import ships", which is the
 * conservative direction for a guard protecting against a native binding being
 * dragged in transitively.
 */
export const valueImports = (source: string): string[] => {
  const parsed = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS)
  const kept: string[] = []
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!isErasedImport(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        kept.push(statement.moduleSpecifier.text)
      }
    } else if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier
      if (!isErasedExport(statement) && specifier !== undefined && ts.isStringLiteral(specifier)) {
        kept.push(specifier.text)
      }
    }
  }
  return kept
}
