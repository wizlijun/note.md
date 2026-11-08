import { describe, expect, it } from 'vitest'
import { createI18n, normalizeLocale } from '../../../src/lib/sumi/i18n'

describe('Sumi language and host diagnostics', () => {
  it.each([
    ['zh', 'zh'], ['zh-CN', 'zh'], ['zh_TW', 'zh'], ['JA-jp', 'ja'],
    ['en-US', 'en'], ['de-DE', 'en'], ['', 'en'],
  ])('normalizes %s to %s', (input, expected) => expect(normalizeLocale(input)).toBe(expected))
  it.each([
    ['zh-CN', '墨笺', '正在等待系统钥匙串授权', '请先完成输入法组合', '字体大小或 SHA-256 校验失败'],
    ['ja-JP', 'すみ', 'キーチェーンへのアクセス許可を待っています', '入力中の変換を確定', 'フォントサイズまたは SHA-256'],
    ['en-US', 'Sumi', 'Waiting for Keychain access', 'Finish the current text composition', 'Font size or SHA-256 verification failed'],
  ])('localizes known diagnostics and retains the RPC code in %s', (locale, name, keychain, composition, fontFailure) => {
    const i18n = createI18n(locale)
    expect(i18n.appName).toBe(name)
    expect(i18n.hostMessage('正在等待系统钥匙串授权，请查看系统授权窗口；文字保存在本机')).toContain(keychain)
    expect(i18n.hostMessage(new Error('-32000: composition active'))).toContain('-32000: ')
    expect(i18n.hostMessage('-32000: composition active')).toContain(composition)
    expect(i18n.hostMessage('Font size or SHA-256 verification failed')).toContain(fontFailure)
    expect(i18n.hostMessage('此页已在另一个编辑面中打开')).toBe(i18n.locale === 'zh' ? '此页已在另一个编辑面中打开' : i18n.hostMessage('此页正在另一个编辑面中使用'))
    expect(i18n.hostMessage('')).toBe('')
  })
  it.each([
    ['zh', '离线保存中。', '操作未完成。'],
    ['ja', 'オフラインで保存中。', '操作を完了できませんでした。'],
    ['en', 'Saving offline.', 'The operation could not be completed.'],
  ])('translates known prefixes without altering unknown diagnostics in %s', (locale, offline, failed) => {
    const { hostMessage } = createI18n(locale)
    expect(hostMessage('custom status', 'status')).not.toContain(failed)
    expect(hostMessage('离线保存中：NETWORK_RESET / 原始detail')).toContain(offline)
    expect(hostMessage('离线保存中：NETWORK_RESET / 原始detail')).toContain('NETWORK_RESET / 原始detail')
    const unknown = hostMessage('-32700: E_CUSTOM / 原始detail')
    expect(unknown).toContain(failed)
    expect(unknown).toContain('-32700: ')
    expect(unknown).toContain('E_CUSTOM / 原始detail')
  })
})

describe('Sumi recovery warnings', () => {
  it.each([
    ['头部格式损坏，已将完整源文保留为正文；不会猜测或删除其中内容。', 'entire source'],
    ['源文件含 CR/CRLF；恢复前需明确同意在新纸页中规范为 LF，原文件保持不变。', 'explicit consent'],
    ['同名元数据缺失，已按页面身份、版本及全文摘要找到唯一匹配文件；恢复不会移动或删除它。', 'will not move or delete'],
    ['候选元数据搜索未能完整验证；新纸页将保留正文，行时间标为未知。', 'could not be fully verified'],
    ['存在多个匹配元数据候选，无法唯一配对；新纸页行时间将标为未知。', 'Multiple metadata candidates'],
    ['没有可验证的唯一时间快照；正文可恢复，首次/最后书写时间均标为未知，不会伪造历史。', 'no history is invented'],
  ])('retains the recovery meaning of %s in all languages', (source, expectedEnglish) => {
    expect(createI18n('zh').hostMessage(source)).toBe(source)
    expect(createI18n('en').hostMessage(source)).toContain(expectedEnglish)
    const japanese = createI18n('ja').hostMessage(source)
    expect(japanese).not.toBe(source)
    expect(japanese).not.toContain('操作を完了できませんでした。')
  })
})
