import type { PluginManifest, PluginRequest, PluginResponse, PluginAction } from './types'

export interface TabSnapshot {
  path: string | null
  filename: string | null
  extension: string | null
  isDirty: boolean
  isUntitled: boolean
  content: string
}

export interface BuildContextOpts {
  htmlBaker?: (tab: TabSnapshot) => Promise<string>
  settingsReader?: (pluginId: string) => Record<string, unknown>
}

export async function buildContext(
  manifest: PluginManifest,
  tab: TabSnapshot,
  opts: BuildContextOpts,
): Promise<{ context: PluginRequest['context']; settings: PluginRequest['settings'] }> {
  const ctx: PluginRequest['context'] = {
    tab: {
      path: tab.path,
      filename: tab.filename,
      extension: tab.extension,
      is_dirty: tab.isDirty,
      is_untitled: tab.isUntitled,
    },
  }
  if (manifest.host_capabilities.includes('renderer.raw')) {
    ctx.raw_content = tab.content
  }
  if (manifest.host_capabilities.includes('renderer.html')) {
    if (!opts.htmlBaker) throw new Error('plugin needs renderer.html but no htmlBaker provided')
    ctx.rendered_html = await opts.htmlBaker(tab)
  }
  let settings: PluginRequest['settings'] | undefined
  if (manifest.host_capabilities.includes('settings.read') && opts.settingsReader) {
    settings = opts.settingsReader(manifest.id)
  }
  return { context: ctx, settings }
}

function settingsWriteScopes(manifest: PluginManifest): string[] {
  return manifest.host_capabilities
    .filter((c): c is `settings.write:${string}` => c.startsWith('settings.write:'))
    .map((c) => c.slice('settings.write:'.length))
}

function keyMatchesScope(key: string, scope: string): boolean {
  if (scope.endsWith('.*')) {
    const prefix = scope.slice(0, -1)  // 'share.'
    if (!key.startsWith(prefix)) return false
    const tail = key.slice(prefix.length)
    return tail.length > 0 && !tail.includes('.')
  }
  return key === scope
}

function actionAllowed(action: PluginAction, manifest: PluginManifest): PluginAction | null {
  const caps = manifest.host_capabilities
  switch (action.type) {
    case 'toast':           return caps.includes('toast') ? action : null
    case 'clipboard.write': return caps.includes('clipboard.write') ? action : null
    case 'dialog.confirm':
    case 'dialog.message':  return caps.includes('dialog') ? action : null
    case 'settings.merge': {
      const scopes = settingsWriteScopes(manifest)
      if (scopes.length === 0) return null
      const idPrefix = `${manifest.id}.`
      const filtered: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(action.patch)) {
        if (!k.startsWith(idPrefix)) continue
        if (!scopes.some((s) => keyMatchesScope(k, s))) continue
        filtered[k] = v
      }
      if (Object.keys(filtered).length === 0) return null
      return { type: 'settings.merge', patch: filtered }
    }
  }
}

export type ParseResult =
  | { ok: true; value: PluginResponse }
  | { ok: false; error: string }

export function parseAndFilterResponse(line: string, manifest: PluginManifest): ParseResult {
  let parsed: unknown
  try { parsed = JSON.parse(line) } catch (e) {
    return { ok: false, error: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (parsed == null || typeof parsed !== 'object')
    return { ok: false, error: 'response must be an object' }
  const o = parsed as Record<string, unknown>
  if (typeof o.success !== 'boolean') return { ok: false, error: 'missing success boolean' }
  if (!Array.isArray(o.actions)) return { ok: false, error: 'actions must be array' }

  const filtered: PluginAction[] = []
  for (const raw of o.actions) {
    if (raw == null || typeof raw !== 'object') continue
    const allowed = actionAllowed(raw as PluginAction, manifest)
    if (allowed) filtered.push(allowed)
    else console.warn(`[plugin:${manifest.id}] dropped action`, raw)
  }
  return { ok: true, value: { success: o.success, actions: filtered } }
}

// --- Tauri invocation wrapper ---

type InvokeFn = (cmd: string, args: Record<string, unknown>) => Promise<unknown>

let invokeImpl: InvokeFn | null = null

export function __setInvokeForTests(fn: InvokeFn | null): void { invokeImpl = fn }

async function invokeTauri(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  if (invokeImpl) return invokeImpl(cmd, args)
  const mod = await import('@tauri-apps/api/core')
  return mod.invoke(cmd, args)
}

export interface InvokeResult {
  ok: boolean
  response?: PluginResponse
  errorMessage?: string
  errorDetail?: string
}

export async function invokePlugin(
  manifest: PluginManifest,
  command: string,
  tab: TabSnapshot,
  opts: BuildContextOpts,
): Promise<InvokeResult> {
  const { context, settings } = await buildContext(manifest, tab, opts)
  const request: PluginRequest = {
    command,
    context,
    settings,
    host_version: '0.1.1',
    plugin_api_version: 1,
  }
  const result = await invokeTauri('invoke_plugin', {
    pluginId: manifest.id, requestJson: JSON.stringify(request),
  }) as { stdout_line: string | null; stderr_tail: string; exit_code: number | null; error: string | null; success: boolean }

  if (result.error) {
    return { ok: false, errorMessage: `${manifest.name}: ${result.error}`, errorDetail: result.stderr_tail }
  }
  if (result.exit_code != null && result.exit_code !== 0) {
    return { ok: false,
      errorMessage: `${manifest.name}: 异常退出（code ${result.exit_code}）`,
      errorDetail: result.stderr_tail.slice(-1024) }
  }
  if (!result.stdout_line) {
    return { ok: false, errorMessage: `${manifest.name}: 协议错误（空响应）`, errorDetail: result.stderr_tail.slice(-1024) }
  }
  const parsedResult = parseAndFilterResponse(result.stdout_line, manifest)
  if (!parsedResult.ok) {
    return { ok: false, errorMessage: `${manifest.name}: 协议错误`, errorDetail: parsedResult.error + '\n---\n' + result.stdout_line.slice(0, 1024) }
  }
  return { ok: true, response: parsedResult.value }
}
