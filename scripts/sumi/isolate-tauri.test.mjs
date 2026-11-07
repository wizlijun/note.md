import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isolateTauriSource } from './isolate-tauri.mjs'

test('rewrites only benchmark Tauri module globals, including event/OS metadata', () => {
 const source = 'window.__TAURI_INTERNALS__.invoke(); window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(); window.__TAURI_OS_PLUGIN_INTERNALS__.platform'
 assert.equal(isolateTauriSource(source, '/repo/src/main.ts'), null)
 const rewritten = isolateTauriSource(source, '/repo/node_modules/@tauri-apps/api/core.js')
 assert(!rewritten.includes('window.__TAURI_'))
 assert(rewritten.includes('window.__SUMI_BENCH_INTERNALS__.invoke()'))
 assert(rewritten.includes('window.__SUMI_BENCH_EVENT_INTERNALS__.unregisterListener()'))
 assert(rewritten.includes('window.__SUMI_BENCH_OS_INTERNALS__.platform'))
})
