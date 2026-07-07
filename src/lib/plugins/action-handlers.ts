import { pushToast } from '../toast.svelte'
import type { PluginAction, PluginManifest } from './types'
import { t as tr } from '../i18n/store.svelte'

interface Handlers {
  writeText: (s: string) => Promise<void>
  showMessage: (msg: string, opts: { title: string; kind: 'info' | 'warning' | 'error' }) => Promise<void>
  askDialog: (msg: string, opts: { title: string }) => Promise<boolean>
  writeSettings: (patch: Record<string, unknown>) => Promise<void>
  reinvokePlugin: (pluginId: string, command: string) => Promise<void>
}

let installedHandlers: Partial<Handlers> | null = null

/**
 * Install or override action handlers. Used in two ways:
 *
 * 1. **Production wiring** (App.svelte): inject `reinvokePlugin` so
 *    `dialog.confirm` actions can re-enter the plugin dispatch loop.
 *    Other handlers fall through to real Tauri-backed implementations.
 *
 * 2. **Test override**: stub any handler with a vi.fn() mock; pass `null`
 *    to reset to defaults.
 *
 * Partial input: only the keys you provide override defaults; omitted keys
 * keep their built-in `real*` implementation.
 */
export function configureActionHandlers(h: Partial<Handlers> | null): void { installedHandlers = h }

async function realWriteText(s: string): Promise<void> {
  const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
  await writeText(s)
}

async function realShowMessage(msg: string, opts: { title: string; kind: 'info' | 'warning' | 'error' }): Promise<void> {
  const level = opts.kind === 'warning' ? 'warn' : opts.kind
  pushToast({ level, message: msg })
}

async function realAskDialog(msg: string, opts: { title: string }): Promise<boolean> {
  const { ask } = await import('@tauri-apps/plugin-dialog')
  return await ask(msg, opts)
}

async function realWriteSettings(patch: Record<string, unknown>): Promise<void> {
  const { mergePluginScoped } = await import('../settings.svelte')
  await mergePluginScoped(patch)
}

async function realReinvokePlugin(_id: string, _cmd: string): Promise<void> {
  throw new Error('re-invoke not wired here; the App.svelte entry point owns plugin invocation')
}

function pickHandlers(): Handlers {
  const t = installedHandlers ?? {}
  return {
    writeText: t.writeText ?? realWriteText,
    showMessage: t.showMessage ?? realShowMessage,
    askDialog: t.askDialog ?? realAskDialog,
    writeSettings: t.writeSettings ?? realWriteSettings,
    reinvokePlugin: t.reinvokePlugin ?? realReinvokePlugin,
  }
}

export async function applyActions(actions: PluginAction[], manifest: PluginManifest): Promise<void> {
  const h = pickHandlers()
  for (const a of actions) {
    try {
      switch (a.type) {
        case 'toast':
          pushToast({ level: a.level, message: a.message, detail: a.detail })
          break
        case 'clipboard.write':
          await h.writeText(a.text)
          break
        case 'settings.merge':
          await h.writeSettings(a.patch)
          break
        case 'dialog.message': {
          const kind: 'info' | 'warning' | 'error' = a.level === 'warn' ? 'warning' : a.level
          await h.showMessage(a.message, { title: a.title, kind })
          break
        }
        case 'dialog.confirm': {
          const yes = await h.askDialog(a.message, { title: a.title })
          if (yes) await h.reinvokePlugin(manifest.id, a.if_confirm_invoke)
          break
        }
        case 'cli.result':
          // No-op in GUI; CliRunner reads this in CLI mode.
          break
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      pushToast({
        level: 'error',
        message: tr('pluginAction.failed', { name: manifest.name, type: a.type }),
        detail,
      })
    }
  }
}
