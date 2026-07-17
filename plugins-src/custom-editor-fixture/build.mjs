/**
 * Build script for the custom-editor-fixture plugin.
 *
 * This plugin is pure vanilla HTML — no framework, no bundler. The "build"
 * step just copies editor.html into dist/ (which dev-install-plugin.sh then
 * copies verbatim into the plugin's ui/ directory). The asset path MUST be
 * relative-safe: editor.html has no external asset references at all, so
 * there is no base-path concern here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(dir, 'dist')

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist, { recursive: true })
fs.copyFileSync(path.join(dir, 'editor.html'), path.join(dist, 'editor.html'))

console.log('✓  custom-editor-fixture built: dist/editor.html')
