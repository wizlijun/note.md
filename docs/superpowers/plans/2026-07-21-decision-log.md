# Decision Log 决策日志插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个"事前预测 + 事后裁决"的纯前端插件,把决策压成两个人类动作,用校准记分牌反 outcome bias,全程落盘为 `.note.md`。

**Architecture:** 纯前端插件(形态照抄 `roam-import`),独立窗口做看板 UI,通过 `window.notemd` 桥用 `vault.read/write` 读写 vault。数据分三层:活动看板 `vault/decision/open.decision.note.md`(front-matter 数组)、按日归档 `vault/decision/archive/YYYY-MM-DD-decision.note.md`、积分事件日志 `vault/decision/_scoreboard.jsonl`;AI 每日候选托盘 `vault/diary/YYYY-MM-DD-decision.json` 由外部 agent 生成、插件只读消费。纯逻辑(schema/序列化/生命周期/校准)与 UI 分离,逻辑走 TDD,UI 走手动验证。

**Tech Stack:** TypeScript + Svelte 5 + Vite(插件工程),Vitest(逻辑单测),`window.notemd` host bridge,YAML(front-matter)。

**规范依据:** `docs/plugin-v2-development.md`(插件 v2 全规范)。**设计依据:** 见下"研究依据"。

---

## 研究依据(2026-07-21 深度检索,43 源 / 227 条验证论断)

设计中每个反直觉决策都有出处,实现时不要"优化"掉:

- **记分牌记校准、不记对错率** — outcome bias 由 Baron & Hershey (1988) 实证(5 组研究),人明知不该按结果评判决策却仍被污染。Annie Duke 称之 "resulting"。来源:`en.wikipedia.org/wiki/Outcome_bias`、`thedecisionlab.com/biases/outcome-bias`、`psycnet.apa.org/doiLanding?doi=10.1037/0022-3514.54.4.569`、`calvinrosser.com/notes/thinking-in-bets-annie-duke`。
- **预测必须在行动前写、决策时状态要记** — Farnam Street 官方模板固定含:决策时 Mental/Physical State(勾选框)、预期结果+概率 与 实际结果分块、Review Date(决策后 6 个月)、落选备选项、"必须行动前写"以对抗 hindsight bias。来源:`fs.blog/decision-journal/`、`fs.blog/wp-content/uploads/2017/02/decision-journal_draft3.pdf`、`alliancefordecisioneducation.org/resources/keeping-a-decision-journal/`。
- **outcome 与"是否仍认同"分两栏** — 决策质量 ≠ 结果质量;好过程可坏结果。来源:同上 Duke + `psychologytoday.com/us/blog/decisions-and-the-brain/202509/...`。
- **一记一决策 / Status 生命周期 / front-matter 元数据** — ADR/MADR 惯例:一条记录一个决策、Status(proposed/accepted/superseded)、YAML front-matter(status/date)、`docs/decisions/` + `NNNN-title` 命名、Confirmation 节做事后验证。来源:`github.com/joelparkerhenderson/architecture-decision-record`、`adr.github.io/madr/`、`martinfowler.com/bliki/ArchitectureDecisionRecord.html`。
- **AI 提名、人签字**(AI 不替人生成预测)— 认知卸载;LLM 可实时检测 confirmation bias 等(arXiv 2503.05516),定位为"辅助审查"而非代判。

---

## File Structure

新插件工程 `plugins-src/decision-log/`(纯前端,无 backend):

| 文件 | 职责 |
|---|---|
| `manifest.v2.json` | 插件声明:window + menu + `["vault.read","vault.write","toast"]` |
| `package.json` / `vite.config.ts` / `tsconfig.json` / `index.html` / `src/main.ts` / `src/App.svelte` | Vite/Svelte 工程骨架(照抄 roam-import) |
| `src/lib/bridge.ts` | `window.notemd` 桥的类型化封装(照抄 roam-import) |
| `src/lib/strings.ts` | 插件自带 i18n(en 基准 + zh 覆盖,locale 取自 bridge) |
| **`src/lib/model.ts`** | 全部类型 + 常量(Confidence/Outcome/Status/DecisionRecord/Candidate/ScoreEvent) |
| **`src/lib/candidate.ts`** | 解析并校验每日候选 JSON(`diary/*-decision.json`) |
| **`src/lib/board-io.ts`** | 看板/归档 `.note.md` 的 front-matter 数组 ↔ 内存往返(序列化+解析) |
| **`src/lib/lifecycle.ts`** | 纯函数状态迁移:sign / verdict / downgrade / manualCreate / adjustCheckDate |
| **`src/lib/scoreboard.ts`** | 事件追加 + 校准分桶/样本数/回避模式计算(纯函数) |
| **`src/lib/id.ts`** | 决策 id / 候选 id 生成(基于日期+序号,无 LLM) |
| `src/lib/store.svelte.ts` | 运行时状态 + 通过 bridge 读写盘(薄适配层) |
| `src/lib/host-io.ts` | 三层文件的加载/保存(封装 bridge vault 调用) |
| `src/components/Board.svelte` | 三列看板 + 拖放 |
| `src/components/Card.svelte` | 极简卡片(按列变体) |
| `src/components/SignSheet.svelte` | 签字模态(候选→未决) |
| `src/components/VerdictSheet.svelte` | 裁决模态(未决→归档) |
| `src/components/Scoreboard.svelte` | 常驻记分牌栏 |

**粗体文件 = 纯逻辑,走完整 TDD。** 其余 UI/适配层走手动验证。

**加粗依赖:** 若 `board-io.ts` 需要 front-matter 工具,复制主程序 `src/lib/outline/frontmatter.ts` 到 `src/lib/outline/frontmatter.ts`(插件不能 import 主程序,见规范 §9)。但本插件 front-matter 是"数组 + 镜像正文",直接用 `yaml` 库更简单,见 Task 5。

