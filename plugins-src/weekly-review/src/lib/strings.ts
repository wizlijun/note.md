import { bridge } from './bridge'

export type MessageKey =
  | 'title'
  | 'thisWeek'
  | 'rebuild'
  | 'legend.review'
  | 'legend.today'
  | 'legend.past'
  | 'legend.future'
  | 'legend.diary'
  | 'legend.note'
  | 'empty.noVault'
  | 'empty.noData'
  | 'tip.review'
  | 'tip.none'
  | 'tip.future'
  | 'tip.diary'
  | 'tip.note'
  | 'month.suffix'
  | 'nav.prevYear'
  | 'nav.nextYear'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  title: 'Weekly Review',
  thisWeek: 'This week',
  rebuild: 'Rebuild',
  'legend.review': 'Has review (click to open)',
  'legend.today': 'This week',
  'legend.past': 'Past',
  'legend.future': 'Upcoming',
  'legend.diary': 'Has diary (click the number)',
  'legend.note': 'Has note (click the star)',
  'empty.noVault': 'Configure a Vault to see your weekly reviews.',
  'empty.noData': 'No weekly reviews yet. Add files to the weekly-review/ folder.',
  'tip.review': 'has review — click to open',
  'tip.none': 'no review',
  'tip.future': 'upcoming',
  'tip.diary': 'open diary',
  'tip.note': 'open note outline',
  'month.suffix': '',
  'nav.prevYear': 'previous year',
  'nav.nextYear': 'next year',
}

const zh: Catalog = {
  title: '周检视',
  thisWeek: '本周',
  rebuild: '重构',
  'legend.review': '有周报(点击打开)',
  'legend.today': '本周',
  'legend.past': '已过去',
  'legend.future': '未来',
  'legend.diary': '有日记(点数字)',
  'legend.note': '有笔记(点图标)',
  'empty.noVault': '请先配置 Vault,才能查看每周检视。',
  'empty.noData': '还没有周报。把文件放进 weekly-review/ 目录。',
  'tip.review': '有周报 · 点击打开',
  'tip.none': '无',
  'tip.future': '未来',
  'tip.diary': '打开日记',
  'tip.note': '打开笔记大纲',
  'month.suffix': '月',
  'nav.prevYear': '上一年',
  'nav.nextYear': '下一年',
}

const ja: Catalog = {
  title: 'ウィークリーレビュー',
  thisWeek: '今週',
  rebuild: '再構築',
  'legend.review': 'レビューあり(クリックで開く)',
  'legend.today': '今週',
  'legend.past': '過去',
  'legend.future': '今後',
  'legend.diary': '日記あり(数字をクリック)',
  'legend.note': 'ノートあり(星をクリック)',
  'empty.noVault': 'Vault を設定するとレビューが表示されます。',
  'empty.noData': 'まだレビューがありません。weekly-review/ に追加してください。',
  'tip.review': 'レビューあり · クリックで開く',
  'tip.none': 'なし',
  'tip.future': '今後',
  'tip.diary': '日記を開く',
  'tip.note': 'ノートの概要を開く',
  'month.suffix': '月',
  'nav.prevYear': '前年',
  'nav.nextYear': '翌年',
}

const de: Catalog = {
  title: 'Wochenrückblick',
  thisWeek: 'Diese Woche',
  rebuild: 'Neu aufbauen',
  'legend.review': 'Rückblick vorhanden (zum Öffnen klicken)',
  'legend.today': 'Diese Woche',
  'legend.past': 'Vergangen',
  'legend.future': 'Bevorstehend',
  'legend.diary': 'Tagebuch (Zahl anklicken)',
  'legend.note': 'Notiz (Stern anklicken)',
  'empty.noVault': 'Konfiguriere ein Vault, um deine Rückblicke zu sehen.',
  'empty.noData': 'Noch keine Rückblicke. Lege Dateien im Ordner weekly-review/ ab.',
  'tip.review': 'Rückblick vorhanden · zum Öffnen klicken',
  'tip.none': 'keiner',
  'tip.future': 'bevorstehend',
  'tip.diary': 'Tagebuch öffnen',
  'tip.note': 'Notiz-Gliederung öffnen',
  'month.suffix': '',
  'nav.prevYear': 'Vorheriges Jahr',
  'nav.nextYear': 'Nächstes Jahr',
}

const catalogs: Record<string, Catalog> = { en, zh, ja, de }

export function t(key: MessageKey): string {
  const loc = (() => {
    try {
      return bridge().locale
    } catch {
      return 'en'
    }
  })()
  const cat = catalogs[loc] ?? en
  return cat[key] ?? en[key]
}
