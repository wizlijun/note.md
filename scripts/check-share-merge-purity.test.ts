import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const script = resolve('scripts/check-share-merge-purity.mjs')
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), 'share-merge-purity-'))
  temporary.push(directory)
  const root = join(directory, 'kernel')
  mkdirSync(root)
  for (const [path, text] of Object.entries(files)) {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, text)
  }
  return root
}

function check(root?: string) {
  return spawnSync(process.execPath, [script, ...(root ? [root] : [])], { encoding: 'utf8' })
}

it.each([
  "import { invoke } from '@tauri-apps/api/core'",
  "import 'svelte'",
  "import type { Editor } from '@moraya/core'",
  "export { value } from 'other-package'",
  "export type { Value } from 'other-package'",
  "type Value = import('other-package').Value",
  "import value = require('node:fs')",
  "const value = import('svelte')",
  "const value = require('@tauri-apps/api/core')",
  "const name = './safe'; const value = import(name)",
  "const name = './safe'; const value = require(name)",
  "const load = require; const value = load('svelte')",
  "export { value } from '../../outside'",
  "import type { Value } from '../../outside'",
  "const value = import('../../outside')",
  "const value = require('../../outside')",
  "import './missing'",
  "import './oracle.test'",
  "export type { Value } from './oracle.test'",
  "const value = import('./oracle.test')",
  "const value = require('./oracle.test')",
])('rejects dependency targets outside the production kernel: %s', source => {
  const root = fixture({ 'nested/bad.ts': source, 'nested/safe.ts': 'export const value = 1', '../outside.ts': 'export const value = 1', 'nested/oracle.test.ts': 'export interface Value {}' })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('nested/bad.ts')
}, 15_000)

it.each([
  '/// <reference types="node" />\nexport const value = process',
  '/// <reference path="../outside.d.ts" />\nexport const value = process',
])('rejects external type reference directives: %s', source => {
  const root = fixture({ 'bad.ts': source, '../outside.d.ts': 'declare const process: { env: object }' })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('bad.ts')
}, 15_000)

it.each([
  ['export const value = new FileReaderSync()', 'FileReaderSync'],
  ['export type Value = DedicatedWorkerGlobalScope', 'DedicatedWorkerGlobalScope'],
])('rejects Worker library runtime and type references: %s', (source, name) => {
  const root = fixture({ 'bad.ts': `/// <reference lib="webworker" />\n${source}` })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('bad.ts')
  expect(result.stderr).toContain(`host reference ${name}`)
}, 15_000)

it('rejects host library directives even without a host symbol use', () => {
  const root = fixture({ 'bad.ts': '/// <reference lib="dom" />\nexport const value = 1' })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('host library reference "dom"')
}, 15_000)

it('allows ECMAScript library directives with standard computation and TextEncoder', () => {
  const root = fixture({ 'safe.ts': '/// <reference lib="es2022" />\nexport const value = new Map([[1, Math.max(2, 3)]]); export const bytes = new TextEncoder().encode("中文")' })
  const result = check(root)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}, 15_000)

it.each([
  'export const value = window.location',
  'export const value = document.title',
  'export type Value = HTMLElement',
  'export type Value = Node',
  'export const value = new DOMParser()',
  'export const value = navigator.userAgent',
  'export const value = localStorage.getItem("x")',
  'export const value = indexedDB',
  'export const value = fetch("https://example.com")',
  'export const value = process.env',
  'export const value = Buffer.from("x")',
  'export const value = __TAURI__',
  'export const value = globalThis.document',
  'export const value = globalThis["document"]',
  'const host = globalThis; export const value = host.document',
  'const host = globalThis; export const value = host["document"]',
  'const { document: doc } = globalThis; export const value = doc',
  'export const value = globalThis.process',
  'const host = globalThis; export const value = host["__TAURI__"]',
  'const { process: host } = globalThis; export const value = host',
  'const name = "document"; export const value = globalThis[name]',
])('rejects DOM and host references including aliases: %s', source => {
  const root = fixture({ 'bad.ts': source })
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('bad.ts')
}, 15_000)

it('allows internal runtime/type dependencies, exports, static dynamic imports and require', () => {
  const root = fixture({
    'index.ts': "import { value } from './nested/value.js'; import type { Value } from './nested/value'; export { value }; export type { Value }; export * from './nested'; type Other = import('./nested/value').Value; const loaded = import('./nested/value'); const required = require('./nested/value'); import equal = require('./nested/value')",
    'nested/index.ts': "export { value } from './value'",
    'nested/value.ts': 'export const value = 1; export interface Value { text: string }',
    'reference.ts': '/// <reference path="./nested/value.ts" />\nexport const value = 1',
  })
  const result = check(root)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}, 15_000)

it('allows local names and properties without confusing them with host globals', () => {
  const root = fixture({ 'safe.ts': `
    type Node = { document: string }
    const window: Node = { document: 'window document HTMLElement' }
    function read(document: Node, globalThis: Node) { return document.document + globalThis.document }
    const { document } = window
    const host = { document: 1, navigator: 2 }
    const property = host['document']
    const require = (name: string) => name
    export const text = read(window, window) + document + require('ordinary-local-call')
    // document.createElement('div') and import('svelte') are only comments.
  ` })
  const result = check(root)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}, 15_000)

it('allows standard computation and UTF-8 encoding while excluding independent oracle tests', () => {
  const root = fixture({
    'safe.ts': 'export const bytes = new TextEncoder().encode("中文"); export const values = new Map([[1, Math.max(2, 3)]]); export const words = new Uint32Array(bytes.buffer); export const encoder = new globalThis.TextEncoder(); export const standard = globalThis["Math"].max(1, 2)',
    'oracle.test.ts': "import { it } from 'vitest'; import { createHash } from 'node:crypto'; it('oracle', () => document.title)",
  })
  const result = check(root)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}, 15_000)

it('rejects symlink dependencies that escape the kernel', () => {
  const root = fixture({ 'bad.ts': "import './linked'" })
  writeFileSync(join(root, '..', 'outside.ts'), 'export const value = 1')
  symlinkSync(join(root, '..', 'outside.ts'), join(root, 'linked.ts'))
  const result = check(root)
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('linked.ts')
}, 15_000)

it('checks the real kernel by default', () => {
  const result = check()
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
}, 15_000)
