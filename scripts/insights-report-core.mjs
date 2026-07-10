export function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(.+)\.json$/

/** files: [{ name, json }] → docKey -> day -> summed counters (across devices). */
export function mergeFiles(files) {
  const out = {}
  for (const f of files) {
    const m = FILE_RE.exec(f.name)
    if (!m || !f.json || !f.json.docs) continue
    const day = m[1]
    for (const [docKey, c] of Object.entries(f.json.docs)) {
      const perDoc = (out[docKey] ??= {})
      const b = (perDoc[day] ??= { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 0 })
      b.read_ms += c.read_ms || 0
      b.edit_ms += c.edit_ms || 0
      b.edit_sessions += c.edit_sessions || 0
      b.mark_ops += c.mark_ops || 0
      b.net_chars += c.net_chars || 0
      b.open_count += c.open_count || 0
    }
  }
  return out
}

/** Sum each doc over the inclusive [from,to] day range (lexicographic). */
export function aggregate(merged, fromDay, toDay) {
  const out = {}
  for (const [docKey, days] of Object.entries(merged)) {
    let acc = null
    for (const [day, c] of Object.entries(days)) {
      if (day < fromDay || day > toDay) continue
      if (!acc) acc = { read_ms: 0, edit_ms: 0, edit_sessions: 0, mark_ops: 0, net_chars: 0, open_count: 0 }
      for (const k of Object.keys(acc)) acc[k] += c[k] || 0
    }
    if (acc) out[docKey] = acc
  }
  return out
}

function label(docKey) {
  const p = docKey.replace(/^(rel:|abs:)/, '')
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

export function renderOwnerDigest(agg, fromDay, toDay) {
  const rangeLabel = fromDay === toDay ? fromDay : `${fromDay} → ${toDay}`
  const rows = Object.entries(agg).map(([docKey, c]) => ({ label: label(docKey), ...c }))
    .sort((a, b) => (b.read_ms + b.edit_ms) - (a.read_ms + a.edit_ms))
  if (rows.length === 0) return `# 阅读数据 · ${rangeLabel}\n\n此区间没有阅读或编辑记录。\n`
  const totalEngage = rows.reduce((n, r) => n + r.read_ms + r.edit_ms, 0)
  const summary = `本区间你在 ${rows.length} 篇文档上共停留 ${fmtDuration(totalEngage)}，投入最多的是《${rows[0].label}》。`
  const header = '| 文档 | 阅读 | 编辑 | 编辑段 | 标注 |'
  const divider = '|---|---|---|---|---|'
  const body = rows.map((r) => `| ${r.label} | ${fmtDuration(r.read_ms)} | ${fmtDuration(r.edit_ms)} | ${r.edit_sessions} | ${r.mark_ops} |`)
  const totals = `| **合计** | ${fmtDuration(rows.reduce((n, r) => n + r.read_ms, 0))} | ${fmtDuration(rows.reduce((n, r) => n + r.edit_ms, 0))} | ${rows.reduce((n, r) => n + r.edit_sessions, 0)} | ${rows.reduce((n, r) => n + r.mark_ops, 0)} |`
  return [`# 阅读数据 · ${rangeLabel}`, '', summary, '', header, divider, ...body, totals, '', '<sub>由 note.md Reading Insights CLI 生成</sub>', ''].join('\n')
}

function dayKey(ms, tz) {
  const d = new Date(ms + tz * 60000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
function addDays(day, delta) { return new Date(Date.parse(day + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10) }

/** preset: today|yesterday|7d|30d|month → { from, to } */
export function resolvePreset(preset, now, tz) {
  const today = dayKey(now, tz)
  switch (preset) {
    case 'today': return { from: today, to: today }
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y } }
    case '7d': return { from: addDays(today, -6), to: today }
    case '30d': return { from: addDays(today, -29), to: today }
    case 'month': return { from: today.slice(0, 8) + '01', to: today }
    default: return { from: today, to: today }
  }
}
