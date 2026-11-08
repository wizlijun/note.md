export type Locale = 'zh' | 'en' | 'ja'
export function normalizeLocale(value: string): Locale {
  const base = value.trim().toLowerCase().split(/[-_]/)[0]
  return base === 'zh' || base === 'ja' ? base : 'en'
}

// Host status messages are not page content. Translate only recognized messages;
// keep unknown diagnostic details intact and preserve JSON-RPC error codes.
const hostMessages: readonly (readonly [string, string, string])[] = [
  ['头部格式损坏，已将完整源文保留为正文；不会猜测或删除其中内容。', 'The header is damaged. The entire source is retained as body text; nothing is inferred or removed.', 'ヘッダーが破損しています。元の文章全体を本文として保持し、内容を推測したり削除したりしません。'],
  ['源文件含 CR/CRLF；恢复前需明确同意在新纸页中规范为 LF，原文件保持不变。', 'The source contains CR/CRLF line endings. Recovery requires your explicit consent to use LF in the new page; the original file stays unchanged.', '元のファイルに CR/CRLF 改行が含まれています。復元するには、新しいページで LF に統一することへの明示的な同意が必要です。元のファイルは変更しません。'],
  ['同名元数据缺失，已按页面身份、版本及全文摘要找到唯一匹配文件；恢复不会移动或删除它。', 'The same-name metadata is missing. A unique matching file was found using the page identity, revision and full-text digest; recovery will not move or delete it.', '同名のメタデータがありません。ページの識別情報、版、全文のハッシュから一致するファイルが一つ見つかりました。復元時に移動や削除は行いません。'],
  ['候选元数据搜索未能完整验证；新纸页将保留正文，行时间标为未知。', 'The metadata candidate search could not be fully verified. The new page will retain the text and mark line times as unknown.', 'メタデータ候補の検索を完全に検証できませんでした。新しいページには本文を保持し、行の日時は不明と記録します。'],
  ['存在多个匹配元数据候选，无法唯一配对；新纸页行时间将标为未知。', 'Multiple metadata candidates match, so no unique pair can be established. Line times in the new page will be marked as unknown.', '一致するメタデータ候補が複数あり、一意に対応付けられません。新しいページの行の日時は不明と記録します。'],
  ['没有可验证的唯一时间快照；正文可恢复，首次/最后书写时间均标为未知，不会伪造历史。', 'There is no uniquely verifiable timestamp snapshot. The text can be recovered, but first-written and last-edited times will be marked as unknown; no history is invented.', '一意に検証できる日時のスナップショットがありません。本文は復元できますが、初回執筆日時と最終編集日時は不明と記録し、履歴を捏造しません。'],
  ['原编辑面尚未完成保存，请稍后重试', 'The original editor has not finished saving. Try again shortly.', '元のエディタでの保存がまだ完了していません。しばらくしてから再試行してください。'],
  ['文件对在检查期间发生变化，请重新检查', 'The file pair changed during inspection. Check it again.', '確認中にファイルの組が変更されました。もう一度確認してください。'],
  ['连接关闭', 'Connection closed', '接続が閉じられました'],
  ['网络不可用', 'Network unavailable', 'ネットワークを利用できません'],
  ['本机写作', 'Writing on this device', 'この端末で執筆中'],
  ['尚未连接同步服务', 'Not connected to sync', '同期サービスに未接続です'],
  ['同步尚未启动', 'Sync has not started', '同期はまだ開始されていません'],
  ['同步状态不可用', 'Sync status is unavailable', '同期状態を取得できません'],
  ['配对完成，正在连接同步服务', 'Paired. Connecting to sync…', 'ペアリング完了。同期サービスに接続中…'],
  ['正在接收完整纸页，新的修改已保存在本机', 'Receiving the complete page. New edits are saved on this device.', 'ページ全体を受信中です。新しい変更はこの端末に保存されています。'],
  ['正在更新同步连接', 'Refreshing the sync connection…', '同期接続を更新中…'],
  ['正在读取系统钥匙串，文字保存在本机', 'Reading the system Keychain. Your writing is saved on this device.', 'システムのキーチェーンを読み取り中です。文章はこの端末に保存されています。'],
  ['正在等待系统钥匙串授权，请查看系统授权窗口；文字保存在本机', 'Waiting for Keychain access. Check the system permission dialog; your writing is saved on this device.', 'キーチェーンへのアクセス許可を待っています。システムの許可ダイアログをご確認ください。文章はこの端末に保存されています。'],
  ['远端日志已隔离或重写，已保留本机草稿；请从恢复入口建立已验证的新纸页', 'The remote history was isolated or rewritten. Your local draft is retained; use recovery to create a verified new page.', 'リモートの履歴が隔離または書き換えられました。端末の下書きは保持されています。復元機能から検証済みの新しいページを作成してください。'],
  ['Sumi 原生编辑需要 macOS 13 或更新版本', 'Sumi native writing requires macOS 13 or later.', 'すみのネイティブ編集には macOS 13 以降が必要です。'],
  ['需要 macOS 13 或更新版本', 'Requires macOS 13 or later.', 'macOS 13 以降が必要です。'],
  ['当前系统不支持 Sumi 原生编辑', 'Native writing is unavailable on this system.', 'このシステムではネイティブ編集を利用できません。'],
  ['Sumi 窗口已关闭，请重新打开后继续书写', 'The Sumi window is closed. Reopen it to continue writing.', 'すみのウインドウが閉じられています。開き直して執筆を続けてください。'],
  ['Sumi 正在停用或交接，草稿已保留', 'Sumi is being disabled or handed over. Your draft is retained.', 'すみを無効化または引き継ぎ中です。下書きは保持されています。'],
  ['Sumi 正在停止，不能创建新会话', 'Sumi is stopping. A new session cannot be opened yet.', 'すみを停止中です。新しいセッションはまだ開けません。'],
  ['Vault 已切换，旧编辑会话已停止', 'The Vault changed. The previous editing session has stopped.', 'Vault が切り替わったため、前の編集セッションを停止しました。'],
  ['写作会话已关闭', 'The writing session is closed.', '執筆セッションが閉じられています。'],
  ['无效的写作外观设置', 'Invalid writing appearance settings.', '執筆画面の外観設定が無効です。'],
  ['请先完成输入法组合', 'Finish the current text composition first.', '入力中の変換を確定してください。'],
  ['composition active', 'Finish the current text composition first.', '入力中の変換を確定してください。'],
  ['暂时无法打开面板，文字已保留，请重试', 'The panel could not be opened. Your writing is retained; try again.', 'パネルを開けませんでした。文章は保持されています。再試行してください。'],
  ['此页正在另一个编辑面中使用', 'This page is open in another editor.', 'このページは別のエディタで開かれています。'],
  ['此页已在另一个编辑面中打开', 'This page is open in another editor.', 'このページは別のエディタで開かれています。'],
  ['原生编辑面已过期', 'The editor session has expired. Reopen the page.', '編集セッションの有効期限が切れました。ページを開き直してください。'],
  ['页面生命周期已变化，旧草稿已保留，请重新打开', 'The page state changed. Your draft is retained; reopen the page.', 'ページの状態が変わりました。下書きは保持されています。ページを開き直してください。'],
  ['编辑版本已变化，请重试', 'The editing revision changed. Try again.', '編集中の版が変わりました。再試行してください。'],
  ['写作状态恢复失败', 'Unable to restore the writing state.', '執筆状態を復元できませんでした。'],
  ['此页尚未下载，请先连接同步服务', 'This page has not downloaded yet. Connect to sync first.', 'このページはまだダウンロードされていません。先に同期サービスへ接続してください。'],
  ['请先连接同步服务', 'Connect to sync first.', '先に同期サービスへ接続してください。'],
  ['纸页不存在或已删除', 'The page is missing or has been deleted.', 'ページが存在しないか、削除されています。'],
  ['当前 Vault 已连接另一写作空间，请在独立 Vault 中连接新空间，避免跨账号混合正文', 'This Vault is connected to another writing space. Use a separate Vault for the new space to keep accounts separate.', 'この Vault は別の執筆スペースに接続されています。アカウント間で文章が混在しないよう、新しいスペースには別の Vault を使用してください。'],
  ['请先选择要添加链接的文字', 'Select the text to link first.', 'リンクを付ける文字を先に選択してください。'],
  ['原剪贴板没有纯文本内容，请恢复原始粘贴', 'The original clipboard has no plain text. Use the original paste instead.', '元のクリップボードにプレーンテキストがありません。元の形式で貼り付けてください。'],
  ['剪贴板超过 4 MiB，请分段粘贴', 'The clipboard exceeds 4 MiB. Paste smaller sections.', 'クリップボードが 4 MiB を超えています。分割して貼り付けてください。'],
  ['Font URL must use HTTPS', 'Font downloads require HTTPS.', 'フォントのダウンロードには HTTPS が必要です。'],
  ['Font download size differs', 'The font download size does not match.', 'フォントのダウンロードサイズが一致しません。'],
  ['Font download exceeds expected size', 'The font download exceeds its expected size.', 'フォントのダウンロードが想定サイズを超えています。'],
  ['Incomplete font download', 'The font download is incomplete.', 'フォントのダウンロードが完了していません。'],
  ['Font size or SHA-256 verification failed', 'Font size or SHA-256 verification failed.', 'フォントサイズまたは SHA-256 の検証に失敗しました。'],
  ['Unexpected font archive structure', 'The font archive has an unexpected structure.', 'フォントアーカイブの構成が想定と異なります。'],
  ['Unexpected font archive member', 'The font archive contains an unexpected file.', 'フォントアーカイブに想定外のファイルが含まれています。'],
  ['Unexpected archived font size', 'The archived font size does not match.', 'アーカイブ内のフォントサイズが一致しません。'],
]

