import type { PluginAction, PluginManifest } from '../plugins/types'

export interface CliPayload {
  subcommand: string
  plugin_id: string
  plugin_command: string
  file: string | null
  flags: Record<string, string | boolean>
  global: GlobalFlags
}

export interface GlobalFlags {
  json: boolean
  quiet: boolean
  clipboard: boolean
  yes: boolean
}

export interface ActionInterpretation {
  exitCode: number
  stdout: string | null
  stderr: string[]
}

export interface InterpretOptions {
  isTty: boolean
  writeClipboard?: (text: string) => Promise<void> | void
  writeSettings?: (patch: Record<string, unknown>) => Promise<void> | void
}

/** Extract filename from absolute path. */
export function basenameOf(absPath: string): string {
  const slash = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'))
  return slash >= 0 ? absPath.slice(slash + 1) : absPath
}

/** Extract extension (with dot) or null. */
export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot) : null
}

/**
 * Determine the kind of a CLI virtual tab. Mirrors src/lib/fs.ts classifyPath
 * but kept inline because we don't want to load full editor state. The
 * 'plaintext' bucket is purely a CLI-side label — the Svelte runner maps it
 * to the editor's `FileKind` (which has no 'plaintext'; we fold to 'code')
 * before constructing the virtual Tab.
 */
export function inferKind(extension: string | null): 'markdown' | 'html' | 'code' | 'plaintext' | 'image' {
  if (extension == null) return 'plaintext'
  const e = extension.toLowerCase()
  if (e === '.md' || e === '.markdown' || e === '.mdown' || e === '.mkd') return 'markdown'
  if (e === '.html' || e === '.htm') return 'html'
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.heic', '.heif'].includes(e)) return 'image'
  return 'code'
}

interface ToastAction { type: 'toast'; level: 'success' | 'info' | 'warn' | 'error'; message: string; detail?: string }
interface ClipboardAction { type: 'clipboard.write'; text: string }
interface SettingsMergeAction { type: 'settings.merge'; patch: Record<string, unknown> }
interface CliResultAction { type: 'cli.result'; data: Record<string, unknown> }

/**
 * Walks the plugin's response actions and produces a CLI-style outcome.
 * Side effects (clipboard, settings) are routed through caller-supplied
 * functions so this stays unit-testable.
 */
export function interpretActions(
  actions: PluginAction[],
  manifest: PluginManifest,
  payload: CliPayload,
  opts: InterpretOptions,
): ActionInterpretation {
  let exitCode = 0
  let cliData: Record<string, unknown> | null = null
  const errorLines: string[] = []
  const progressLines: string[] = []

  for (const a of actions) {
    switch (a.type) {
      case 'toast': {
        const t = a as ToastAction
        if (t.level === 'error') {
          exitCode = 4
          const line = t.message.replace(/^❌\s*/, '✗ ')
          errorLines.push(t.detail ? `${line}\n  ${t.detail}` : line)
        } else if (!payload.global.quiet && opts.isTty) {
          progressLines.push(t.message.replace(/^✅\s*/, '✓ '))
        }
        break
      }
      case 'clipboard.write': {
        const c = a as ClipboardAction
        if (payload.global.clipboard && !payload.global.json && opts.writeClipboard) {
          Promise.resolve(opts.writeClipboard(c.text)).catch(() => {})
        }
        break
      }
      case 'settings.merge': {
        const s = a as SettingsMergeAction
        if (opts.writeSettings) {
          Promise.resolve(opts.writeSettings(s.patch)).catch(() => {})
        }
        break
      }
      case 'cli.result': {
        cliData = (a as CliResultAction).data
        break
      }
      // dialog.* in CLI: no-op for now (share doesn't emit them)
    }
  }

  let stdout: string | null = null
  if (payload.global.json) {
    if (exitCode === 0 && cliData) {
      stdout = JSON.stringify({ ok: true, data: cliData })
    } else if (exitCode !== 0) {
      const firstErr = errorLines[0] ?? `${manifest.name} failed`
      stdout = JSON.stringify({
        ok: false,
        error: { code: 'plugin_failed', message: firstErr.replace(/^✗\s*/, '') },
      })
    } else {
      stdout = JSON.stringify({ ok: true, data: {} })
    }
  } else if (exitCode === 0 && cliData && typeof cliData.url === 'string') {
    stdout = cliData.url as string
  } else if (exitCode === 0 && cliData && typeof cliData.path === 'string') {
    stdout = cliData.path as string
  }

  const stderr = [...errorLines, ...progressLines]
  return { exitCode, stdout, stderr }
}
