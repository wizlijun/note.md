#!/usr/bin/env node
// Keep the merge kernel portable across the desktop, browser and Worker hosts.
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const problems = new Set()
const files = []
const isTest = path => path.endsWith('.test.ts')
const isTs = path => path.endsWith('.ts') || path.endsWith('.tsx')
let root

function within(path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const actual = realpathSync(path)
    if (!within(actual)) {
      problems.add(`${relative(root, path)}: symlink escapes the kernel`)
    } else if (entry.isDirectory()) {
      collect(path)
    } else if (entry.isSymbolicLink() && statSync(path).isDirectory()) {
      problems.add(`${relative(root, path)}: directory symlinks are not kernel sources`)
    } else if (isTs(path) && !isTest(path)) {
      files.push(path)
    }
  }
}

try {
  root = realpathSync(resolve(process.argv[2] ?? join(repository, 'src/lib/share-merge')))
  collect(root)
} catch (error) {
  console.error(`Share merge purity FAILED: ${error.message}`)
  process.exit(1)
}

const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  types: [],
  noEmit: true,
}
const program = ts.createProgram(files, options)
const checker = program.getTypeChecker()
const globalSymbol = checker.resolveName('globalThis', undefined, ts.SymbolFlags.Value, false)
const standardLibraries = new Map([...ts.libMap].filter(([name]) =>
  name.startsWith('es') || name === 'decorators' || name === 'decorators.legacy'))
const standardDeclarationFiles = new Set(standardLibraries.values())

// TextEncoder is the kernel's standard UTF-8 codec, available in all three
// hosts. Non-ECMAScript default libraries otherwise describe host dependencies,
// including Worker-only types that do not appear in lib.dom declarations.
const encodingDeclarations = new Set(['TextEncoder', 'TextEncoderCommon', 'TextEncoderEncodeIntoResult'])
const hostNames = new Set([
  'window', 'document', 'HTMLElement', 'Node', 'DOMParser', 'navigator',
  'localStorage', 'sessionStorage', 'indexedDB', 'fetch', 'crypto',
  'process', 'Buffer', 'global', 'require', '__dirname', '__filename', '__TAURI__', 'Deno', 'Bun',
])

function forbiddenSymbol(symbol) {
  if (!symbol) return false
  return (symbol.declarations ?? []).some(declaration => {
    const source = declaration.getSourceFile()
    if (!program.isSourceFileDefaultLibrary(source) || standardDeclarationFiles.has(basename(source.fileName))) return false
    for (let owner = declaration; owner; owner = owner.parent) {
      if (owner.name && ts.isIdentifier(owner.name) && encodingDeclarations.has(owner.name.text)) return false
    }
    return true
  })
}

function nameOnly(node) {
  const parent = node.parent
  return (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isQualifiedName(parent) && parent.right === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)
    || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)
      || ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent)
      || ts.isPropertyDeclaration(parent)) && parent.name === node)
}

for (const path of files) {
  const source = program.getSourceFile(path)
  const report = (node, reason) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    problems.add(`${relative(root, path)}:${position.line + 1}:${position.character + 1}: ${reason}`)
  }
  const dependencyName = (node, name) => {
    if (!name.startsWith('./') && !name.startsWith('../')) {
      report(node, `external dependency ${JSON.stringify(name)} is forbidden`)
      return
    }
    const resolved = ts.resolveModuleName(name, path, options, ts.sys).resolvedModule?.resolvedFileName
    if (!resolved) {
      report(node, `cannot resolve kernel dependency ${JSON.stringify(name)}`)
      return
    }
    const actual = realpathSync(resolved)
    if (!within(actual) || !within(resolve(dirname(path), name))) {
      report(node, `dependency ${JSON.stringify(name)} escapes the kernel`)
    } else if (isTest(resolved) || isTest(actual)) {
      report(node, `production dependency ${JSON.stringify(name)} targets a test file`)
    } else if (!isTs(actual)) {
      report(node, `dependency ${JSON.stringify(name)} is not a TypeScript kernel source`)
    }
  }
  const dependency = (node, specifier) => {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      report(node, 'dependency target must be a static string')
    } else {
      dependencyName(node, specifier.text)
    }
  }
  const checkProperty = (node, object, name) => {
    const type = checker.getTypeAtLocation(object)
    const symbol = checker.getPropertyOfType(type, name)
    if (forbiddenSymbol(symbol) || (type.symbol === globalSymbol && hostNames.has(name))) {
      report(node, `host property ${name} is forbidden`)
    }
  }
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) dependency(node, node.moduleSpecifier)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      dependency(node, node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node)) {
      dependency(node, ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined)
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        dependency(node, node.arguments[0])
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require'
        && !checker.getSymbolAtLocation(node.expression)?.declarations?.some(d => files.includes(d.getSourceFile().fileName))) {
        dependency(node, node.arguments[0])
      }
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      const directRequire = node.text === 'require' && ts.isCallExpression(node.parent) && node.parent.expression === node
      if (forbiddenSymbol(symbol) || (!symbol && !nameOnly(node) && !directRequire && hostNames.has(node.text))) {
        report(node, `host reference ${node.text} is forbidden`)
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      checkProperty(node, node.expression, node.name.text)
    } else if (ts.isElementAccessExpression(node) && node.argumentExpression) {
      if (ts.isStringLiteralLike(node.argumentExpression)) {
        checkProperty(node, node.expression, node.argumentExpression.text)
      } else if (checker.getTypeAtLocation(node.expression).symbol === globalSymbol) {
        report(node, 'global property target must be a static string')
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const declaration = node.parent.parent
      const name = node.propertyName ?? node.name
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))) {
        checkProperty(node, declaration.initializer, name.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const diagnostic of program.getSyntacticDiagnostics(source)) {
    problems.add(`${relative(root, path)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
  }
  for (const reference of source.typeReferenceDirectives) {
    report(source, `external type reference ${JSON.stringify(reference.fileName)} is forbidden`)
  }
  for (const reference of source.libReferenceDirectives) {
    if (!standardLibraries.has(reference.fileName.toLowerCase())) {
      report(source, `host library reference ${JSON.stringify(reference.fileName)} is forbidden`)
    }
  }
  for (const reference of source.referencedFiles) {
    const name = reference.fileName
    dependencyName(source, name.startsWith('.') || isAbsolute(name) ? name : `./${name}`)
  }
  visit(source)
}

if (problems.size) {
  console.error('Share merge purity FAILED:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`Share merge purity OK (${files.length} production TypeScript files)`)
