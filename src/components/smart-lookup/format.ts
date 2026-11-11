import { t } from '../../lib/i18n/store.svelte'
import type { TermGroup } from '../../lib/smart-search/api'

/** `{ms} 毫秒` under a second, otherwise `{s} 秒` with one decimal. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms))
  return value < 1_000
    ? t('smartSearch.enhance.durationMs', { ms: value })
    : t('smartSearch.enhance.durationSeconds', { s: (value / 1_000).toFixed(1) })
}

/** Wordings are named A, B, … in the window. */
export function wordingLetter(index: number): string {
  return String.fromCharCode(65 + index)
}

/** The words of one wording as shown on chips: words first, then quoted phrases. */
export function groupItems(group: TermGroup): string[] {
  return [...group.terms, ...group.phrases.map((phrase) => `"${phrase}"`)]
}