const hostChinese: Readonly<Record<string, string>> = {
  'composition active': '请先完成输入法组合',
  'Font URL must use HTTPS': '字体下载必须使用 HTTPS。',
  'Font download size differs': '字体下载大小不符。',
  'Font download exceeds expected size': '字体下载超过预期大小。',
  'Incomplete font download': '字体下载不完整。',
  'Font size or SHA-256 verification failed': '字体大小或 SHA-256 校验失败。',
  'Unexpected font archive structure': '字体压缩包结构不符。',
  'Unexpected font archive member': '字体压缩包包含非预期文件。',
  'Unexpected archived font size': '压缩包中的字体大小不符。',
}

export function createI18n(value: string) {
  const locale = normalizeLocale(value)
  const t = (zh: string, en: string, ja: string) => locale === 'zh' ? zh : locale === 'ja' ? ja : en
  const appName = t('墨笺', 'Sumi', 'すみ')
  function hostMessage(value: unknown, kind: 'error' | 'status' = 'error'): string {
    const raw = value instanceof Error ? value.message : String(value ?? '')
    if (!raw) return ''
    const match = /^(?:Error:\s*)?(-?\d+:\s*)?(.*)$/s.exec(raw)!
    const code = match[1] ?? '', message = match[2]
    const known = hostMessages.find(([source]) => source === message)
    if (known) {
      let translated = t(hostChinese[message] ?? known[0], known[1], known[2])
      if (locale === 'zh') {
        if (message.startsWith('Sumi')) translated = translated.replace(/^Sumi\s*/, '墨笺')
      }
      return code + translated
    }
    const details = (summary: string, detail: string) => `${summary} ${t('详细信息：', 'Details: ', '詳細: ')}${detail}`
    if (message.startsWith('离线保存中：')) return code + details(t('离线保存中。', 'Saving offline.', 'オフラインで保存中。'), message.slice('离线保存中：'.length))
    if (message.startsWith('无法恢复同步连接：')) return code + details(t('无法恢复同步连接；文字保存在本机。', 'Unable to restore sync; your writing is saved on this device.', '同期接続を復元できません。文章はこの端末に保存されています。'), message.slice('无法恢复同步连接：'.length).replace(/；文字保存在本机$/, ''))
    if (message.startsWith('阅读位置尚未保存：')) return code + details(t('阅读位置尚未保存。', 'The reading position has not been saved.', '読書位置はまだ保存されていません。'), message.slice('阅读位置尚未保存：'.length))
    if (message.startsWith('Invalid ')) return code + details(t('请检查外观设置。', 'Check the appearance settings.', '外観設定を確認してください。'), message)
    return code + details(kind === 'status' ? t('同步状态。', 'Sync status.', '同期の状態。') : t('操作未完成。', 'The operation could not be completed.', '操作を完了できませんでした。'), message)
  }
  function fontName(family: string, fallback: string): string {
    if (family === 'Sumi Zhaohua') return t('朝华打字机', 'Zhaohua Typewriter', '朝華タイプライター')
    if (family === 'Sumi Youcha') return t('油茶馓子体', 'Youcha Sanzi', '油茶サンズー体')
    if (family === 'Sumi Fangsong') return t('Zhuque Fangsong · 朱雀仿宋', 'Zhuque Fangsong', 'Zhuque Fangsong · 朱雀仿宋')
    if (family === 'Sumi CRT') return t('复古绿磷 CRT · GNU Unifont', 'Retro Green Phosphor CRT · GNU Unifont', 'レトログリーン蛍光 CRT · GNU Unifont')
    return fallback
  }
  return { locale, t, appName, hostMessage, fontName }
}
