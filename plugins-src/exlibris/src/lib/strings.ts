// src/lib/strings.ts — self-contained i18n for the exlibris plugin.
//
// Mirrors the roam-import plugin's strings.ts pattern: a `Locale` type, a flat
// dot-namespaced `MessageKey` union, per-locale `Catalog`s, a `registry`, and a
// `t(key, params?)` that reads the active locale (chosen from `bridge().locale`
// at startup via `setLocale`) and falls back to English for any missing key.
//
// Product/field proper nouns (ExLibris, calibre, Sotvault, Rawvault, ISBN) are
// intentionally left untranslated; only the surrounding words are localized.

export type Locale = 'en' | 'zh' | 'ja' | 'de'

export type MessageKey =
  // App shell
  | 'app.title'
  | 'app.tab.import'
  | 'app.tab.library'
  | 'app.settings'
  | 'app.cancelAll'
  // DropZone
  | 'drop.pickTitle'
  | 'drop.filterEbooks'
  | 'drop.prompt'
  | 'drop.supports'
  | 'drop.addBooks'
  // OnboardingBanner
  | 'onboard.getStarted'
  | 'onboard.sotvault'
  | 'onboard.rawvault'
  | 'onboard.calibre'
  | 'onboard.notConfigured'
  | 'onboard.notDetected'
  | 'onboard.choose'
  | 'onboard.installCalibre'
  // SettingsDialog
  | 'settings.title'
  | 'settings.paths'
  | 'settings.sotvault'
  | 'settings.rawvault'
  | 'settings.calibre'
  | 'settings.choose'
  | 'settings.close'
  // PendingList
  | 'pending.selectAll'
  | 'pending.import'
  | 'pending.col.status'
  | 'pending.col.bookName'
  | 'pending.col.target'
  | 'pending.col.source'
  | 'pending.exists'
  | 'pending.remove'
  // MetaPreview
  | 'meta.authors'
  | 'meta.publisher'
  | 'meta.language'
  | 'meta.isbn'
  | 'meta.tags'
  | 'meta.source'
  | 'meta.rawPath'
  | 'meta.imported'
  | 'meta.description'
  | 'meta.openInMdeditor'
  | 'meta.toastTitle'
  // RebuildPanel
  | 'rebuild.complete'
  | 'rebuild.title'
  | 'rebuild.computeDiff'
  | 'rebuild.willMove'
  | 'rebuild.apply'
  | 'rebuild.noChanges'
  | 'rebuild.verify'
  | 'rebuild.runVerify'
  | 'rebuild.orphanRaw'
  | 'rebuild.missingRaw'
  | 'rebuild.duplicateIsbn'
  | 'rebuild.details'
  // RulesEditor
  | 'rules.title'
  | 'rules.add'
  | 'rules.save'
  | 'rules.moveUp'
  | 'rules.moveDown'
  | 'rules.remove'
  | 'rules.ext'
  | 'rules.tagContains'
  | 'rules.authorContains'
  | 'rules.language'
  | 'rules.targetDir'
  | 'rules.defaultHint'
  | 'rules.newRule'
  // LibraryBrowser
  | 'library.title'
  | 'library.refresh'
  | 'library.searchPlaceholder'
  | 'library.all'
  | 'library.col.title'
  | 'library.col.authors'
  | 'library.col.rule'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  'app.title': 'ExLibris',
  'app.tab.import': 'Import',
  'app.tab.library': 'Library',
  'app.settings': '⚙ Settings',
  'app.cancelAll': 'Cancel All',

  'drop.pickTitle': 'Add books',
  'drop.filterEbooks': 'Ebooks',
  'drop.prompt': 'Add ebook files to import',
  'drop.supports': 'Supports {formats}',
  'drop.addBooks': 'Add books…',

  'onboard.getStarted': 'Get Started',
  'onboard.sotvault': 'Sotvault:',
  'onboard.rawvault': 'Rawvault:',
  'onboard.calibre': 'calibre:',
  'onboard.notConfigured': 'Not configured',
  'onboard.notDetected': 'Not detected',
  'onboard.choose': 'Choose…',
  'onboard.installCalibre': 'Install calibre',

  'settings.title': 'Settings',
  'settings.paths': 'Paths',
  'settings.sotvault': 'Sotvault:',
  'settings.rawvault': 'Rawvault:',
  'settings.calibre': 'calibre:',
  'settings.choose': 'Choose',
  'settings.close': 'Close',

  'pending.selectAll': 'Select all',
  'pending.import': 'Import {count}',
  'pending.col.status': 'Status',
  'pending.col.bookName': 'Book Name',
  'pending.col.target': 'Target',
  'pending.col.source': 'Source',
  'pending.exists': '🔁 exists',
  'pending.remove': 'Remove',

  'meta.authors': 'Authors:',
  'meta.publisher': 'Publisher:',
  'meta.language': 'Language:',
  'meta.isbn': 'ISBN:',
  'meta.tags': 'Tags:',
  'meta.source': 'Source:',
  'meta.rawPath': 'Raw path:',
  'meta.imported': 'Imported:',
  'meta.description': 'Description:',
  'meta.openInMdeditor': 'Open in mdeditor',
  'meta.toastTitle': 'Book note',

  'rebuild.complete': 'Rebuild complete.',
  'rebuild.title': 'Rebuild Sotvault',
  'rebuild.computeDiff': 'Compute Diff',
  'rebuild.willMove': '{count} books will move:',
  'rebuild.apply': 'Apply',
  'rebuild.noChanges': 'No changes.',
  'rebuild.verify': 'Verify',
  'rebuild.runVerify': 'Run Verify',
  'rebuild.orphanRaw': 'Orphan raw: {count}',
  'rebuild.missingRaw': 'Missing raw: {count}',
  'rebuild.duplicateIsbn': 'Duplicate ISBN: {count}',
  'rebuild.details': 'Details',

  'rules.title': 'Rules',
  'rules.add': '+ Add Rule',
  'rules.save': 'Save',
  'rules.moveUp': 'Move up',
  'rules.moveDown': 'Move down',
  'rules.remove': 'Remove rule',
  'rules.ext': 'ext (comma-sep):',
  'rules.tagContains': 'tag_contains:',
  'rules.authorContains': 'author_contains:',
  'rules.language': 'language:',
  'rules.targetDir': 'target dir:',
  'rules.defaultHint': 'Default rule (always matches): all unmatched books go to',
  'rules.newRule': 'New Rule',

  'library.title': 'Library',
  'library.refresh': 'Refresh',
  'library.searchPlaceholder': 'Search…',
  'library.all': 'All ({count})',
  'library.col.title': 'Title',
  'library.col.authors': 'Authors',
  'library.col.rule': 'Rule',
}

