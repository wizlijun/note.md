// src/lib/strings.ts — self-contained i18n for the roam-import plugin.
//
// The 16 `roamImport.*` strings are copied verbatim (2026-07) from the host
// catalogs src/lib/i18n/{en,zh,ja,de}.ts. The keys here drop the `roamImport.`
// prefix (the plugin has no other namespace). Language is chosen by
// `notemd.locale` at startup; English is the fallback for any missing key.

export type Locale = 'en' | 'zh' | 'ja' | 'de'

export type MessageKey =
  | 'title'
  | 'pickFile'
  | 'noVault'
  | 'stage.parse'
  | 'stage.plan'
  | 'stage.write'
  | 'progress'
  | 'errors'
  | 'copyLog'
  | 'done'
  | 'doneErrors'
  | 'conflicts'
  | 'overwriteSelected'
  | 'errParse'
  | 'errWrite'
  | 'warnRenamed'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  title: 'Import from Roam Research',
  pickFile: 'Choose Roam export (.zip / .json)…',
  noVault: 'Configure a Vault first (Settings → Vault) to import.',
  'stage.parse': 'Parsing export…',
  'stage.plan': 'Planning import…',
  'stage.write': 'Writing notes…',
  progress: '{done} / {total} pages — {current}',
  errors: 'Errors & warnings',
  copyLog: 'Copy log',
  done: 'Import finished: {wiki} wiki pages, {daily} daily notes, {skipped} skipped.',
  doneErrors: 'Finished with {errors} problem(s) — see log below.',
  conflicts: '{count} page(s) modified locally were skipped.',
  overwriteSelected: 'Overwrite selected',
  errParse: 'Export not readable: {error}',
  errWrite: 'Write failed for {page}: {error}',
  warnRenamed: 'Renamed "{from}" → "{to}" (filename constraint)',
}

const zh: Catalog = {
  title: '从 Roam Research 导入',
  pickFile: '选择 Roam 导出文件（.zip / .json）…',
  noVault: '请先在 设置 → Vault 配置仓库后再导入。',
  'stage.parse': '正在解析导出文件…',
  'stage.plan': '正在计算导入计划…',
  'stage.write': '正在写入笔记…',
  progress: '{done} / {total} 页 — {current}',
  errors: '错误与警告',
  copyLog: '复制日志',
  done: '导入完成：{wiki} 个 wiki 页、{daily} 篇日记、跳过 {skipped}。',
  doneErrors: '完成，但有 {errors} 个问题 — 见下方日志。',
  conflicts: '{count} 个页面因本地已修改被跳过。',
  overwriteSelected: '覆盖所选',
  errParse: '导出文件不可读：{error}',
  errWrite: '写入 {page} 失败：{error}',
  warnRenamed: '“{from}”改名为“{to}”（文件名约束）',
}

const ja: Catalog = {
  title: 'Roam Research からインポート',
  pickFile: 'Roam エクスポートを選択（.zip / .json）…',
  noVault: '先に 設定 → Vault でボールトを設定してください。',
  'stage.parse': 'エクスポートを解析中…',
  'stage.plan': 'インポート計画を作成中…',
  'stage.write': 'ノートを書き込み中…',
  progress: '{done} / {total} ページ — {current}',
  errors: 'エラーと警告',
  copyLog: 'ログをコピー',
  done: '完了：wiki {wiki} 件、デイリー {daily} 件、スキップ {skipped} 件。',
  doneErrors: '完了しましたが {errors} 件の問題があります（下のログ参照）。',
  conflicts: 'ローカルで変更済みの {count} ページをスキップしました。',
  overwriteSelected: '選択を上書き',
  errParse: 'エクスポートを読み込めません：{error}',
  errWrite: '{page} の書き込みに失敗：{error}',
  warnRenamed: '「{from}」を「{to}」に改名（ファイル名制約）',
}

const de: Catalog = {
  title: 'Aus Roam Research importieren',
  pickFile: 'Roam-Export auswählen (.zip / .json)…',
  noVault: 'Konfigurieren Sie zuerst einen Tresor (Einstellungen → Tresor), um zu importieren.',
  'stage.parse': 'Export wird analysiert…',
  'stage.plan': 'Import wird geplant…',
  'stage.write': 'Notizen werden geschrieben…',
  progress: '{done} / {total} Seiten — {current}',
  errors: 'Fehler & Warnungen',
  copyLog: 'Protokoll kopieren',
  done: 'Import abgeschlossen: {wiki} Wiki-Seiten, {daily} Tagesnotizen, {skipped} übersprungen.',
  doneErrors: 'Mit {errors} Problem(en) abgeschlossen — siehe Protokoll unten.',
  conflicts: '{count} lokal geänderte Seite(n) wurden übersprungen.',
  overwriteSelected: 'Ausgewählte überschreiben',
  errParse: 'Export nicht lesbar: {error}',
  errWrite: 'Schreiben fehlgeschlagen für {page}: {error}',
  warnRenamed: '„{from}“ umbenannt in „{to}“ (Dateinamen-Einschränkung)',
}

const registry: Record<Locale, Catalog> = { en, zh, ja, de }

let active: Locale = 'en'

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'zh' || v === 'ja' || v === 'de'
}

/** Set the active locale from `notemd.locale`; unknown/absent → English. */
export function setLocale(code: string | undefined): void {
  active = isLocale(code) ? code : 'en'
}

/**
 * Translate `key`, filling `{name}` placeholders from `params`. Falls back to
 * the English catalog for a missing key, then to the raw key. Mirrors the
 * host's `t()` (src/lib/i18n/store.svelte.ts).
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const catalog = registry[active] ?? en
  let s = catalog[key] ?? en[key] ?? key
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  }
  return s
}
