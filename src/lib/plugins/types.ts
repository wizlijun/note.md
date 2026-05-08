export type Capability =
  | 'renderer.html'
  | 'renderer.raw'
  | 'settings.read'
  | `settings.write:${string}`
  | 'clipboard.write'
  | 'toast'
  | 'dialog'

export type SettingsField =
  | { key: string; type: 'string'; label: string; default?: string; placeholder?: string }
  | { key: string; type: 'secret'; label: string }
  | { key: string; type: 'select'; label: string; options: string[]; default?: string }
  | { key: string; type: 'boolean'; label: string; default?: boolean }

export interface PromptSpec {
  kind: 'save-dialog'
  default_filename: string
  filters: Array<{ name: string; extensions: string[] }>
}

export interface MenuEntry {
  location: 'file' | 'edit' | 'view' | 'window' | 'help' | 'plugins'
  label: string
  shortcut?: string
  command: string
  enabled_when?: string
  prompt?: PromptSpec
}

export interface ContextMenuEntry {
  location: 'tab' | 'editor'
  label: string
  command: string
  enabled_when?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  description?: string
  binary: string
  menus?: MenuEntry[]
  context_menus?: ContextMenuEntry[]
  settings?: { tab_label: string; schema: SettingsField[] }
  host_capabilities: Capability[]
  timeout_seconds?: number
}

export interface RequestContextTab {
  path: string | null
  filename: string | null
  extension: string | null
  kind: TabKind
  title: string
  is_dirty: boolean
  is_untitled: boolean
}

export interface PluginRequest {
  command: string
  context: {
    tab: RequestContextTab
    rendered_html?: string
    raw_content?: string
    output_path?: string
  }
  settings?: Record<string, unknown>
  host_version: string
  plugin_api_version: 1
}

export type ToastLevel = 'success' | 'info' | 'warn' | 'error'

export type PluginAction =
  | { type: 'toast'; level: ToastLevel; message: string; detail?: string }
  | { type: 'clipboard.write'; text: string }
  | { type: 'settings.merge'; patch: Record<string, unknown> }
  | { type: 'dialog.confirm'; title: string; message: string; if_confirm_invoke: string }
  | { type: 'dialog.message'; title: string; message: string; level: 'info' | 'warn' | 'error' }

export interface PluginResponse {
  success: boolean
  actions: PluginAction[]
}

export type TabKind = 'markdown' | 'html' | 'code'

/** What we evaluate `enabled_when` expressions against. */
export interface EnabledWhenContext {
  currentTab: {
    path: string | null
    filename: string | null
    extension: string | null
    kind: TabKind | null
    hasContent: boolean
    isDirty: boolean
    isUntitled: boolean
  } | null
  settings: Record<string, unknown>
}