const zh: Catalog = {
  'app.title': 'ExLibris',
  'app.tab.import': '导入',
  'app.tab.library': '书库',
  'app.settings': '⚙ 设置',
  'app.cancelAll': '全部取消',

  'drop.pickTitle': '添加书籍',
  'drop.filterEbooks': '电子书',
  'drop.prompt': '添加要导入的电子书文件',
  'drop.supports': '支持 {formats}',
  'drop.addBooks': '添加书籍…',

  'onboard.getStarted': '开始使用',
  'onboard.sotvault': 'Sotvault：',
  'onboard.rawvault': 'Rawvault：',
  'onboard.calibre': 'calibre：',
  'onboard.notConfigured': '未配置',
  'onboard.notDetected': '未检测到',
  'onboard.choose': '选择…',
  'onboard.installCalibre': '安装 calibre',

  'settings.title': '设置',
  'settings.paths': '路径',
  'settings.sotvault': 'Sotvault：',
  'settings.rawvault': 'Rawvault：',
  'settings.calibre': 'calibre：',
  'settings.choose': '选择',
  'settings.close': '关闭',

  'pending.selectAll': '全选',
  'pending.import': '导入 {count}',
  'pending.col.status': '状态',
  'pending.col.bookName': '书名',
  'pending.col.target': '目标',
  'pending.col.source': '来源',
  'pending.exists': '🔁 已存在',
  'pending.remove': '移除',

  'meta.authors': '作者：',
  'meta.publisher': '出版社：',
  'meta.language': '语言：',
  'meta.isbn': 'ISBN：',
  'meta.tags': '标签：',
  'meta.source': '来源：',
  'meta.rawPath': '原始路径：',
  'meta.imported': '导入时间：',
  'meta.description': '简介：',
  'meta.openInMdeditor': '在 mdeditor 中打开',
  'meta.toastTitle': '书籍笔记',

  'rebuild.complete': '重建完成。',
  'rebuild.title': '重建 Sotvault',
  'rebuild.computeDiff': '计算差异',
  'rebuild.willMove': '{count} 本书将被移动：',
  'rebuild.apply': '应用',
  'rebuild.noChanges': '无变更。',
  'rebuild.verify': '校验',
  'rebuild.runVerify': '运行校验',
  'rebuild.orphanRaw': '孤立原始文件：{count}',
  'rebuild.missingRaw': '缺失原始文件：{count}',
  'rebuild.duplicateIsbn': '重复 ISBN：{count}',
  'rebuild.details': '详情',

  'rules.title': '规则',
  'rules.add': '+ 添加规则',
  'rules.save': '保存',
  'rules.moveUp': '上移',
  'rules.moveDown': '下移',
  'rules.remove': '删除规则',
  'rules.ext': '扩展名（逗号分隔）：',
  'rules.tagContains': 'tag_contains：',
  'rules.authorContains': 'author_contains：',
  'rules.language': 'language：',
  'rules.targetDir': '目标目录：',
  'rules.defaultHint': '默认规则（始终匹配）：所有未匹配的书籍进入',
  'rules.newRule': '新规则',

  'library.title': '书库',
  'library.refresh': '刷新',
  'library.searchPlaceholder': '搜索…',
  'library.all': '全部（{count}）',
  'library.col.title': '标题',
  'library.col.authors': '作者',
  'library.col.rule': '规则',
}

