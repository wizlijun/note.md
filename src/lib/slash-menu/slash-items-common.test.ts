/** @vitest-environment happy-dom */
import { expect, it } from 'vitest'
import { getCommonSlashItems, getShareSlashItems, filterSlashItems } from './slash-items-common'
import { getSlashItems } from './slash-items'
import { i18n } from '../i18n/runtime.svelte'
it('preserves desktop ordering/translated common entries and explicit browser capabilities', () => {
  const ids = ['insert-note','highlight','wikilink','insert-image','insert-doc','h1','h2','h3','quote','code','mermaid','math','table','spreadsheet','bullet','ordered','task','hr']
  for (const locale of ['en', 'zh', 'ja', 'de'] as const) {
    i18n.locale = locale
    expect(getSlashItems().map(i => i.id)).toEqual(ids)
    const common = getCommonSlashItems()
    expect(getSlashItems().filter(i => !['insert-image', 'insert-doc'].includes(i.id)).map(({ execute, ...item }) => item)).toEqual(common.map(({ execute, ...item }) => item))
    expect(getShareSlashItems().some(i => ['insert-image', 'insert-doc', 'spreadsheet', 'ai', 'search'].includes(i.id))).toBe(false)
    expect(filterSlashItems('h1', getShareSlashItems()).map(i => i.id)).toContain('h1')
  }
  i18n.locale = 'en'
})