---

## Task 1: 插件工程骨架(纯前端)

**Files:**
- Create: `plugins-src/decision-log/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.ts`, `src/App.svelte`, `src/vite-env.d.ts`
- Reference: `plugins-src/roam-import/` 同名文件

- [ ] **Step 1: 复制 roam-import 骨架并改名**

```bash
cp plugins-src/roam-import/package.json plugins-src/decision-log/package.json
cp plugins-src/roam-import/vite.config.ts plugins-src/decision-log/vite.config.ts
cp plugins-src/roam-import/tsconfig.json plugins-src/decision-log/tsconfig.json
cp plugins-src/roam-import/index.html plugins-src/decision-log/index.html
cp plugins-src/roam-import/src/vite-env.d.ts plugins-src/decision-log/src/vite-env.d.ts 2>/dev/null || true
```
把 `package.json` 的 `"name"` 改为 `"decision-log"`;`index.html` 的 `<title>` 改为 `Decision Log`。

- [ ] **Step 2: 安装依赖并加 vitest**

Run:
```bash
cd plugins-src/decision-log && pnpm install && pnpm add -D vitest && pnpm add yaml
```
Expected: 安装成功,`package.json` 出现 `vitest` 与 `yaml`。在 `package.json` 的 `scripts` 加 `"test": "vitest run"`。

- [ ] **Step 3: 最小 App.svelte 占位**

`src/App.svelte`:
```svelte
<script lang="ts">
  import { bridge } from './lib/bridge'
  const pluginId = (() => { try { return bridge().pluginId } catch { return 'dev' } })()
</script>
<main><h1>Decision Log</h1><p>{pluginId}</p></main>
```
`src/main.ts`(照抄 roam-import 的 mount 写法,指向 `App.svelte`)。

- [ ] **Step 4: 复制 bridge.ts**

```bash
cp plugins-src/roam-import/src/lib/bridge.ts plugins-src/decision-log/src/lib/bridge.ts
```
删掉 roam 专用的 `dialogOpenJson`/`fsReadText`/`fsReadBytes` 等函数,保留 `bridge()`、`NotemdBridge`、`VaultInfo`、`vaultInfo()`。追加两个通用封装:
```ts
export function vaultRead(path: string): Promise<{ content: string }> {
  return bridge().request('host.vault.read', { path })
}
export function vaultWrite(path: string, content: string): Promise<{ ok: true }> {
  return bridge().request('host.vault.write', { path, content })
}
export function vaultExists(path: string): Promise<{ exists: boolean }> {
  return bridge().request('host.vault.exists', { path })
}
export function vaultList(path: string): Promise<{ entries: { name: string; is_dir: boolean }[] }> {
  return bridge().request('host.vault.list', { path })
}
```

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log
git commit -m "feat(decision-log): scaffold frontend plugin from roam-import"
```

---

## Task 2: 数据模型 model.ts

**Files:**
- Create: `plugins-src/decision-log/src/lib/model.ts`
- Test: `plugins-src/decision-log/src/lib/model.test.ts`

- [ ] **Step 1: 写失败测试**

`model.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CONFIDENCE_BUCKETS, confidenceMidpoint, isConfidence, isOutcome } from './model'

