import { vaultRead, vaultWrite, vaultExists, vaultList } from './bridge'
import { serializeBoard, parseBoard, serializeArchive, parseArchive } from './board-io'
import { parseCandidateFile, type CandidateFile } from './candidate'
import { markConsumed } from './edits'
import { appendEvent, parseLog } from './scoreboard'
import type { OpenDecision, ArchivedDecision, ScoreEvent } from './model'

const DIR = 'decision'
const BOARD = `${DIR}/open.decision.note.md`
const SCORE = `${DIR}/_scoreboard.jsonl`
const archivePath = (resolved: string) => `${DIR}/archive/${resolved}-decision.note.md`
const candidatePath = (date: string) => `diary/${date}-decision.json`

export async function loadBoard(): Promise<OpenDecision[]> {
  if (!(await vaultExists(BOARD)).exists) return []
  return parseBoard((await vaultRead(BOARD)).content)
}
export async function saveBoard(open: OpenDecision[]): Promise<void> {
  await vaultWrite(BOARD, serializeBoard(open))
}
export async function appendArchive(resolved: string, dec: ArchivedDecision): Promise<void> {
  const p = archivePath(resolved)
  const existing = (await vaultExists(p)).exists ? parseArchive((await vaultRead(p)).content) : []
  await vaultWrite(p, serializeArchive(resolved, [...existing, dec]))
}
export async function appendScore(ev: ScoreEvent): Promise<void> {
  const log = (await vaultExists(SCORE)).exists ? (await vaultRead(SCORE)).content : ''
  await vaultWrite(SCORE, appendEvent(log, ev))
}
export async function loadScore(): Promise<ScoreEvent[]> {
  if (!(await vaultExists(SCORE)).exists) return []
  return parseLog((await vaultRead(SCORE)).content)
}
/** 扫 decision/archive/ 下最近若干归档文件,返回展平后的归档记录(按裁决日期降序,最新在前)。 */
export async function loadArchives(limit = 5): Promise<ArchivedDecision[]> {
  const dir = `${DIR}/archive`
  if (!(await vaultExists(dir)).exists) return []
  const entries = (await vaultList(dir)).entries
  const files = entries
    .filter((e) => !e.is_dir && /-decision\.note\.md$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse()
    .slice(0, limit)
  const out: ArchivedDecision[] = []
  for (const name of files) {
    try { out.push(...parseArchive((await vaultRead(`${dir}/${name}`)).content)) } catch { /* skip malformed */ }
  }
  return out
}
/** 在 decision/archive/ 下找到含指定 id 的归档文件,移除该条并写回,返回被移除的记录。
 *  找不到 → 返回 null(不写盘)。用于「重开」:把归档决策捞回未决。 */
export async function removeArchived(id: string): Promise<ArchivedDecision | null> {
  const dir = `${DIR}/archive`
  if (!(await vaultExists(dir)).exists) return null
  const entries = (await vaultList(dir)).entries
  const files = entries.filter((e) => !e.is_dir && /-decision\.note\.md$/.test(e.name)).map((e) => e.name)
  for (const name of files) {
    const p = `${dir}/${name}`
    let decs: ArchivedDecision[]
    try { decs = parseArchive((await vaultRead(p)).content) } catch { continue }
    const found = decs.find((d) => d.id === id)
    if (!found) continue
    const remaining = decs.filter((d) => d.id !== id)
    // 归档文件名形如 <resolved>-decision.note.md;取前缀作 resolved 传给序列化。
    const resolved = name.replace(/-decision\.note\.md$/, '')
    await vaultWrite(p, serializeArchive(resolved, remaining))
    return found
  }
  return null
}
/** 读 diary/<date>-decision.json,把匹配的首条 pending 项标为 accepted/dismissed,写回。文件不存在则 no-op。 */
export async function consumeDiaryItem(
  date: string,
  array: 'new_candidates' | 'closures' | 'edit_decisions',
  key: string,
  status: 'accepted' | 'dismissed',
): Promise<void> {
  const p = candidatePath(date)
  if (!(await vaultExists(p)).exists) return
  const json = (await vaultRead(p)).content
  const next = markConsumed(json, array, key, status)
  if (next !== json) await vaultWrite(p, next)
}

/** 扫 diary/ 下所有 *-decision.json,返回按日期排序的候选文件。
 *  fileDate 从文件名中提取(YYYY-MM-DD),与文件内 date 字段无关,确保 consume 定位正确。 */
export async function loadCandidates(): Promise<CandidateFile[]> {
  if (!(await vaultExists('diary')).exists) return []
  const entries = (await vaultList('diary')).entries
  const files = entries.filter((e) => !e.is_dir && /-decision\.json$/.test(e.name)).map((e) => e.name).sort()
  const out: CandidateFile[] = []
  for (const name of files) {
    try {
      const parsed = parseCandidateFile((await vaultRead(`diary/${name}`)).content)
      const m = name.match(/^(\d{4}-\d{2}-\d{2})-decision\.json$/)
      parsed.fileDate = m ? m[1] : name.replace(/-decision\.json$/, '')
      out.push(parsed)
    } catch { /* skip malformed */ }
  }
  return out
}