const ja: Catalog = {
  'app.title': 'ExLibris',
  'app.tab.import': 'インポート',
  'app.tab.library': 'ライブラリ',
  'app.settings': '⚙ 設定',
  'app.cancelAll': 'すべてキャンセル',

  'drop.pickTitle': '書籍を追加',
  'drop.filterEbooks': '電子書籍',
  'drop.prompt': 'インポートする電子書籍ファイルを追加',
  'drop.supports': '対応形式：{formats}',
  'drop.addBooks': '書籍を追加…',

  'onboard.getStarted': 'はじめる',
  'onboard.sotvault': 'Sotvault：',
  'onboard.rawvault': 'Rawvault：',
  'onboard.calibre': 'calibre：',
  'onboard.notConfigured': '未設定',
  'onboard.notDetected': '未検出',
  'onboard.choose': '選択…',
  'onboard.installCalibre': 'calibre をインストール',

  'settings.title': '設定',
  'settings.paths': 'パス',
  'settings.sotvault': 'Sotvault：',
  'settings.rawvault': 'Rawvault：',
  'settings.calibre': 'calibre：',
  'settings.choose': '選択',
  'settings.close': '閉じる',

  'pending.selectAll': 'すべて選択',
  'pending.import': '{count} 件をインポート',
  'pending.col.status': 'ステータス',
  'pending.col.bookName': '書名',
  'pending.col.target': '保存先',
  'pending.col.source': 'ソース',
  'pending.exists': '🔁 既存',
  'pending.remove': '削除',

  'meta.authors': '著者：',
  'meta.publisher': '出版社：',
  'meta.language': '言語：',
  'meta.isbn': 'ISBN：',
  'meta.tags': 'タグ：',
  'meta.source': 'ソース：',
  'meta.rawPath': '元のパス：',
  'meta.imported': 'インポート日時：',
  'meta.description': '説明：',
  'meta.openInMdeditor': 'mdeditor で開く',
  'meta.toastTitle': '書籍ノート',

  'rebuild.complete': '再構築が完了しました。',
  'rebuild.title': 'Sotvault を再構築',
  'rebuild.computeDiff': '差分を計算',
  'rebuild.willMove': '{count} 冊が移動されます：',
  'rebuild.apply': '適用',
  'rebuild.noChanges': '変更はありません。',
  'rebuild.verify': '検証',
  'rebuild.runVerify': '検証を実行',
  'rebuild.orphanRaw': '孤立した元ファイル：{count}',
  'rebuild.missingRaw': '欠落した元ファイル：{count}',
  'rebuild.duplicateIsbn': 'ISBN の重複：{count}',
  'rebuild.details': '詳細',

  'rules.title': 'ルール',
  'rules.add': '+ ルールを追加',
  'rules.save': '保存',
  'rules.moveUp': '上へ移動',
  'rules.moveDown': '下へ移動',
  'rules.remove': 'ルールを削除',
  'rules.ext': 'ext（カンマ区切り）：',
  'rules.tagContains': 'tag_contains：',
  'rules.authorContains': 'author_contains：',
  'rules.language': 'language：',
  'rules.targetDir': '保存先ディレクトリ：',
  'rules.defaultHint': 'デフォルトルール（常に一致）：一致しない書籍はすべて次へ',
  'rules.newRule': '新しいルール',

  'library.title': 'ライブラリ',
  'library.refresh': '更新',
  'library.searchPlaceholder': '検索…',
  'library.all': 'すべて（{count}）',
  'library.col.title': 'タイトル',
  'library.col.authors': '著者',
  'library.col.rule': 'ルール',
}

