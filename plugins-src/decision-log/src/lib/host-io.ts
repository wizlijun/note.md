import { vaultRead, vaultWrite, vaultExists, vaultList } from './bridge'
import { serializeBoard, parseBoard, serializeArchive, parseArchive } from './board-io'
import { parseCandidateFile, type CandidateFile } from './candidate'
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
/** 扫 diary/ 下所有 *-decision.json,返回按日期排序的候选文件。 */
export async function loadCandidates(): Promise<CandidateFile[]> {
  if (!(await vaultExists('diary')).exists) return []
  const entries = (await vaultList('diary')).entries
  const files = entries.filter((e) => !e.is_dir && /-decision\.json$/.test(e.name)).map((e) => e.name).sort()
  const out: CandidateFile[] = []
  for (const name of files) {
    try { out.push(parseCandidateFile((await vaultRead(`diary/${name}`)).content)) } catch { /* skip malformed */ }
  }
  return out
}