describe('model', () => {
  it('exposes three confidence buckets in order', () => {
    expect(CONFIDENCE_BUCKETS).toEqual(['low', 'medium', 'high'])
  })
  it('maps buckets to calibration midpoints', () => {
    expect(confidenceMidpoint('low')).toBe(0.6)
    expect(confidenceMidpoint('medium')).toBe(0.75)
    expect(confidenceMidpoint('high')).toBe(0.9)
  })
  it('validates enums', () => {
    expect(isConfidence('high')).toBe(true)
    expect(isConfidence('x')).toBe(false)
    expect(isOutcome('hit')).toBe(true)
    expect(isOutcome('nope')).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd plugins-src/decision-log && pnpm test model`
Expected: FAIL — `Cannot find module './model'`.

- [ ] **Step 3: 写实现**

`model.ts`:
```ts
export const CONFIDENCE_BUCKETS = ['low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCE_BUCKETS)[number]
export const OUTCOMES = ['hit', 'partial', 'miss'] as const
export type Outcome = (typeof OUTCOMES)[number]
export type Status = 'closed' | 'dropped' | 'downgraded'

const MID: Record<Confidence, number> = { low: 0.6, medium: 0.75, high: 0.9 }
export function confidenceMidpoint(c: Confidence): number { return MID[c] }
export function isConfidence(x: unknown): x is Confidence {
  return typeof x === 'string' && (CONFIDENCE_BUCKETS as readonly string[]).includes(x)
}
export function isOutcome(x: unknown): x is Outcome {
  return typeof x === 'string' && (OUTCOMES as readonly string[]).includes(x)
}

export interface StateSnapshot { time?: string; speech_rate?: 'slow'|'normal'|'fast'; calendar_density?: 'low'|'medium'|'high' }
export interface Trigger { if: string; source?: string }
export interface Evidence { conv_id?: string; quote: string; time?: string }

/** 未决看板中的一条(front-matter decisions[] 元素)。 */
export interface OpenDecision {
  id: string
  title: string
  prediction: string        // 🔒 签字后不可改
  confidence: Confidence     // 🔒
  'check-date': string
  created: string            // 🔒
  origin: 'agent' | 'manual' // 🔒
  source_conv?: string
  quote?: string             // 🔒 来自 quoted 候选
  strikes: number            // 0..3
  triggers?: Trigger[]
  state?: StateSnapshot      // 🔒
}

/** 归档记录(archive front-matter decisions[] 元素)。 */
export interface ArchivedDecision {
  id: string
  created: string
  status: Status
  prediction: string
  confidence: Confidence
  outcome?: Outcome          // status=closed 必填
  'still-endorse'?: boolean  // status=closed 必填
  evidence?: Evidence[]
  origin: 'agent' | 'manual'
  state?: StateSnapshot
}

export interface ScoreEvent {
  ts: string
  event: 'create' | 'verdict' | 'downgrade' | 'adjust' | 'reopen'
  id: string
  confidence?: Confidence
  outcome?: Outcome
  still_endorse?: boolean
  category?: string
  state?: StateSnapshot
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd plugins-src/decision-log && pnpm test model`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/model.ts plugins-src/decision-log/src/lib/model.test.ts
git commit -m "feat(decision-log): core data model + enums"
```

---

## Task 3: id 生成 id.ts

**Files:**
- Create: `src/lib/id.ts`; Test: `src/lib/id.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { decisionId, nextSeq } from './id'

describe('id', () => {
  it('builds date-based decision id with sequence, no LLM', () => {
    expect(decisionId('2026-07-21', 1)).toBe('2026-07-21-01')
    expect(decisionId('2026-07-21', 12)).toBe('2026-07-21-12')
  })
  it('nextSeq picks max existing same-day seq + 1', () => {
    expect(nextSeq(['2026-07-21-01', '2026-07-21-03', '2026-07-20-09'], '2026-07-21')).toBe(4)
    expect(nextSeq([], '2026-07-21')).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test id` — Expected: FAIL (module missing).

- [ ] **Step 3: 写实现**

`id.ts`:
```ts
export function decisionId(dateISO: string, seq: number): string {
  return `${dateISO}-${String(seq).padStart(2, '0')}`
}
export function nextSeq(existingIds: string[], dateISO: string): number {
  const prefix = `${dateISO}-`
  const seqs = existingIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
  return (seqs.length ? Math.max(...seqs) : 0) + 1
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test id` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/id.ts plugins-src/decision-log/src/lib/id.test.ts
git commit -m "feat(decision-log): date-based id generation"
```

---

## Task 4: 候选 JSON 解析+校验 candidate.ts

**Files:**
- Create: `src/lib/candidate.ts`; Test: `src/lib/candidate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { parseCandidateFile } from './candidate'

const good = JSON.stringify({
  date: '2026-07-21', generated_by: 'openclaw',
  new_candidates: [
    { id: 'cand-2026-07-21-01', title: 'MVP', prediction_source: 'quoted',
      quote: '两周内能发', prediction: '两周内发出 MVP', confidence: 'medium',
      check_date: '2026-08-04', status: 'pending' },
    { id: 'cand-2026-07-21-02', title: '换 CDN', prediction_source: 'nominated',
      prediction: '你是预期延迟减半吗?', confidence: null, status: 'pending' },
  ],
  closures: [
    { decision_id: '2026-07-07-01', reason: 'due', suggested_outcome: 'hit',
      evidence: [{ quote: '上线了' }], status: 'pending' },
  ],
})

describe('parseCandidateFile', () => {
  it('parses valid file', () => {
    const r = parseCandidateFile(good)
    expect(r.new_candidates).toHaveLength(2)
    expect(r.closures).toHaveLength(1)
  })
  it('drops quoted candidate missing quote (invalid), keeps rest', () => {
    const bad = JSON.stringify({ date: '2026-07-21', generated_by: 'x',
      new_candidates: [{ id: 'cand-2026-07-21-01', title: 'X', prediction_source: 'quoted', status: 'pending' }],
      closures: [] })
    expect(parseCandidateFile(bad).new_candidates).toHaveLength(0)
  })
  it('throws on non-JSON', () => {
    expect(() => parseCandidateFile('not json')).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test candidate` — Expected: FAIL.

- [ ] **Step 3: 写实现**

`candidate.ts`:
```ts
import { isConfidence, type Confidence, type Trigger, type Evidence, type StateSnapshot } from './model'

export interface NewCandidate {
  id: string; title: string
  prediction_source: 'quoted' | 'nominated'
  quote?: string
  prediction: string | null
  confidence: Confidence | null
  check_date?: string | null
  triggers?: Trigger[]
  state?: StateSnapshot
  source?: Evidence
}
export interface Closure {
  decision_id: string
  reason: 'due' | 'trigger'
  suggested_outcome?: 'hit' | 'partial' | 'miss'
  evidence?: Evidence[]
}
export interface CandidateFile { date: string; new_candidates: NewCandidate[]; closures: Closure[] }

function validCandidate(c: any): c is NewCandidate {
  if (!c || typeof c.id !== 'string' || typeof c.title !== 'string') return false
  if (c.prediction_source !== 'quoted' && c.prediction_source !== 'nominated') return false
  if (c.prediction_source === 'quoted' && typeof c.quote !== 'string') return false // quoted 必带原话
  if (c.confidence != null && !isConfidence(c.confidence)) return false
  return true
}
function validClosure(c: any): c is Closure {
  return c && typeof c.decision_id === 'string' && (c.reason === 'due' || c.reason === 'trigger')
}

/** 宽容解析:整体 JSON 必须合法(否则 throw);单个不合法的候选/关闭项被静默丢弃。 */
export function parseCandidateFile(raw: string): CandidateFile {
  const obj = JSON.parse(raw)
  const date = typeof obj?.date === 'string' ? obj.date : ''
  const new_candidates = Array.isArray(obj?.new_candidates) ? obj.new_candidates.filter(validCandidate) : []
  const closures = Array.isArray(obj?.closures) ? obj.closures.filter(validClosure) : []
  return { date, new_candidates, closures }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test candidate` — Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/candidate.ts plugins-src/decision-log/src/lib/candidate.test.ts
git commit -m "feat(decision-log): candidate JSON parse with lenient per-item validation"
```

---

## Task 5: 看板/归档 .note.md 往返 board-io.ts

**Files:**
- Create: `src/lib/board-io.ts`; Test: `src/lib/board-io.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { serializeBoard, parseBoard, serializeArchive, parseArchive } from './board-io'
import type { OpenDecision, ArchivedDecision } from './model'

const dec: OpenDecision = {
  id: '2026-07-21-01', title: '先做 MVP', prediction: '两周内发出 MVP',
  confidence: 'medium', 'check-date': '2026-08-04', created: '2026-07-21',
  origin: 'manual', strikes: 0,
}

describe('board-io', () => {
  it('board round-trips through .note.md', () => {
    const md = serializeBoard([dec])
    expect(md).toMatch(/^---\n/)                 // front-matter first
    expect(md).toContain('type: decision-board')
    expect(md).toContain('# 未决决策')            // human-readable mirror body
    expect(md).toContain('先做 MVP')
    const back = parseBoard(md)
    expect(back).toHaveLength(1)
    expect(back[0]).toMatchObject({ id: '2026-07-21-01', prediction: '两周内发出 MVP', strikes: 0 })
  })
  it('parseBoard on empty/missing returns []', () => {
    expect(parseBoard('')).toEqual([])
    expect(parseBoard('# no frontmatter')).toEqual([])
  })
  it('archive round-trips', () => {
    const a: ArchivedDecision = { ...dec, status: 'closed', outcome: 'hit', 'still-endorse': true } as any
    const md = serializeArchive('2026-08-04', [a])
    expect(md).toContain('type: decision-archive')
    expect(md).toContain('resolved: 2026-08-04')
    const back = parseArchive(md)
    expect(back[0]).toMatchObject({ id: '2026-07-21-01', outcome: 'hit', 'still-endorse': true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test board-io` — Expected: FAIL.

- [ ] **Step 3: 写实现**

`board-io.ts`(用 `yaml` 库直接读写 front-matter,正文是人类可读镜像;解析只信 front-matter):
```ts
import YAML from 'yaml'
import type { OpenDecision, ArchivedDecision } from './model'

const FM = /^---\n([\s\S]*?)\n---\n?/

function buildNote(frontmatter: object, bodyLines: string[]): string {
  const fm = YAML.stringify(frontmatter).trimEnd()
  return `---\n${fm}\n---\n\n${bodyLines.join('\n')}\n`
}
function readFrontmatter(md: string): any {
  const m = md.match(FM)
  if (!m) return null
  try { return YAML.parse(m[1]) } catch { return null }
}

export function serializeBoard(decisions: OpenDecision[]): string {
  const body = ['# 未决决策', '']
  for (const d of decisions) {
    body.push(`## ${d.title}`)
    body.push(`- 预测:${d.prediction}(信心 ${d.confidence})· 检查 ${d['check-date']}`)
    body.push('')
  }
  return buildNote({ type: 'decision-board', decisions }, body)
}
export function parseBoard(md: string): OpenDecision[] {
  const fm = readFrontmatter(md)
  return Array.isArray(fm?.decisions) ? (fm.decisions as OpenDecision[]) : []
}
export function serializeArchive(resolved: string, decisions: ArchivedDecision[]): string {
  const lines = [`# ${resolved} 裁决`, '']
  for (const d of decisions) {
    const mark = d.status === 'closed' ? (d.outcome === 'hit' ? '✅' : d.outcome === 'miss' ? '❌' : '◐') : d.status === 'dropped' ? '⊘' : '⬇'
    lines.push(`## ${d.id} — ${d.status} ${mark}`)
    lines.push(`- 预测:${d.prediction}(信心 ${d.confidence})`)
    lines.push('')
  }
  return buildNote({ type: 'decision-archive', resolved, decisions }, lines)
}
export function parseArchive(md: string): ArchivedDecision[] {
  const fm = readFrontmatter(md)
  return Array.isArray(fm?.decisions) ? (fm.decisions as ArchivedDecision[]) : []
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test board-io` — Expected: PASS (3 tests). 若 front-matter 顺序导致 `check-date`(带连字符键)YAML 输出为 `'check-date':`,断言用 `toMatchObject` 不受影响。

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/board-io.ts plugins-src/decision-log/src/lib/board-io.test.ts
git commit -m "feat(decision-log): board/archive .note.md serialize+parse (front-matter array + mirror body)"
```

---

## Task 6: 生命周期迁移 lifecycle.ts

**Files:**
- Create: `src/lib/lifecycle.ts`; Test: `src/lib/lifecycle.test.ts`

纯函数,输入当前 open 列表 + 动作,输出 `{ open, archived?, event }`。不碰 I/O。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { sign, verdict, incStrike, manualCreate } from './lifecycle'
import type { OpenDecision } from './model'

const base: OpenDecision = {
  id: '2026-07-21-01', title: 'MVP', prediction: '两周内发出', confidence: 'medium',
  'check-date': '2026-08-04', created: '2026-07-21', origin: 'manual', strikes: 0,
}

describe('lifecycle', () => {
  it('sign appends a new open decision + create event', () => {
    const r = sign([], {
      title: 'MVP', prediction: '两周内发出', confidence: 'medium',
      checkDate: '2026-08-04', origin: 'agent', created: '2026-07-21', source_conv: 'cv1',
    })
    expect(r.open).toHaveLength(1)
    expect(r.open[0].id).toBe('2026-07-21-01')
    expect(r.event).toMatchObject({ event: 'create', id: '2026-07-21-01', confidence: 'medium' })
  })
  it('verdict moves decision out of open into archived + verdict event', () => {
    const r = verdict([base], '2026-07-21-01', { outcome: 'hit', stillEndorse: true, resolved: '2026-08-04', evidence: [] })
    expect(r.open).toHaveLength(0)
    expect(r.archived).toMatchObject({ id: '2026-07-21-01', status: 'closed', outcome: 'hit', 'still-endorse': true })
    expect(r.event).toMatchObject({ event: 'verdict', outcome: 'hit', still_endorse: true })
  })
  it('incStrike bumps strikes; at 3 downgrades into archive', () => {
    const two = { ...base, strikes: 2 }
    const r = incStrike([two], '2026-07-21-01', '2026-08-25')
    expect(r.open).toHaveLength(0)
    expect(r.archived).toMatchObject({ status: 'downgraded' })
    expect(r.event).toMatchObject({ event: 'downgrade', id: '2026-07-21-01' })
  })
  it('incStrike below 3 keeps it open with strikes+1, no archive', () => {
    const r = incStrike([base], '2026-07-21-01', '2026-08-25')
    expect(r.open[0].strikes).toBe(1)
    expect(r.archived).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test lifecycle` — Expected: FAIL.

- [ ] **Step 3: 写实现**

`lifecycle.ts`:
```ts
import { decisionId, nextSeq } from './id'
import type { OpenDecision, ArchivedDecision, Confidence, Outcome, Evidence, ScoreEvent, StateSnapshot, Trigger } from './model'

// caller injects `now` (ISO) so the module stays deterministic/testable.
export interface SignInput {
  title: string; prediction: string; confidence: Confidence; checkDate: string
  origin: 'agent' | 'manual'; created: string
  source_conv?: string; quote?: string; triggers?: Trigger[]; state?: StateSnapshot
  now?: string
}
export function sign(open: OpenDecision[], i: SignInput): { open: OpenDecision[]; event: ScoreEvent } {
  const id = decisionId(i.created, nextSeq(open.map((d) => d.id), i.created))
  const dec: OpenDecision = {
    id, title: i.title, prediction: i.prediction, confidence: i.confidence,
    'check-date': i.checkDate, created: i.created, origin: i.origin, strikes: 0,
    ...(i.source_conv ? { source_conv: i.source_conv } : {}),
    ...(i.quote ? { quote: i.quote } : {}),
    ...(i.triggers?.length ? { triggers: i.triggers } : {}),
    ...(i.state ? { state: i.state } : {}),
  }
  const event: ScoreEvent = { ts: i.now ?? i.created, event: 'create', id, confidence: i.confidence, ...(i.state ? { state: i.state } : {}) }
  return { open: [...open, dec], event }
}

export function manualCreate(open: OpenDecision[], i: Omit<SignInput, 'origin'>): { open: OpenDecision[]; event: ScoreEvent } {
  return sign(open, { ...i, origin: 'manual' })
}

export interface VerdictInput { outcome: Outcome; stillEndorse: boolean; resolved: string; evidence?: Evidence[]; now?: string }
export function verdict(open: OpenDecision[], id: string, v: VerdictInput): { open: OpenDecision[]; archived: ArchivedDecision; event: ScoreEvent } {
  const d = open.find((x) => x.id === id)
  if (!d) throw new Error(`verdict: id ${id} not open`)
  const archived: ArchivedDecision = {
    id: d.id, created: d.created, status: 'closed', prediction: d.prediction, confidence: d.confidence,
    outcome: v.outcome, 'still-endorse': v.stillEndorse, origin: d.origin,
    ...(v.evidence?.length ? { evidence: v.evidence } : {}),
    ...(d.state ? { state: d.state } : {}),
  }
  const event: ScoreEvent = { ts: v.now ?? v.resolved, event: 'verdict', id, confidence: d.confidence, outcome: v.outcome, still_endorse: v.stillEndorse, ...(d.state ? { state: d.state } : {}) }
  return { open: open.filter((x) => x.id !== id), archived, event }
}

export function incStrike(open: OpenDecision[], id: string, resolvedIfDowngrade: string, now?: string):
  { open: OpenDecision[]; archived?: ArchivedDecision; event?: ScoreEvent } {
  const d = open.find((x) => x.id === id)
  if (!d) return { open }
  const strikes = d.strikes + 1
  if (strikes >= 3) {
    const archived: ArchivedDecision = {
      id: d.id, created: d.created, status: 'downgraded', prediction: d.prediction, confidence: d.confidence,
      origin: d.origin, ...(d.state ? { state: d.state } : {}),
    }
    const event: ScoreEvent = { ts: now ?? resolvedIfDowngrade, event: 'downgrade', id, category: d.title }
    return { open: open.filter((x) => x.id !== id), archived, event }
  }
  return { open: open.map((x) => (x.id === id ? { ...x, strikes } : x)) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test lifecycle` — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/lifecycle.ts plugins-src/decision-log/src/lib/lifecycle.test.ts
git commit -m "feat(decision-log): pure lifecycle transitions (sign/verdict/3-strike downgrade)"
```

---

## Task 7: 校准记分牌 scoreboard.ts

**Files:**
- Create: `src/lib/scoreboard.ts`; Test: `src/lib/scoreboard.test.ts`

**记的是校准,不是对错率**(研究依据 outcome bias)。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { appendEvent, parseLog, computeScoreboard } from './scoreboard'
import type { ScoreEvent } from './model'

const verdicts: ScoreEvent[] = [
  { ts: '1', event: 'verdict', id: 'a', confidence: 'high', outcome: 'hit', still_endorse: true },
  { ts: '2', event: 'verdict', id: 'b', confidence: 'high', outcome: 'miss', still_endorse: true },
  { ts: '3', event: 'verdict', id: 'c', confidence: 'low', outcome: 'hit', still_endorse: false },
  { ts: '4', event: 'create', id: 'd', confidence: 'medium' },
  { ts: '5', event: 'downgrade', id: 'e', category: '招聘' },
]

describe('scoreboard', () => {
  it('appendEvent produces one JSON line appended to prior log', () => {
    const log = appendEvent('', verdicts[0])
    const log2 = appendEvent(log, verdicts[1])
    expect(parseLog(log2)).toHaveLength(2)
    expect(log2.endsWith('\n')).toBe(true)
  })
  it('calibration buckets = hits/total per confidence, from verdict events only', () => {
    const s = computeScoreboard(verdicts)
    expect(s.buckets.high).toEqual({ hits: 1, total: 2 })   // hit + miss
    expect(s.buckets.low).toEqual({ hits: 1, total: 1 })
    expect(s.buckets.medium).toEqual({ hits: 0, total: 0 }) // create doesn't count
  })
  it('sampleCount counts resolved verdicts only', () => {
    expect(computeScoreboard(verdicts).sampleCount).toBe(3)
  })
  it('avoidance tallies downgrade categories', () => {
    expect(computeScoreboard(verdicts).avoidance).toEqual({ '招聘': 1 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test scoreboard` — Expected: FAIL.

- [ ] **Step 3: 写实现**

`scoreboard.ts`:
```ts
import { CONFIDENCE_BUCKETS, type Confidence, type ScoreEvent } from './model'

export function appendEvent(log: string, ev: ScoreEvent): string {
  const line = JSON.stringify(ev)
  return log ? `${log.endsWith('\n') ? log : log + '\n'}${line}\n` : `${line}\n`
}
export function parseLog(log: string): ScoreEvent[] {
  return log.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ScoreEvent)
}

export interface Scoreboard {
  buckets: Record<Confidence, { hits: number; total: number }>
  sampleCount: number
  avoidance: Record<string, number>
}
export function computeScoreboard(events: ScoreEvent[]): Scoreboard {
  const buckets = Object.fromEntries(CONFIDENCE_BUCKETS.map((b) => [b, { hits: 0, total: 0 }])) as Scoreboard['buckets']
  const avoidance: Record<string, number> = {}
  let sampleCount = 0
  for (const e of events) {
    if (e.event === 'verdict' && e.confidence) {
      buckets[e.confidence].total += 1
      if (e.outcome === 'hit') buckets[e.confidence].hits += 1
      sampleCount += 1
    }
    if (e.event === 'downgrade' && e.category) {
      avoidance[e.category] = (avoidance[e.category] ?? 0) + 1
    }
  }
  return { buckets, sampleCount, avoidance }
}
```
> 注:`partial` 暂按"非 hit"计(不进 hits 分子);极客模式的 Brier 分数留待后续任务,不在 MVP。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test scoreboard` — Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins-src/decision-log/src/lib/scoreboard.ts plugins-src/decision-log/src/lib/scoreboard.test.ts
git commit -m "feat(decision-log): calibration scoreboard (buckets/sample-count/avoidance), not accuracy rate"
```

---

## Task 8: host I/O 适配层 host-io.ts

**Files:**
- Create: `src/lib/host-io.ts`（薄封装,无单测——纯 I/O 委托 bridge;逻辑已在上游测过）

- [ ] **Step 1: 写实现**

`host-io.ts`:
```ts
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
```

- [ ] **Step 2: 类型检查通过**

Run: `cd plugins-src/decision-log && pnpm exec tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add plugins-src/decision-log/src/lib/host-io.ts
git commit -m "feat(decision-log): host-io adapter over window.notemd vault bridge"
```

---

## Task 9: manifest + i18n strings + 菜单/窗口

**Files:**
- Create: `plugins-src/decision-log/manifest.v2.json`, `src/lib/strings.ts`

- [ ] **Step 1: 写 manifest.v2.json**

```json
{
  "manifest_version": 2,
  "id": "notemd.decision-log",
  "name": "Decision Log",
  "version": "1.0.0",
  "kind": "native",
  "engines": { "notemd": ">=6.717.0" },
  "description": "Predict before, judge after — a calibrated decision journal stored as .note.md.",
  "ui": "ui/",
  "activation": { "events": ["onCommand:open"] },
  "contributes": {
    "menus": [
      { "location": "window", "label": "Decision Log", "command": "open" }
    ],
    "windows": [
      {
        "id": "main",
        "entry": "index.html",
        "title": "Decision Log",
        "width": 920.0,
        "height": 680.0,
        "min_width": 720.0,
        "min_height": 480.0,
        "open_command": "open"
      }
    ]
  },
  "capabilities": ["vault.read", "vault.write", "toast"],
  "i18n": { "zh": { "name": "决策日志", "menus": { "open": "决策日志" } } }
}
```
> `engines.notemd` 用当前发布线(写计划时 ~6.717.x)。校验:`cargo test -p plugin-protocol` 不涉及本文件,但可用 `node -e "JSON.parse(require('fs').readFileSync('plugins-src/decision-log/manifest.v2.json'))"` 确认 JSON 合法。

- [ ] **Step 2: 写 strings.ts(照抄 openclaw 结构)**

`src/lib/strings.ts`(en 基准 + zh 覆盖,`t(key)` 取 `bridge().locale`):
```ts
import { bridge } from './bridge'
export type MessageKey =
  | 'panel.title' | 'col.candidates' | 'col.open' | 'col.archive'
  | 'sign.title' | 'sign.prediction' | 'sign.confidence.low' | 'sign.confidence.medium' | 'sign.confidence.high'
  | 'sign.checkDate' | 'sign.submit'
  | 'verdict.q1' | 'verdict.hit' | 'verdict.partial' | 'verdict.miss'
  | 'verdict.q2' | 'verdict.endorseYes' | 'verdict.endorseNo' | 'verdict.submit'
  | 'score.samples' | 'score.calibration' | 'card.new' | 'downgrade.toast'
type Catalog = Record<MessageKey, string>
const en: Catalog = {
  'panel.title': 'Decision Log', 'col.candidates': 'Candidates', 'col.open': 'Open', 'col.archive': 'Archive',
  'sign.title': 'Sign this bet', 'sign.prediction': 'Prediction',
  'sign.confidence.low': 'Somewhat sure', 'sign.confidence.medium': 'Fairly sure', 'sign.confidence.high': 'Very sure',
  'sign.checkDate': 'Check on', 'sign.submit': 'Sign the bet',
  'verdict.q1': 'Did it happen?', 'verdict.hit': 'Hit', 'verdict.partial': 'Partial', 'verdict.miss': 'Missed',
  'verdict.q2': 'Ignoring the result — would you decide this way again?', 'verdict.endorseYes': 'Yes', 'verdict.endorseNo': 'No',
  'verdict.submit': 'Close & archive',
  'score.samples': 'samples collected', 'score.calibration': 'Calibration', 'card.new': 'New Decision',
  'downgrade.toast': 'Set aside for you — reopen anytime.',
}
const zh: Partial<Catalog> = {
  'panel.title': '决策日志', 'col.candidates': '候选', 'col.open': '未决', 'col.archive': '归档',
  'sign.title': '签字下注', 'sign.prediction': '预测',
  'sign.confidence.low': '有点把握', 'sign.confidence.medium': '挺有把握', 'sign.confidence.high': '非常有把握',
  'sign.checkDate': '检查日期', 'sign.submit': '签字下注',
  'verdict.q1': '发生了吗?', 'verdict.hit': '命中', 'verdict.partial': '部分', 'verdict.miss': '未命中',
  'verdict.q2': '抛开结果 —— 还会这么决定吗?', 'verdict.endorseYes': '会', 'verdict.endorseNo': '不会',
  'verdict.submit': '关闭并归档',
  'score.samples': '个决策样本', 'score.calibration': '校准', 'card.new': '新建决策',
  'downgrade.toast': '帮你清理了 —— 随时可捞回。',
}
const registry: Record<string, Partial<Catalog>> = { en, zh }
export function t(key: MessageKey): string {
  let locale = 'en'
  try { locale = bridge().locale } catch { /* dev */ }
  return registry[locale]?.[key] ?? en[key] ?? key
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins-src/decision-log/manifest.v2.json plugins-src/decision-log/src/lib/strings.ts
git commit -m "feat(decision-log): manifest (window+menu+caps) and i18n strings"
```

---

## Task 10: 运行时 store + 装配四条动作

**Files:**
- Create: `src/lib/store.svelte.ts`（Svelte 5 runes 状态 + 调用 lifecycle/host-io;薄装配,无单测）

- [ ] **Step 1: 写实现**

`store.svelte.ts`（把纯逻辑与 I/O 缝在一起,给 UI 用;`now`/`today` 由调用处注入以便测试上游）:
```ts
import { loadBoard, saveBoard, appendArchive, appendScore, loadScore, loadCandidates } from './host-io'
import { sign, verdict, incStrike, manualCreate, type SignInput, type VerdictInput } from './lifecycle'
import { computeScoreboard, type Scoreboard } from './scoreboard'
import type { OpenDecision } from './model'
import type { CandidateFile } from './candidate'

export const state = $state<{ open: OpenDecision[]; candidates: CandidateFile[]; score: Scoreboard | null; loading: boolean }>({
  open: [], candidates: [], score: null, loading: true,
})

export async function refresh(): Promise<void> {
  state.loading = true
  state.open = await loadBoard()
  state.candidates = await loadCandidates()
  state.score = computeScoreboard(await loadScore())
  state.loading = false
}
export async function doSign(input: SignInput): Promise<void> {
  const r = sign(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doManualCreate(input: Omit<SignInput, 'origin'>): Promise<void> {
  const r = manualCreate(state.open, input)
  state.open = r.open
  await saveBoard(state.open)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doVerdict(id: string, v: VerdictInput): Promise<void> {
  const r = verdict(state.open, id, v)
  state.open = r.open
  await saveBoard(state.open)
  await appendArchive(v.resolved, r.archived)
  await appendScore(r.event)
  state.score = computeScoreboard(await loadScore())
}
export async function doStrike(id: string, resolved: string): Promise<void> {
  const r = incStrike(state.open, id, resolved)
  state.open = r.open
  await saveBoard(state.open)
  if (r.archived) await appendArchive(resolved, r.archived)
  if (r.event) { await appendScore(r.event); state.score = computeScoreboard(await loadScore()) }
}
```

- [ ] **Step 2: 类型检查通过**

Run: `pnpm exec tsc --noEmit` — Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add plugins-src/decision-log/src/lib/store.svelte.ts
git commit -m "feat(decision-log): runtime store wiring lifecycle to host-io"
```

---

## Task 11: UI 组件（看板 + 两张模态 + 记分牌）

**Files:**
- Create: `src/components/{Board,Card,SignSheet,VerdictSheet,Scoreboard}.svelte`
- Modify: `src/App.svelte`

> UI 不写自动化测试(用户自测 GUI)。每个组件严格实现下述职责与约束。

- [ ] **Step 1: Scoreboard.svelte** — 常驻右栏。读 `state.score`,渲染:①校准分桶(每档 `hits/total` 小条)②`sampleCount + t('score.samples')` ③avoidance 若非空列一行"你回避:<category>"。无数据显示"已积累 0 个样本"。

- [ ] **Step 2: Card.svelte** — props `{ decision?, candidate?, closure?, column }`。极简:候选卡显示 title + 来源徽标(🎙quoted/💡nominated);未决卡显示 title + confidence + 距 check-date 天数(⚡ 若有 triggers);归档卡显示 title + outcome 图标。**卡片本身不放操作控件**,只 `draggable` + emit `click`。

- [ ] **Step 3: SignSheet.svelte** — 一屏。quoted 显示 quote,一键签字;nominated 显示 prediction 输入(必填)。信心三个按钮 `low/medium/high`(不填百分比)。check-date 选择器。可选 triggers 输入。提交调用 `doSign`/`doManualCreate`,`created = today`(从 host 或 `new Date` 取当天 ISO)。**prediction/confidence 提交后不可改**(UI 无编辑入口)。

- [ ] **Step 4: VerdictSheet.svelte** — 一屏两问:① `t('verdict.q1')` → hit/partial/miss;② `t('verdict.q2')` → yes/no。顶部只读展示 prediction(🔒)+ 已附 evidence。提交调用 `doVerdict`,`resolved = today`。教练语气:未命中不显示为失败。

- [ ] **Step 5: Board.svelte** — 三列(candidates/open/archive),各列渲染 `Card`。拖放:候选→未决落下开 `SignSheet`;未决→归档落下开 `VerdictSheet`;非法拖动弹回(不触发写)。每张卡点击也可开对应模态(拖放的等价按钮路径)。候选列底部 `+ t('card.new')` 开 `SignSheet`(manual)。archive 列只读、按月折叠。

- [ ] **Step 6: App.svelte** — 挂载时 `await refresh()`,渲染 `Board` + `Scoreboard`。声明 `color-scheme: light dark`(独立窗口深浅色,见项目惯例)。

- [ ] **Step 7: Commit**

```bash
git add plugins-src/decision-log/src/components plugins-src/decision-log/src/App.svelte
git commit -m "feat(decision-log): kanban board, sign/verdict sheets, calibration rail UI"
```

---

## Task 12: dev 安装脚本分支 + 构建

**Files:**
- Modify: `scripts/dev-install-plugin.sh`

- [ ] **Step 1: 加 decision-log 分支**

在参数白名单加 `decision-log`,并加安装分支(照抄 roam-import 的纯 UI 分支:`pnpm build` → 拷 `dist/` 为 `ui/` + `manifest.v2.json` → `manifest.json` + `mark_installed`)。参考 `scripts/dev-install-plugin.sh` 里 `roam-import` 段落,把路径 `roam-import`→`decision-log`、id `notemd.roam-import`→`notemd.decision-log`。

- [ ] **Step 2: 构建 + 安装**

Run: `scripts/dev-install-plugin.sh decision-log`
Expected: Vite 构建成功,产物装到 `~/Library/Application Support/net.notemd.app/plugins/notemd.decision-log/1.0.0/`(含 `ui/`、`manifest.json`),`state.json` 标记 enabled。

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-install-plugin.sh
git commit -m "chore(decision-log): dev-install branch"
```

---

## Task 13: 手动 GUI 验证（用户执行）

> 用户自测 GUI。以下是手动验证脚本,不做 osascript 自动化。

- [ ] **Step 1: 起 dev 或装好的 app,打开 Decision Log 窗口**(菜单)。空 vault 应显示三空列 + "已积累 0 个样本"。
- [ ] **Step 2: 点候选列 `+ 新建决策`** → 填预测 + 选"挺有把握" + 检查日期 → 签字。确认:未决列出现一张卡;`vault/decision/open.decision.note.md` 生成且 front-matter 有该决策;`_scoreboard.jsonl` 追加一条 `create`。
- [ ] **Step 3: 造一个到期决策**(把 open.decision.note.md 的 check-date 手改为过去)→ 重开窗口 → 拖到归档列(或点卡)→ 裁决 hit + "会" → 关闭。确认:未决列空;`archive/<今天>-decision.note.md` 出现该记录含 `outcome: hit`、`still-endorse: true`;记分牌 high 档 total+1、样本数+1。
- [ ] **Step 4: 放一份 `diary/<今天>-decision.json`(按 §schema)** → 重开窗口 → 候选列出现候选卡;签字后进未决。确认溯源与 quoted/nominated 徽标正确。
- [ ] **Step 5: Obsidian/CLI 打开 `vault/decision/` 下文件** → 确认 front-matter + 镜像正文人类可读(file-over-app 验收)。

---

## Self-Review 结果

**Spec 覆盖:** 存储三层(Task 5/8)、候选契约(Task 4)、生命周期含三振降级(Task 6)、校准记分牌(Task 7)、看板+两模态+记分牌 UI(Task 11)、i18n(Task 9)、合规 manifest/window/caps(Task 9)、file-over-app 验收(Task 13.5)——均有任务。

**已知延后(非本计划 MVP,后续单独计划):** ① AI 自动填候选(依赖 openclaw/hemory-vault,本计划只消费 JSON,生成端在外);② Brier 极客模式;③ 状态快照/触发条件的**自动采集**(schema 字段已预留,MVP 靠手填/外部 JSON);④ 每日"一次一张卡"轻量队列视图(MVP 先给完整看板)。

**类型一致性:** `OpenDecision`/`ArchivedDecision`/`ScoreEvent` 在 Task 2 定义,Task 5/6/7/8/10 沿用同名字段(`'check-date'`、`'still-endorse'` 带连字符键在 model 与 board-io 一致)。

**依赖顺序:** 2→3→4→5→6→7 为纯逻辑可独立测;8 依赖 4/5/7;9 独立;10 依赖 6/7/8;11 依赖 10;12/13 收尾。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-decision-log.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 task 派新 subagent,task 间双阶段 review,迭代快。
2. **Inline Execution** — 本会话内批量执行,带检查点。

Which approach?