const de: Catalog = {
  'app.title': 'ExLibris',
  'app.tab.import': 'Import',
  'app.tab.library': 'Bibliothek',
  'app.settings': '⚙ Einstellungen',
  'app.cancelAll': 'Alle abbrechen',

  'drop.pickTitle': 'Bücher hinzufügen',
  'drop.filterEbooks': 'E-Books',
  'drop.prompt': 'E-Book-Dateien zum Importieren hinzufügen',
  'drop.supports': 'Unterstützt {formats}',
  'drop.addBooks': 'Bücher hinzufügen…',

  'onboard.getStarted': 'Loslegen',
  'onboard.sotvault': 'Sotvault:',
  'onboard.rawvault': 'Rawvault:',
  'onboard.calibre': 'calibre:',
  'onboard.notConfigured': 'Nicht konfiguriert',
  'onboard.notDetected': 'Nicht erkannt',
  'onboard.choose': 'Auswählen…',
  'onboard.installCalibre': 'calibre installieren',

  'settings.title': 'Einstellungen',
  'settings.paths': 'Pfade',
  'settings.sotvault': 'Sotvault:',
  'settings.rawvault': 'Rawvault:',
  'settings.calibre': 'calibre:',
  'settings.choose': 'Auswählen',
  'settings.close': 'Schließen',

  'pending.selectAll': 'Alle auswählen',
  'pending.import': '{count} importieren',
  'pending.col.status': 'Status',
  'pending.col.bookName': 'Buchtitel',
  'pending.col.target': 'Ziel',
  'pending.col.source': 'Quelle',
  'pending.exists': '🔁 vorhanden',
  'pending.remove': 'Entfernen',

  'meta.authors': 'Autoren:',
  'meta.publisher': 'Verlag:',
  'meta.language': 'Sprache:',
  'meta.isbn': 'ISBN:',
  'meta.tags': 'Schlagwörter:',
  'meta.source': 'Quelle:',
  'meta.rawPath': 'Rohpfad:',
  'meta.imported': 'Importiert:',
  'meta.description': 'Beschreibung:',
  'meta.openInMdeditor': 'In mdeditor öffnen',
  'meta.toastTitle': 'Buchnotiz',

  'rebuild.complete': 'Neuaufbau abgeschlossen.',
  'rebuild.title': 'Sotvault neu aufbauen',
  'rebuild.computeDiff': 'Unterschiede berechnen',
  'rebuild.willMove': '{count} Bücher werden verschoben:',
  'rebuild.apply': 'Anwenden',
  'rebuild.noChanges': 'Keine Änderungen.',
  'rebuild.verify': 'Prüfen',
  'rebuild.runVerify': 'Prüfung ausführen',
  'rebuild.orphanRaw': 'Verwaiste Rohdatei: {count}',
  'rebuild.missingRaw': 'Fehlende Rohdatei: {count}',
  'rebuild.duplicateIsbn': 'Doppelte ISBN: {count}',
  'rebuild.details': 'Details',

  'rules.title': 'Regeln',
  'rules.add': '+ Regel hinzufügen',
  'rules.save': 'Speichern',
  'rules.moveUp': 'Nach oben',
  'rules.moveDown': 'Nach unten',
  'rules.remove': 'Regel entfernen',
  'rules.ext': 'ext (kommagetrennt):',
  'rules.tagContains': 'tag_contains:',
  'rules.authorContains': 'author_contains:',
  'rules.language': 'language:',
  'rules.targetDir': 'Zielordner:',
  'rules.defaultHint': 'Standardregel (trifft immer zu): alle nicht zugeordneten Bücher gehen nach',
  'rules.newRule': 'Neue Regel',

  'library.title': 'Bibliothek',
  'library.refresh': 'Aktualisieren',
  'library.searchPlaceholder': 'Suchen…',
  'library.all': 'Alle ({count})',
  'library.col.title': 'Titel',
  'library.col.authors': 'Autoren',
  'library.col.rule': 'Regel',
}

const registry: Record<Locale, Catalog> = { en, zh, ja, de }

let active: Locale = 'en'

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'zh' || v === 'ja' || v === 'de'
}

/** Set the active locale from `bridge().locale`; unknown/absent → English. */
export function setLocale(code: string | undefined): void {
  active = isLocale(code) ? code : 'en'
}

/**
 * Translate `key`, filling `{name}` placeholders from `params`. Falls back to
 * the English catalog for a missing key, then to the raw key.
 */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const catalog = registry[active] ?? en
  let s = catalog[key] ?? en[key] ?? key
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m))
  }
  return s
}
