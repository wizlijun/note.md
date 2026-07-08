import type { Messages } from './en'

// Japanese catalog. Typed as a full record so a missing key is a compile
// error — keep it complete and in sync with `en.ts`.
export const ja: Record<keyof Messages, string> = {
  // Generic / shared
  'common.cancel': 'キャンセル',
  'common.ok': 'OK',
  'common.close': '閉じる',
  'common.dismiss': '閉じる',
  'common.saveAs': '名前を付けて保存…',

  // Settings
  'settings.language': '言語',

  // CLI (`mdedit`) install/uninstall
  'cli.installTitle': "'mdedit' コマンドをインストール",
  'cli.installPrompt':
    "'mdedit' コマンドを PATH にインストールしますか？\n\n" +
    'インストールすると、任意のターミナルやスクリプトから M↓ の機能を呼び出せます：\n' +
    '  • mdedit -s draft.md   Share プラグインで公開して URL を表示\n' +
    '  • mdedit help          すべてのコマンドを表示\n' +
    '  • mdedit plugin list   プラグイン一覧\n\n' +
    "この設定は Help → Install/Uninstall 'mdedit' Command からいつでも管理できます。",
  'cli.installInto': "'mdedit' を {dir} にインストールしますか？",
  'cli.installed': "'mdedit' を {dir} にインストールしました",
  'cli.installFailed': 'インストールに失敗しました：{error}',
  'cli.uninstalled': "{dir} から 'mdedit' をアンインストールしました",
  'cli.uninstallFailed': 'アンインストールに失敗しました：{error}',
  'cli.notInstalled': "'mdedit' はインストールされていません",

  // Share
  'share.docTooLarge': '❌ {name}：ドキュメントが大きすぎます（{mb} MB / 上限 25 MB）',
  'share.internalError': '❌ {name}：内部エラー',
  'share.errPrefix': '❌ Share：{msg}',
  'share.actionFailed': '❌ Share：{action}に失敗しました',
  'share.action.share': '共有',
  'share.action.unpublish': '共有の取り消し',
  'share.action.copyLink': 'リンクのコピー',
  'share.imageUpdated': '✅ 画像を更新しました（コピー済み）',
  'share.imageShared': '✅ 画像を共有しました（コピー済み）',
  'share.contentUpdated': '✅ 内容を更新しました（リンクをコピー済み）',
  'share.shared': '✅ 共有しました（コピー済み）',
  'share.unpublished': '✅ 共有を取り消しました',
  'share.linkCopied': '✅ リンクをコピーしました',
  'share.err.not_configured': '先に Preferences → Share で Service URL と API Key を設定してください',
  'share.err.no_path': '先にファイルを保存してください',
  'share.err.empty_content': '内容が空です',
  'share.err.network': 'ネットワークエラーです。接続を確認してください',
  'share.err.auth': 'API key が無効です。Preferences を確認してください',
  'share.err.forbidden': 'この共有を取り消す権限がありません',
  'share.err.too_large': 'ドキュメントが大きすぎます（上限 25 MB）',
  'share.err.conflict': 'slug が競合しています。後で再試行してください',
  'share.err.unsupported': 'サポートされていない画像形式です',
  'share.err.server': 'サーバーが混雑しています。後で再試行してください',
  'share.err.http': 'リクエストに失敗しました',
  'share.err.parse': 'サーバー応答の解析に失敗しました',
  'share.err.corrupt_record': 'ローカルの共有記録が壊れています',

  // Source-of-truth Vault (sotvault)
  'sotvault.revealFailed': '❌ ソースフォルダを開けませんでした',
  'sotvault.saveFirst': 'Vault に同期する前にファイルを保存してください',
  'sotvault.synced': '✓ Vault に同期しました',
  'sotvault.syncFailed': '❌ Vault への同期に失敗しました',
  'sotvault.sourceMovedOrDeleted': '⚠️ Vault：ソースファイルが移動または削除されたため、更新を確認できません',
  'sotvault.askLocalChanged': 'このファイルは Vault に同期済みで、前回の同期後に変更されています。今すぐ Vault に同期しますか？',
  'sotvault.askSourceUpdated': 'ソースファイルが更新されました。Vault に同期しますか？',
  'sotvault.syncTitle': 'Vault に同期',
  'sotvault.conflictTitle': 'Vault の競合',
  'sotvault.conflictOverwrite': 'ソースと Vault のコピーの両方が変更されています（競合）。ソースで Vault のコピーを上書きしますか？',
  'sotvault.conflictKeep': 'Vault の現在の内容を保持し、このファイルの更新通知を停止しますか？',
  'sotvault.updatedFromSource': '✓ ソースから Vault のコピーを更新しました',
  'sotvault.updateFailed': '❌ Vault のコピーの更新に失敗しました',

  // Vault settings tab
  'vault.connected': '✓ Vault に接続し、リポジトリをクローンしました',
  'vault.err.keychain': '❌ Vault 接続失敗：Keychain ブリッジが未準備です（Keychain.swift が Xcode ターゲットに未追加）',
  'vault.err.authConnect': '❌ Vault 接続失敗：PAT 認証に失敗しました。トークンに contents:read/write 権限があるか確認してください',
  'vault.err.notFoundConnect': '❌ Vault 接続失敗：リポジトリが存在しないか、PAT にアクセス権がありません',
  'vault.err.networkConnect': '❌ Vault 接続失敗：ネットワークエラー',
  'vault.err.generic': '❌ Vault 接続失敗：{error}',
  'vault.disconnectConfirm': 'Vault を切断すると、ローカルの Vault コピーと Keychain 内の PAT が削除されます。リモートリポジトリには影響しません。続行しますか？',
  'vault.disconnectTitle': 'Vault を切断',
  'vault.disconnected': '✓ Vault を切断しました',
  'vault.disconnectFailed': '❌ 切断に失敗しました：{error}',
  'vault.statusLabel': 'ステータス：',
  'vault.syncing': '同期中…',
  'vault.cloning': 'クローン中…',
  'vault.lastSync': '✓ 前回の同期：{time}',
  'vault.unknownError': '不明なエラー',
  'vault.hasConflicts': '⚠️ 競合ファイルがあります',
  'vault.notConfigured': '未設定',
  'vault.syncNow': '今すぐ同期',
  'vault.disconnect': 'Vault を切断',
  'vault.remoteUrl': 'リモート URL',
  'vault.branch': 'ブランチ',
  'vault.pat': '個人アクセストークン',
  'vault.patConfigured': '✓ 設定済み',
  'vault.patUpdate': '更新…',
  'vault.howToToken': '📖 トークンの生成方法',
  'vault.authorName': '作成者名',
  'vault.authorEmail': '作成者メール',
  'vault.saving': '保存中…',
  'vault.saveConfig': '設定を保存',
  'vault.filesWarning': '⚠️ Files App 内で Documents/Vault/ ディレクトリを変更・削除しないでください。同期状態が壊れます。',

  // Vault sync
  'vault.syncedWithConflicts': '⚠️ Vault：同期完了。一部のローカル変更は .conflict コピーとして保持されました',
  'vault.syncComplete': '✓ Vault の同期が完了しました',
  'vault.authFailed': '❌ Vault：認証に失敗しました。Vault 設定で PAT を更新してください',
  'vault.networkError': '❌ Vault：ネットワークエラー',
  'vault.repoNotFound': '❌ Vault：リポジトリが存在しないか、PAT にアクセス権がありません',
  'vault.mergeFailed': '⚠️ Vault：自動マージに失敗しました。今回はスキップし、次回再試行します',

  // Plugin host
  'host.startFailed': '❌ {name}：起動に失敗しました',
  'host.noResponse': '{name}：応答なし（{seconds}s）',
  'host.abnormalExit': '❌ {name}：異常終了（code {code}）',
  'host.protocolEmpty': '❌ {name}：プロトコルエラー（空の応答）',
  'host.protocolError': '❌ {name}：プロトコルエラー',

  // Print
  'print.nothingToPrint': '印刷する内容がありません',
  'print.renderFailed': '印刷のレンダリングに失敗しました',

  // Slash menu items
  'slash.filter.images': '画像',
  'slash.filter.docs': 'ドキュメントとファイル',
  'slash.image.label': '画像を挿入…',
  'slash.image.desc': 'ローカルから画像ファイルを選択',
  'slash.doc.label': 'ドキュメントを挿入…',
  'slash.doc.desc': '添付リンクとしてファイルを選択',
  'slash.h1.label': '見出し 1',
  'slash.h1.desc': '最上位の見出し',
  'slash.h2.label': '見出し 2',
  'slash.h2.desc': '第2レベルの見出し',
  'slash.h3.label': '見出し 3',
  'slash.h3.desc': '第3レベルの見出し',
  'slash.quote.label': '引用',
  'slash.quote.desc': '引用ブロック',
  'slash.code.label': 'コードブロック',
  'slash.code.desc': 'シンタックスハイライト付きコードブロック',
  'slash.mermaid.label': 'Mermaid 図',
  'slash.mermaid.desc': 'フローチャート、シーケンス、ガント…',
  'slash.math.label': '数式',
  'slash.math.desc': 'LaTeX 数式ブロック',
  'slash.table.label': '表',
  'slash.table.desc': '3×3 の編集可能な表',
  'slash.spreadsheet.label': 'スプレッドシート',
  'slash.spreadsheet.desc': '編集可能なスプレッドシート（数式対応）',
  'slash.bullet.label': '箇条書きリスト',
  'slash.bullet.desc': '順序なしリスト',
  'slash.ordered.label': '番号付きリスト',
  'slash.ordered.desc': '順序付きリスト',
  'slash.task.label': 'タスクリスト',
  'slash.task.desc': 'チェックリスト / ToDo',
  'slash.hr.label': '区切り線',
  'slash.hr.desc': '水平線',

  // Editor mode toggle
  'mode.editorMode': 'エディターモード',
  'mode.previewRich': 'プレビュー（リッチ）',
  'mode.source': 'ソース（Cmd+/）',

  // Mobile toolbar
  'toolbar.openMenu': 'メニューを開く',
  'toolbar.toggleMode': 'ソース/リッチを切り替え',
  'toolbar.more': 'その他',
  'toolbar.save': '保存',
  'toolbar.saveAs': '名前を付けて保存…',
  'toolbar.share': '共有',
  'toolbar.settings': '設定',

  // HTML preview
  'htmlPreview.title': 'HTML プレビュー',

  // Drawer / tab bar
  'drawer.closeMenu': 'メニューを閉じる',
  'tabBar.modified': '変更あり',

  // Plugins settings
  'plugins.restartNote': '変更は M↓ を再起動すると有効になります',
  'plugins.capabilities': '機能：{caps}',
  'plugins.none': 'プラグインが検出されませんでした。',
  'plugins.needsVault': '有効にするには先に Vault を設定してください',

  // Slash menu (empty state)
  'slashMenu.noMatches': '一致なし',

  // Find / replace
  'findReplace.find': '検索',
  'findReplace.matchCase': '大文字小文字を区別',
  'findReplace.wholeWord': '単語単位',
  'findReplace.regex': '正規表現',
  'findReplace.previous': '前へ',
  'findReplace.next': '次へ',
  'findReplace.replaceWith': '置換後…',
  'findReplace.replace': '置換',
  'findReplace.replaceAll': 'すべて置換',
  'findReplace.replaceToggle': '置換 ▾',

  // Spreadsheet context menu
  'spreadsheet.insertRowAbove': '上に行を挿入',
  'spreadsheet.insertRowBelow': '下に行を挿入',
  'spreadsheet.deleteRow': 'この行を削除',
  'spreadsheet.insertColLeft': '左に列を挿入',
  'spreadsheet.insertColRight': '右に列を挿入',
  'spreadsheet.deleteCol': 'この列を削除',
  'spreadsheet.clearSelection': '選択をクリア',

  // Image toolbar
  'imageToolbar.original': '原寸',
  'imageToolbar.originalSize': '原寸大',

  // Citations (block references)
  'citation.notFound': '引用が見つかりません',
  'citation.here': 'ここ',
  'citation.sameDoc': '同じドキュメント',
  'citation.jumpTitle': '{target} #{blockid} へ移動',
  'citation.blockDeleted': '元のブロックは削除されました（generation {gen}）',
  'citation.blockEdited': '元のブロックは編集されました。現在の継承ブロック {id} へ移動しました',
  'citation.noBlockIds': '対象ドキュメントに block id がありません（キャッシュに yaml がありません。先に Compute Blocks を実行してください）',

  // Plugin action failure
  'pluginAction.failed': '{name}：{type} に失敗しました',

  // Settings → Software update
  'settings.update.heading': 'ソフトウェア更新',
  'settings.update.upToDate': '最新です。',
  'settings.update.foundNew': '新しいバージョン v{version} が見つかりました',
  'settings.update.currentVersionLabel': '現在のバージョン：',
  'settings.update.lastChecked': '最終確認：{time}',
  'settings.update.autoCheck': '起動時に自動で更新を確認する（20時間ごと）',
  'settings.update.checking': '確認中…',
  'settings.update.checkNow': '今すぐ更新を確認',
  'settings.update.downloadInstall': 'v{version} をダウンロードしてインストール',
  'settings.update.restartNow': '今すぐ再起動して更新を完了',
  'settings.update.downloading': 'ダウンロード中：',
  'settings.update.notes': 'v{version} のリリースノート',
  'settings.update.distNote': '更新は GitHub Releases 経由で配布され、インストール前に組み込みの公開鍵で署名を検証します。署名済みのパッケージのみが .app に置き換えられます。',

  // Vault browser
  'vaultBrowser.syncNow': '今すぐ同期',
  'vaultBrowser.notConfigured': 'Vault が未設定です。',
  'vaultBrowser.goConfigure': 'Settings → Vault でリポジトリを設定してください。',
  'vaultBrowser.up': '‹ 上へ',
  'vaultBrowser.empty': 'Vault は空です',

  // Empty state
  'emptyState.hint': '.md ファイルをドロップ、または',
  'emptyState.new': '新規（⌘N）',
  'emptyState.open': '開く…（⌘O）',

  // Toast
  'toast.showDetails': '詳細を表示',
  'toast.collapse': '折りたたむ',
  'toast.details': '詳細',
  'toast.autoClose': '自動で閉じる',

  // Synced-from-source banner
  'syncOrigin.synced': '📎 ソースから同期済み：',
  'syncOrigin.revealTitle': 'ソースの場所を表示',
  'syncOrigin.openSourceDir': 'ソースフォルダを開く',

  // External-change banner
  'externalChange.modified': '「{title}」は別のアプリケーションによって変更されました。',
  'externalChange.deleted': '「{title}」はディスク上で削除されました。',
  'externalChange.reload': 'ディスクから再読み込み',
  'externalChange.overwrite': '自分の変更で上書き',
  'externalChange.recreate': '保存時に再作成（⌘S）',
  'externalChange.closeTab': 'タブを閉じる',

  // Sync-to-Vault offer banner
  'syncToVault.offer': '💡 このファイルは Vault の外にあります。Vault に同期すると、Vault にコピーが保存され、git で自動バックアップ・複数デバイスで同期され、ソース更新時にワンクリックで更新できます。',
  'syncToVault.sync': 'Vault に同期',

  // Update dialog
  'updateDialog.checking': '更新を確認中…',
  'updateDialog.currentVersion': '現在のバージョン：v{version}',
  'updateDialog.available': 'M↓ {version} が利用可能',
  'updateDialog.whatsNew': '新機能',
  'updateDialog.noNotes': 'リリースノートはありません。',
  'updateDialog.skip': 'このバージョンをスキップ',
  'updateDialog.later': '後で',
  'updateDialog.updateNow': '今すぐ更新',
  'updateDialog.downloading': '{version} をダウンロード中…',
  'updateDialog.runInBackground': 'バックグラウンドで実行',
  'updateDialog.ready': '準備完了',
  'updateDialog.readyBody': 'M↓ {version} をダウンロードしました。アプリを再起動すると更新が完了します。',
  'updateDialog.restartLater': '後で再起動',
  'updateDialog.restartNow': '今すぐ再起動',
  'updateDialog.error': '更新エラー',
  'updateDialog.unknownError': '不明なエラー',
  'updateDialog.upToDate': 'M↓ は最新です',

  // Update banner
  'updateBanner.available': '✨ M↓ {version} が利用可能',
  'updateBanner.viewDetails': '詳細を表示',
  'updateBanner.downloading': '{version} をダウンロード中…',
  'updateBanner.showProgress': '進捗を表示',
  'updateBanner.ready': '✅ {version} をダウンロードしました — 再起動で更新完了',
  'updateBanner.restart': '再起動…',

  // Relative time
  'time.never': 'なし',
  'time.justNow': 'たった今',
  'time.minutesAgo': '{n} 分前',
  'time.hoursAgo': '{n} 時間前',
  'time.daysAgo': '{n} 日前',

  // Folder view
  'folderView.parentFolder': '親フォルダ',
  'folderView.find': '検索',
  'folderView.refresh': '更新',
  'folderView.hide': 'フォルダビューを隠す',
  'folderView.clearFilter': 'フィルターをクリア',
  'folderView.filterPlaceholder': 'フィルター（正規表現）…',
  'folderView.noMatches': '一致なし',
  'folderView.emptyFolder': '空のフォルダ',
  'folderView.noFolder': 'フォルダなし',
  'folderView.reveal': 'Finder で表示',

  // OpenClaw settings + devices
  'openclaw.heading': 'OpenClaw',
  'openclaw.connectMode': '接続モード',
  'openclaw.autoDetect': '自動検出',
  'openclaw.modeHost': 'ホスト（ローカル UDS）',
  'openclaw.modeRemote': 'リモート（mdrelay 経由）',
  'openclaw.socketPath': 'ソケットパス',
  'openclaw.accessToken': 'アクセストークン',
  'openclaw.runToGenerate': "'mdedit openclaw install' を実行して生成",
  'openclaw.hide': '非表示',
  'openclaw.show': '表示',
  'openclaw.copy': 'コピー',
  'openclaw.copied': '✓ コピーしました',
  'openclaw.copyFailed': 'コピー失敗',
  'openclaw.relayUrl': 'リレー URL',
  'openclaw.autoSync': 'チャットリンクを解決する前に自動同期',
  'openclaw.devices': 'デバイス',
  'openclaw.hostname': 'ホスト名',
  'openclaw.lastSeen': '最終接続',
  'openclaw.revoke': '取り消し',
  'openclaw.forget': '削除',
  'openclaw.noPairedDevices': 'ペアリング済みデバイスはまだありません。',
  'openclaw.addDevice': '+ デバイスを追加',

  // Theme import dialog
  'themeImport.title': 'Typora テーマをインポート',
  'themeImport.noneFound': 'この zip に Typora テーマが見つかりません。',
  'themeImport.detected': '{count} 個のテーマを検出：',
  'themeImport.willOverwrite': '⚠ 既存を上書きします',
  'themeImport.assetFolders': 'アセットフォルダ：',
  'themeImport.errors': 'エラー：',
  'themeImport.overwriteExisting': '既存のテーマを上書き',
  'themeImport.importing': 'インポート中…',
  'themeImport.import': 'インポート',

  // Chat / pairing
  'chat.connectTitle': 'OpenClaw に接続',
  'chat.enterPairingCode': 'ホストマシンの M↓ 設定に表示されるペアリングコードを入力してください。',
  'chat.pairingCode': 'ペアリングコード',
  'chat.deviceNameOptional': 'デバイス名（任意）',
  'chat.connecting': '接続中…',
  'chat.pair': 'ペアリング',
  'chat.addDevice': '新しいデバイスを追加',
  'chat.retry': '再試行',
  'chat.generatingCode': 'ペアリングコードを生成中…',
  'chat.expiresIn': '{time} で期限切れ',
  'chat.typeToOpenClaw': 'OpenClaw に入力…',
  'chat.send': '送信',

  // Settings dialog — header & tabs
  'settings.title': '環境設定',
  'settings.done': '完了',
  'settings.tab.plugins': 'プラグイン',
  'settings.tab.core': 'コア',
  'settings.tab.block': 'ブロック',
  'settings.tab.cli': 'CLI',
  'settings.tab.updates': '更新',
  'settings.tab.vault': 'Vault',
  'settings.tab.openclaw': 'OpenClaw',

  // Settings → Themes
  'settings.themes': 'テーマ',
  'settings.lightTheme': 'ライトテーマ',
  'settings.darkTheme': 'ダークテーマ',
  'settings.alwaysLight': '常にライトテーマを使用（システム外観を無視）',
  'settings.importTypora': 'Typora テーマをインポート…',
  'settings.revealThemes': 'テーマフォルダを表示',
  'settings.reloadThemes': 'テーマを再読み込み',
  'settings.restoreBuiltins': '組み込みテーマを復元',
  'settings.themesLoadFailed': 'テーマの読み込みに失敗：{error}',
  'settings.autoSaveLabel': '自動保存を有効化（800ms アイドル後に書き込み）',

  // Settings → Default app
  'settings.defaultApp.heading': 'テキスト・コードファイルの既定アプリ',
  'settings.defaultApp.desc1': 'M↓ をテキストおよびソースコードファイルを開く macOS の既定アプリケーションにします。設定すると、Finder でサポート対象のファイルをダブルクリック（または <em>このアプリケーションで開く…</em> を選択）すると M↓ が起動します。',
  'settings.defaultApp.desc2': 'これは <strong>{groups}</strong> カテゴリにわたる <strong>{exts}</strong> 個のファイル拡張子に影響します。すべての変更は macOS Launch Services を通るため、システム・Finder・他のアプリが即座に反映します。',
  'settings.defaultApp.showTypes': '影響するファイルタイプを表示（{count} 個の拡張子）',
  'settings.defaultApp.setting': '設定中…',
  'settings.defaultApp.setDefault': 'M↓ を全 {count} タイプの既定に設定',
  'settings.defaultApp.undoNote': '<strong>1 つのファイルタイプを元に戻すには：</strong>Finder でファイルを選択 → ファイルメニュー → <em>情報を見る</em> → <em>このアプリケーションで開く</em> → 別のアプリを選択 → <em>すべてを変更…</em> をクリック。macOS では一括で元に戻す方法がないため、上のボタンを押す前に確認してください。',
  'settings.defaultApp.resultOk': '完了 — M↓ が全 {count} 個の拡張子の既定になりました。',
  'settings.defaultApp.resultPartial': '{ok}/{total} 個の拡張子を設定しました。失敗：{failed}（macOS にこれらの UTI が登録されていない可能性があります — 明示的に起動すれば M↓ で開きます）。',
  'settings.defaultApp.resultError': 'エラー：{error}',

  // Settings → Block IDs
  'settings.block.enable': 'ブロック ID を有効化（mdblock）',
  'settings.block.enableDesc': 'markdown ドキュメント内の各ブロックに安定した id を割り当て、AI ツールがサブページ精度で文章を引用できるようにします。ドキュメントで <strong>Compute Blocks</strong> を実行して有効化します。',
  'settings.block.savingDesc': '<strong>.md ファイルを保存</strong>すると、対応する <code>.block.yaml</code> がキャッシュに自動保存されます。編集中はブロックマーカーがメモリ内でリアルタイムに更新され、ファイル書き込みは保存時に行われます。',
  'settings.block.injectHint': '<code>.block.md</code> に AI 使用ヒントを挿入',

  // Settings → Chunking
  'settings.chunk.heading': 'チャンク戦略',
  'settings.chunk.strategy': '戦略',
  'settings.chunk.sectionFirst': 'セクション優先（見出しで分割・推奨）',
  'settings.chunk.sizeFirst': 'サイズ優先（qmd 方式・構造上どこでも分割）',
  'settings.chunk.sectionDesc': '<strong>セクション優先</strong>は既定で H2 境界で分割し、大きすぎるセクションはより深い見出しで分割、小さすぎるセクションは隣と結合します。各ブロックは自己完結した意味単位（1 章／サブセクション）を保ち、選択して LLM に送り推敲させるのに最適です。',
  'settings.chunk.sectionCutLevel': 'セクション分割レベル',
  'settings.chunk.h1opt': 'H1（最上位の章ごとに 1 ブロック）',
  'settings.chunk.h2opt': 'H2（章ごとに 1 ブロック・既定）',
  'settings.chunk.h3opt': 'H3（サブセクションごとに 1 ブロック）',
  'settings.chunk.minChars': 'セクション最小文字数（未満は結合）',
  'settings.chunk.maxChars': 'ブロックあたりの最大文字数',
  'settings.chunk.maxCharsDesc': 'セクション優先：大きすぎるセクションはより深い見出しで分割されます（最終手段としてサイズで分割）。サイズ優先：これはチャンクごとの目標です。',
  'settings.chunk.similarity': '類似度しきい値（id の安定性）',
  'settings.chunk.affectNote': '⚠ 戦略／最大／最小の変更は<strong>新規</strong>ドキュメントに影響します。既存の <code>.block.yaml</code> は <strong>Reset Block Lineage</strong> を実行するまで独自の設定を保持します。',

  // Settings → Visualization
  'settings.viz.heading': '可視化',
  'settings.viz.desc': 'ブロック ID を有効にすると、ドキュメントを開くたびにキャッシュされた yaml が自動的に読み込まれマーカーが表示されます — 手動の「表示」切り替えは不要です。下のチェックボックスで各ビューを個別に無効化できます。',
  'settings.viz.sourceMarkers': 'ソースモードのマーカー（行番号の余白）',
  'settings.viz.richGutter': 'リッチモードの左余白（ブロックマーカー + バー）',

  // Settings → CLI
  'settings.cli.heading': 'CLI',
  'settings.cli.desc': '<code>mdedit</code> コマンドを使うと、ターミナルや他のツールから M↓ を操作できます — Share プラグインでファイルを公開したり、利用可能なコマンドを一覧表示したりできます。',
  'settings.cli.loading': '読み込み中…',
  'settings.cli.installedAtLabel': 'インストール先：',
  'settings.cli.symlinkMismatch': 'シンボリックリンクが別のバイナリを指しています — 再インストールで修復してください。',
  'settings.cli.working': '処理中…',
  'settings.cli.reinstall': '再インストール…',
  'settings.cli.uninstall': 'アンインストール',
  'settings.cli.notInstalled': '未インストール。',
  'settings.cli.installing': 'インストール中…',
  'settings.cli.install': 'インストール…',
  'settings.cli.error': 'エラー：{error}',
  'settings.cli.helpDesc': 'インストール後、ターミナルで <code>mdedit help</code> を実行すると完全なリファレンスが表示されます。CLI は<em>有効な</em>プラグインが提供するコマンドのみを公開します — 上の Plugins でプラグインを無効にすると、そのサブコマンドが <code>mdedit</code> から削除されます。',
}
