import type { InsightRow } from './dashboard.svelte'

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function reportFilename(fromDay: string, toDay: string): string {
  return fromDay === toDay
    ? `stat/${fromDay}-daily-stat.md`
    : `stat/${fromDay}_${toDay}-stat.md`
}

/** Render a deterministic Chinese reading digest for the range. */
export function renderDailyReport(rows: InsightRow[], fromDay: string, toDay: string): { filename: string; markdown: string } {
  const filename = reportFilename(fromDay, toDay)
  const rangeLabel = fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`

  if (rows.length === 0) {
    return { filename, markdown: `# 阅读数据 · ${rangeLabel}\n\n此区间没有阅读或编辑记录。\n` }
  }

  const totalEngage = rows.reduce((n, r) => n + r.read_ms + r.edit_ms, 0)
  const top = [...rows].sort((a, b) => (b.read_ms + b.edit_ms) - (a.read_ms + a.edit_ms))[0]
  const totalReaders = rows.reduce((n, r) => n + r.unique_readers, 0)
  const sharedRead = rows.reduce((n, r) => n + r.aud_read_ms, 0)
  const sharedCount = rows.filter((r) => r.shared).length

  let summary = `本区间你在 ${rows.length} 篇文档上共停留 ${fmtDuration(totalEngage)}，投入最多的是《${top.label}》。`
  if (totalReaders > 0) {
    summary += ` 其中 ${sharedCount} 篇分享文档共被 ${totalReaders} 位读者阅读 ${fmtDuration(sharedRead)}。`
  }

  const header = '| 文档 | 阅读 | 编辑 | 编辑段 | 标注 | 受众时长 | 读者 | 价值 |'
  const divider = '|---|---|---|---|---|---|---|---|'
  const body = rows.map((r) =>
    `| ${r.label}${r.shared ? ' 🔗' : ''} | ${fmtDuration(r.read_ms)} | ${fmtDuration(r.edit_ms)} | ${r.edit_sessions} | ${r.mark_ops} | ${fmtDuration(r.aud_read_ms)} | ${r.unique_readers} | ${r.value.toFixed(1)} |`,
  )
  const totals = `| **合计** | ${fmtDuration(rows.reduce((n, r) => n + r.read_ms, 0))} | ${fmtDuration(rows.reduce((n, r) => n + r.edit_ms, 0))} | ${rows.reduce((n, r) => n + r.edit_sessions, 0)} | ${rows.reduce((n, r) => n + r.mark_ops, 0)} | ${fmtDuration(sharedRead)} | ${totalReaders} | |`

  const markdown = [
    `# 阅读数据 · ${rangeLabel}`, '', summary, '',
    header, divider, ...body, totals, '',
    '<sub>由 M↓ Reading Insights 生成</sub>', '',
  ].join('\n')

  return { filename, markdown }
}
