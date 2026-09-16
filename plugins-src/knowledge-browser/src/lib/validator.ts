import relationRegistry from '../../references/relation-types.json'
import {
  CURRENT_DATASET_SCHEMA, CURRENT_EXTRACTOR_RULE, LEGACY_DATASET_SCHEMA, LEGACY_EXTRACTOR_RULE,
  RELATION_TYPES_VERSION,
} from './types'
import type { Diagnostic, KnowledgeDataset, KnowledgeKind, ValidationResult } from './types'

const COLLECTIONS: KnowledgeKind[] = ['entities', 'concepts', 'claims', 'events', 'narratives', 'relations']
const TOP_REQUIRED = ['schema', 'id', 'generated', 'scope', 'sources', 'evidence', ...COLLECTIONS]
const TOP_ALLOWED = new Set([...TOP_REQUIRED, 'selection', 'type_defs', 'coverage'])
const IDS: Record<string, RegExp> = { entities: /^e[1-9]\d*$/, concepts: /^c[1-9]\d*$/, claims: /^q[1-9]\d*$/, events: /^v[1-9]\d*$/, narratives: /^n[1-9]\d*$/, relations: /^r[1-9]\d*$/ }
const NODE = /^(?:s|e|c|q|v|n|r)[1-9]\d*$/
const SOURCE = /^s[1-9]\d*$/; const EVIDENCE = /^x[1-9]\d*$/; const ROLE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
const EPISTEMIC_STRENGTHS = ['strong', 'medium', 'weak']
const EPISTEMIC_BASES = ['explicit_statement', 'explicit_speech_act', 'direct_observation', 'source_defined', 'independent_corroboration', 'self_report', 'agent_inference', 'ambiguous']
const STRONG_BASES = new Set(['explicit_statement', 'explicit_speech_act', 'direct_observation', 'source_defined', 'independent_corroboration'])
type UnknownMap = Record<string, unknown>

const isObject = (value: unknown): value is UnknownMap => !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && /\S/.test(value)
const values = (map: unknown): unknown[] => isObject(map) ? Object.values(map).flatMap(value => Array.isArray(value) ? value : [value]) : []
const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')

export function validateKnowledgeDataset(input: unknown): ValidationResult {
  const diagnostics: Diagnostic[] = []; const isolatedIds = new Set<string>()
  let currentVersion = false
  let selectionProfile: 'strong_only' | 'exploratory' | undefined
  const add = (code: string, pointer: string, message: string, suggestion = '查看原始记录并修正字段。', objectId?: string) => {
    diagnostics.push({ code, severity: 'error', pointer, objectId, message, suggestion })
    if (objectId && /^[ecqvnr][1-9]\d*$/.test(objectId)) isolatedIds.add(objectId)
  }
  const requireKeys = (object: UnknownMap, keys: string[], pointer: string, objectId?: string) => keys.forEach(key => { if (!(key in object)) add('schema.required', `${pointer}/${key}`, `缺少必填字段 ${key}。`, undefined, objectId) })
  const allowedKeys = (object: UnknownMap, keys: string[], pointer: string, objectId?: string) => Object.keys(object).forEach(key => { if (!keys.includes(key)) add('schema.additional-property', `${pointer}/${escape(key)}`, `不允许字段 ${key}。`, undefined, objectId) })
  const stringArray = (value: unknown, pointer: string, min = 1, unique = false, pattern?: RegExp, objectId?: string) => {
    if (!Array.isArray(value) || value.length < min) { add('schema.array', pointer, `必须是至少含 ${min} 项的数组。`, undefined, objectId); return false }
    value.forEach((item, index) => { if (!nonempty(item) || (pattern && !pattern.test(item))) add('schema.string', `${pointer}/${index}`, '必须是格式正确的非空字符串。', undefined, objectId) })
    if (unique && new Set(value).size !== value.length) add('schema.unique', pointer, '数组元素必须唯一。', undefined, objectId)
    return true
  }
  const time = (value: unknown, pointer: string, allowNull: boolean, objectId?: string) => {
    if (value === null) { if (!allowNull) add('schema.time-null', pointer, '该时间字段不接受 null；未知时应省略。', undefined, objectId); return }
    if (nonempty(value)) return
    if (Array.isArray(value) && value.length === 2 && value.some(Boolean) && value.every(item => item === null || typeof item === 'string')) return
    add('schema.time', pointer, '时间必须是非空字符串、非全空二元区间，或允许的 null。', undefined, objectId)
  }
  const roleMap = (value: unknown, pointer: string, min: number, objectId?: string) => {
    if (!isObject(value) || Object.keys(value).length < min) { add('schema.roles', pointer, `角色表至少需要 ${min} 个角色。`, undefined, objectId); return }
    Object.entries(value).forEach(([role, refs]) => {
      if (!ROLE.test(role)) add('schema.role-name', `${pointer}/${escape(role)}`, '角色名必须使用小写 snake_case。', undefined, objectId)
      if (Array.isArray(refs)) stringArray(refs, `${pointer}/${escape(role)}`, 1, true, NODE, objectId)
      else if (typeof refs !== 'string' || !NODE.test(refs)) add('schema.node-ref', `${pointer}/${escape(role)}`, '角色值必须是节点引用或非空节点引用数组。', undefined, objectId)
    })
  }
  const common = (record: UnknownMap, pointer: string, id: string) => {
    requireKeys(record, currentVersion ? ['id', 'i', 'why', 'ev', 'epistemic'] : ['id', 'i', 'why', 'ev'], pointer, id)
    if (record.i !== 0 && record.i !== 1) add('schema.importance', `${pointer}/i`, 'i 必须为 0 或 1。', undefined, id)
    if (!nonempty(record.why)) add('schema.nonempty', `${pointer}/why`, 'why 必须是非空字符串。', undefined, id)
    stringArray(record.ev, `${pointer}/ev`, 1, true, EVIDENCE, id)
    if ('event' in record) time(record.event, `${pointer}/event`, true, id)
    if ('valid' in record) time(record.valid, `${pointer}/valid`, true, id)
    if ('status' in record && !['contested', 'supported', 'confirmed', 'superseded', 'retracted'].includes(String(record.status))) add('schema.status', `${pointer}/status`, '显式状态无效；candidate 必须通过省略 status 表示。', undefined, id)
    if ('score' in record !== ('score_type' in record)) add('schema.dependent', pointer, 'score 与 score_type 必须同时出现。', undefined, id)
    if ('score' in record && (typeof record.score !== 'number' || record.score < 0 || record.score > 1)) add('schema.score', `${pointer}/score`, 'score 必须在 0 到 1 之间。', undefined, id)
    if ('score_type' in record && !nonempty(record.score_type)) add('schema.nonempty', `${pointer}/score_type`, 'score_type 必须非空。', undefined, id)
    const revision = ['rev', 'op', 'parents'].filter(key => key in record)
    if (revision.length !== 0 && revision.length !== 3) add('schema.dependent', pointer, 'rev、op、parents 必须同时出现。', undefined, id)
    if ('rev' in record && (!Number.isInteger(record.rev) || Number(record.rev) < 2)) add('schema.revision', `${pointer}/rev`, 'rev 必须是至少为 2 的整数。', undefined, id)
    if ('op' in record && !['update','supersede','correct','retract'].includes(String(record.op))) add('schema.operation', `${pointer}/op`, 'op 不是允许的修订操作。', undefined, id)
    if ('parents' in record) stringArray(record.parents, `${pointer}/parents`, 1, true, /^(?:e|c|q|v|n|r)[1-9]\d*@[1-9]\d*$/, id)
    if ('limits' in record) stringArray(record.limits, `${pointer}/limits`, 1, false, undefined, id)
    if ('scope' in record && !(nonempty(record.scope) || (isObject(record.scope) && Object.keys(record.scope).length > 0 && Object.values(record.scope).every(value => value === null || ['string','number','boolean'].includes(typeof value))))) add('schema.scope-value', `${pointer}/scope`, '局部 scope 必须是非空字符串或仅含标量的非空对象。', undefined, id)
    if ('authority' in record) {
      if (!isObject(record.authority)) add('schema.authority', `${pointer}/authority`, 'authority 必须是对象。', undefined, id)
      else { requireKeys(record.authority, ['reviewed_by','basis'], `${pointer}/authority`, id); allowedKeys(record.authority, ['reviewed_by','basis','uses'], `${pointer}/authority`, id); stringArray(record.authority.reviewed_by, `${pointer}/authority/reviewed_by`, 1, true, undefined, id); if (!nonempty(record.authority.basis)) add('schema.nonempty', `${pointer}/authority/basis`, 'basis 必须非空。', undefined, id); if ('uses' in record.authority) stringArray(record.authority.uses, `${pointer}/authority/uses`, 1, true, undefined, id) }
    }
    if (currentVersion && 'epistemic' in record) {
      const epistemic = record.epistemic
      if (!isObject(epistemic)) add('schema.epistemic', `${pointer}/epistemic`, 'epistemic 必须是证据强度对象。', undefined, id)
      else {
        requireKeys(epistemic, ['strength', 'basis'], `${pointer}/epistemic`, id)
        allowedKeys(epistemic, ['strength', 'basis', 'reason'], `${pointer}/epistemic`, id)
        if (!EPISTEMIC_STRENGTHS.includes(String(epistemic.strength))) add('schema.epistemic-strength', `${pointer}/epistemic/strength`, 'strength 必须是 strong、medium 或 weak。', undefined, id)
        stringArray(epistemic.basis, `${pointer}/epistemic/basis`, 1, true, undefined, id)
        const bases = Array.isArray(epistemic.basis) ? epistemic.basis.filter((item): item is string => typeof item === 'string') : []
        bases.forEach((basis, index) => { if (!EPISTEMIC_BASES.includes(basis)) add('schema.epistemic-basis', `${pointer}/epistemic/basis/${index}`, `不支持证据依据 ${basis}。`, undefined, id) })
        if ('reason' in epistemic && !nonempty(epistemic.reason)) add('schema.nonempty', `${pointer}/epistemic/reason`, 'reason 必须是非空字符串。', undefined, id)
        if (selectionProfile === 'strong_only') {
          if (epistemic.strength !== 'strong') add('business.epistemic-strength', `${pointer}/epistemic/strength`, 'strong_only 只允许 strong。', undefined, id)
          if (!bases.some(basis => STRONG_BASES.has(basis))) add('business.epistemic-basis', `${pointer}/epistemic/basis`, 'strong_only 至少需要一种强证据依据。', undefined, id)
          if (bases.includes('agent_inference') || bases.includes('ambiguous')) add('business.epistemic-basis', `${pointer}/epistemic/basis`, 'strong_only 不允许 agent_inference 或 ambiguous。', undefined, id)
          if (bases.includes('self_report') && !bases.includes('independent_corroboration')) add('business.epistemic-basis', `${pointer}/epistemic/basis`, '未独立互证的 self_report 不能作为 strong_only 记录。', undefined, id)
        }
      }
    }
    if (record.identity === 'ambiguous' && !Array.isArray(record.limits)) add('business.ambiguous-limits', pointer, 'ambiguous 身份必须说明 limits。', undefined, id)
    if (['supported', 'confirmed', 'superseded', 'retracted'].includes(String(record.status)) && !('authority' in record)) add('business.authority', `${pointer}/status`, '非候选权威状态必须同时保存 authority。', undefined, id)
  }

  if (!isObject(input)) { add('schema.root', '', '输出必须是 JSON 对象。'); return { valid: false, fatal: true, diagnostics, isolatedIds } }
  requireKeys(input, TOP_REQUIRED, ''); allowedKeys(input, [...TOP_ALLOWED], '')
  currentVersion = input.schema === CURRENT_DATASET_SCHEMA
  const legacyVersion = input.schema === LEGACY_DATASET_SCHEMA
  if (!currentVersion && !legacyVersion) add('version.schema', '/schema', `仅支持 ${CURRENT_DATASET_SCHEMA} 或兼容读取的 ${LEGACY_DATASET_SCHEMA}。`, '查看原始 JSON；不要自动迁移。')
  if (currentVersion && !('selection' in input)) add('schema.required', '/selection', '缺少必填字段 selection。')
  if (typeof input.id !== 'string' || !/^ks_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.id)) add('schema.dataset-id', '/id', 'id 必须是 ks_<UUIDv4>。')
  if (!isObject(input.generated)) add('schema.generated', '/generated', 'generated 必须是对象。')
  else {
    requireKeys(input.generated, ['by', 'at', 'rule', 'types'], '/generated'); allowedKeys(input.generated, ['by', 'at', 'rule', 'types'], '/generated')
    if (!nonempty(input.generated.by)) add('schema.nonempty', '/generated/by', 'by 必须是非空字符串。')
    if (!nonempty(input.generated.at) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(input.generated.at) || Number.isNaN(Date.parse(input.generated.at))) add('schema.date-time', '/generated/at', 'generated.at 必须是带时区的 RFC 3339 时间。')
    const expectedRule = currentVersion ? CURRENT_EXTRACTOR_RULE : legacyVersion ? LEGACY_EXTRACTOR_RULE : undefined
    if (expectedRule && input.generated.rule !== expectedRule) add('version.rule', '/generated/rule', `当前 schema 仅支持 ${expectedRule}。`, '查看原始 JSON；不要猜测抽取规则。')
    if (input.generated.types !== RELATION_TYPES_VERSION) add('version.types', '/generated/types', `仅支持关系表 ${RELATION_TYPES_VERSION}。`, '查看原始 JSON；不要用其他版本关系表解释。')
  }
  if (currentVersion && 'selection' in input) {
    if (!isObject(input.selection)) add('schema.selection', '/selection', 'selection 必须是提取配置对象。')
    else {
      requireKeys(input.selection, ['profile', 'policy', 'minimum_strength'], '/selection')
      allowedKeys(input.selection, ['profile', 'policy', 'minimum_strength'], '/selection')
      if (!['strong_only', 'exploratory'].includes(String(input.selection.profile))) add('schema.selection-profile', '/selection/profile', 'profile 必须是 strong_only 或 exploratory。')
      else selectionProfile = input.selection.profile as 'strong_only' | 'exploratory'
      if (input.selection.policy !== 'epistemic-strength/1.0.0') add('schema.selection-policy', '/selection/policy', 'policy 必须是 epistemic-strength/1.0.0。')
      if (!EPISTEMIC_STRENGTHS.includes(String(input.selection.minimum_strength))) add('schema.selection-strength', '/selection/minimum_strength', 'minimum_strength 必须是 strong、medium 或 weak。')
      if (selectionProfile === 'strong_only' && input.selection.minimum_strength !== 'strong') add('business.selection-strength', '/selection/minimum_strength', 'strong_only 必须使用 strong。')
    }
  } else if (legacyVersion && 'selection' in input) add('version.selection', '/selection', '3.0.0 旧数据不应声明 3.1.0 的提取配置。', '查看原始 JSON；不要自动迁移。')
  if (!isObject(input.scope)) add('schema.scope', '/scope', 'scope 必须是对象。')
  else { requireKeys(input.scope, ['purpose', 'questions'], '/scope'); allowedKeys(input.scope, ['purpose', 'questions'], '/scope'); if (!nonempty(input.scope.purpose)) add('schema.nonempty', '/scope/purpose', 'purpose 必须非空。'); if (!Array.isArray(input.scope.questions) || input.scope.questions.some(q => !nonempty(q))) add('schema.questions', '/scope/questions', 'questions 必须是非空字符串数组。') }

  const sourceIds = new Set<string>(); const evidenceIds = new Set<string>(); const objectIds = new Set<string>(); const kindById = new Map<string, string>()
  const topArrays = ['sources', 'evidence', ...COLLECTIONS]
  topArrays.forEach(name => { if (!Array.isArray(input[name])) add('schema.top-array', `/${name}`, `${name} 必须是数组。`) })
  if (Array.isArray(input.sources)) input.sources.forEach((source, index) => {
    const p = `/sources/${index}`; if (!isObject(source)) return add('schema.source', p, 'source 必须是对象。'); requireKeys(source, ['id', 'uri', 'v'], p); allowedKeys(source, ['id', 'uri', 'v', 'title', 'origin', 'group', 'retrieved'], p)
    if (typeof source.id !== 'string' || !SOURCE.test(source.id)) add('schema.source-id', `${p}/id`, '来源 ID 必须是 s<正整数>。')
    else if (sourceIds.has(source.id)) add('business.duplicate-id', `${p}/id`, `来源 ID ${source.id} 重复。`); else sourceIds.add(source.id)
    if (!nonempty(source.uri)) add('schema.nonempty', `${p}/uri`, 'uri 必须非空。'); if (!(source.v === null || nonempty(source.v))) add('schema.source-version', `${p}/v`, 'v 必须是非空字符串或 null。')
    if ('title' in source && !nonempty(source.title)) add('schema.nonempty', `${p}/title`, 'title 必须非空。'); if ('origin' in source && !['derived','unknown'].includes(String(source.origin))) add('schema.source-origin', `${p}/origin`, 'origin 必须是 derived 或 unknown。'); if ('group' in source && !nonempty(source.group)) add('schema.nonempty', `${p}/group`, 'group 必须非空。')
  })
  if (Array.isArray(input.evidence)) input.evidence.forEach((ev, index) => {
    const p = `/evidence/${index}`; if (!isObject(ev)) return add('schema.evidence', p, 'evidence 必须是对象。'); requireKeys(ev, ['id', 's', 'loc'], p); allowedKeys(ev, ['id', 's', 'loc', 'quote', 'at', 'speaker', 'role'], p)
    if (typeof ev.id !== 'string' || !EVIDENCE.test(ev.id)) add('schema.evidence-id', `${p}/id`, '证据 ID 必须是 x<正整数>。'); else if (evidenceIds.has(ev.id)) add('business.duplicate-id', `${p}/id`, `证据 ID ${ev.id} 重复。`); else evidenceIds.add(ev.id)
    if (!nonempty(ev.loc)) add('schema.nonempty', `${p}/loc`, 'loc 必须非空。'); if ('at' in ev) time(ev.at, `${p}/at`, false); if ('quote' in ev && !nonempty(ev.quote)) add('schema.nonempty', `${p}/quote`, 'quote 必须非空。'); if ('speaker' in ev && (typeof ev.speaker !== 'string' || !/^e[1-9]\d*$/.test(ev.speaker))) add('schema.speaker', `${p}/speaker`, 'speaker 必须是实体 ID。'); if ('role' in ev && !['mentions','defines','reports','supports','contradicts','describes','sequences','context','identity'].includes(String(ev.role))) add('schema.evidence-role', `${p}/role`, '证据 role 无效。')
  })

  const commonAllowed = ['id', 'i', 'why', 'ev', ...(currentVersion ? ['epistemic'] : []), 'scope', 'event', 'valid', 'status', 'score', 'score_type', 'rev', 'op', 'parents', 'authority', 'limits']
  COLLECTIONS.forEach(kind => { if (!Array.isArray(input[kind])) return; input[kind].forEach((record, index) => {
    const p = `/${kind}/${index}`; if (!isObject(record)) { add('schema.record', p, '记录必须是对象。'); return }
    const id = typeof record.id === 'string' ? record.id : `${kind}[${index}]`; const before = diagnostics.length
    common(record, p, id); if (!IDS[kind].test(String(record.id ?? ''))) add('schema.local-id', `${p}/id`, `ID 前缀与 ${kind} 不匹配。`, undefined, id)
    else if (objectIds.has(String(record.id))) add('business.duplicate-id', `${p}/id`, `全局对象 ID ${record.id} 重复。`, undefined, id); else { objectIds.add(String(record.id)); kindById.set(String(record.id), kind) }
    if (kind === 'entities') {
      requireKeys(record, ['type', 'name'], p, id); allowedKeys(record, [...commonAllowed, 'type', 'name', 'aliases', 'desc', 'identity'], p, id)
      if (!['person','organization','team','project','document','place','system','artifact','other'].includes(String(record.type))) add('schema.entity-type', `${p}/type`, '实体类型无效。', undefined, id)
      if (!nonempty(record.name)) add('schema.nonempty', `${p}/name`, 'name 必须非空。', undefined, id); if ('aliases' in record) stringArray(record.aliases, `${p}/aliases`, 1, true, undefined, id); if ('desc' in record && !nonempty(record.desc)) add('schema.nonempty', `${p}/desc`, 'desc 必须非空。', undefined, id); if ('identity' in record && !['resolved','ambiguous'].includes(String(record.identity))) add('schema.identity', `${p}/identity`, 'identity 必须是 resolved 或 ambiguous。', undefined, id)
    }
    if (kind === 'concepts') {
      requireKeys(record, ['term', 'definition'], p, id); allowedKeys(record, [...commonAllowed, 'term', 'aliases', 'definition', 'criteria', 'excludes'], p, id)
      if (!nonempty(record.term) || !nonempty(record.definition)) add('schema.concept', p, 'term 与 definition 必须非空。', undefined, id); if (!Array.isArray(record.criteria) && !Array.isArray(record.excludes)) add('schema.concept-boundary', p, 'criteria 或 excludes 至少需要一项。', undefined, id)
      for (const field of ['aliases','criteria','excludes']) if (field in record) stringArray(record[field], `${p}/${field}`, 1, field === 'aliases', undefined, id)
    }
    if (kind === 'claims') {
      requireKeys(record, ['text', 'kind', 'about', 'by'], p, id); allowedKeys(record, [...commonAllowed, 'text', 'kind', 'about', 'by', 'if', 'unless', 'reason'], p, id)
      if (!nonempty(record.text)) add('schema.nonempty', `${p}/text`, 'text 必须非空。', undefined, id); if (!['fact','definition','decision','commitment','rule','evaluation','prediction','hypothesis','question','other'].includes(String(record.kind))) add('schema.claim-kind', `${p}/kind`, '主张 kind 无效。', undefined, id)
      stringArray(record.about, `${p}/about`, 1, true, NODE, id); stringArray(record.by, `${p}/by`, 1, true, undefined, id); for (const field of ['if','unless']) if (field in record) stringArray(record[field], `${p}/${field}`, 1, false, undefined, id); if ('reason' in record && !nonempty(record.reason)) add('schema.nonempty', `${p}/reason`, 'reason 必须非空。', undefined, id)
    }
    if (kind === 'events') {
      requireKeys(record, ['type', 'title', 'state', 'args', 'event'], p, id); allowedKeys(record, [...commonAllowed, 'type', 'title', 'desc', 'state', 'args', 'place'], p, id)
      if (!ROLE.test(String(record.type))) add('schema.event-type', `${p}/type`, '事件 type 必须是小写 snake_case。', undefined, id); if (!nonempty(record.title)) add('schema.nonempty', `${p}/title`, 'title 必须非空。', undefined, id); if (!['planned','ongoing','completed','cancelled','unknown'].includes(String(record.state))) add('schema.event-state', `${p}/state`, '事件 state 无效。', undefined, id); roleMap(record.args, `${p}/args`, 1, id); if ('place' in record) stringArray(record.place, `${p}/place`, 1, true, /^e[1-9]\d*$/, id)
    }
    if (kind === 'narratives') {
      requireKeys(record, ['type', 'title', 'thesis', 'mode', 'members'], p, id); allowedKeys(record, [...commonAllowed, 'type', 'title', 'thesis', 'mode', 'members', 'reason', 'alternatives'], p, id)
      if (!['chronology','causal','explanatory','argumentative','decision_rationale','other'].includes(String(record.type))) add('schema.narrative-type', `${p}/type`, '叙事 type 无效。', undefined, id); if (!nonempty(record.title) || !nonempty(record.thesis)) add('schema.narrative-text', p, 'title 与 thesis 必须非空。', undefined, id); if (!['source','agent','mixed'].includes(String(record.mode))) add('schema.narrative-mode', `${p}/mode`, '叙事 mode 无效。', undefined, id)
      if (!Array.isArray(record.members) || record.members.length < 2) add('schema.narrative-members', `${p}/members`, '叙事至少需要两个成员。', undefined, id); else record.members.forEach((member, memberIndex) => { const mp = `${p}/members/${memberIndex}`; if (!isObject(member)) add('schema.narrative-member', mp, '成员必须是对象。', undefined, id); else { requireKeys(member, ['ref','role'], mp, id); allowedKeys(member, ['ref','role'], mp, id); if (typeof member.ref !== 'string' || !/^(?:e|c|q|v|n|r)[1-9]\d*$/.test(member.ref)) add('schema.object-ref', `${mp}/ref`, '成员必须引用知识对象。', undefined, id); if (!ROLE.test(String(member.role))) add('schema.role-name', `${mp}/role`, '成员 role 必须使用小写 snake_case。', undefined, id) } })
      if (['agent','mixed'].includes(String(record.mode)) && (!nonempty(record.reason) || !Array.isArray(record.alternatives) || record.alternatives.length === 0)) add('business.narrative-rationale', p, 'Agent/mixed 叙事必须保存 reason 与 alternatives。', undefined, id); if ('alternatives' in record) stringArray(record.alternatives, `${p}/alternatives`, 1, false, undefined, id)
      if (currentVersion && selectionProfile === 'strong_only' && record.mode !== 'source') add('business.narrative-mode', `${p}/mode`, 'strong_only 只允许 source 叙事。', undefined, id)
    }
    if (kind === 'relations') {
      requireKeys(record, ['p', 'type', 'args'], p, id); allowedKeys(record, [...commonAllowed, 'p', 'type', 'text', 'args', 'claim', 'if', 'unless', 'reason', 'single_source_reason'], p, id)
      if (![0,1,2,3].includes(record.p as number) || !Number.isInteger(record.p)) add('schema.priority', `${p}/p`, 'p 必须为 0 到 3 的整数。', undefined, id); if (!ROLE.test(String(record.type))) add('schema.relation-type', `${p}/type`, '关系 type 必须使用小写 snake_case。', undefined, id); roleMap(record.args, `${p}/args`, 2, id); if (!nonempty(record.text) && !Array.isArray(record.claim)) add('business.relation-readable', p, '关系必须至少提供 claim 或完整 text。', undefined, id); if ('text' in record && !nonempty(record.text)) add('schema.nonempty', `${p}/text`, 'text 必须非空。', undefined, id); if ('claim' in record) stringArray(record.claim, `${p}/claim`, 1, true, /^q[1-9]\d*$/, id); for (const field of ['if','unless']) if (field in record) stringArray(record[field], `${p}/${field}`, 1, false, undefined, id); for (const field of ['reason','single_source_reason']) if (field in record && !nonempty(record[field])) add('schema.nonempty', `${p}/${field}`, `${field} 必须非空。`, undefined, id)
    }
    if (diagnostics.length > before) isolatedIds.add(id)
  }) })

  const nodeIds = new Set([...sourceIds, ...objectIds])
  const checkRef = (ref: unknown, pointer: string, self?: string, expected?: string) => { if (typeof ref !== 'string' || !nodeIds.has(ref)) add('business.broken-ref', pointer, `引用 ${String(ref)} 不存在。`, '修正引用或恢复对应记录。', self); else if (ref === self) add('business.self-ref', pointer, '不允许直接引用自身。', undefined, self); else if (expected && kindById.get(ref) !== expected) add('business.ref-type', pointer, `引用 ${ref} 必须指向 ${expected}。`, undefined, self) }
  if (Array.isArray(input.evidence)) input.evidence.forEach((ev, i) => { if (!isObject(ev)) return; if (!sourceIds.has(String(ev.s))) add('business.broken-source', `/evidence/${i}/s`, `来源 ${String(ev.s)} 不存在。`); if ('speaker' in ev) checkRef(ev.speaker, `/evidence/${i}/speaker`, undefined, 'entities') })
  COLLECTIONS.forEach(kind => { if (!Array.isArray(input[kind])) return; input[kind].forEach((record, i) => { if (!isObject(record)) return; const id = String(record.id); for (const ev of Array.isArray(record.ev) ? record.ev : []) if (!evidenceIds.has(String(ev))) add('business.broken-evidence', `/${kind}/${i}/ev`, `证据 ${String(ev)} 不存在。`, undefined, id) }) })
  if (Array.isArray(input.claims)) input.claims.forEach((claim, i) => { if (!isObject(claim)) return; for (const [j, ref] of (Array.isArray(claim.about) ? claim.about : []).entries()) checkRef(ref, `/claims/${i}/about/${j}`, String(claim.id)); for (const [j, ref] of (Array.isArray(claim.by) ? claim.by : []).entries()) if (typeof ref === 'string' && NODE.test(ref)) checkRef(ref, `/claims/${i}/by/${j}`) })
  if (Array.isArray(input.events)) input.events.forEach((event, i) => { if (!isObject(event)) return; values(event.args).forEach((ref, j) => checkRef(ref, `/events/${i}/args/${j}`, String(event.id))); for (const [j, ref] of (Array.isArray(event.place) ? event.place : []).entries()) checkRef(ref, `/events/${i}/place/${j}`, undefined, 'entities') })
  if (Array.isArray(input.narratives)) input.narratives.forEach((narrative, i) => { if (!isObject(narrative) || !Array.isArray(narrative.members)) return; const refs = narrative.members.map(m => isObject(m) ? m.ref : undefined); refs.forEach((ref, j) => checkRef(ref, `/narratives/${i}/members/${j}/ref`, String(narrative.id))); if (new Set(refs).size < 2) add('business.narrative-distinct', `/narratives/${i}/members`, '叙事至少需要两个不同对象。', undefined, String(narrative.id)) })

  const typeDefs = new Map<string, { p: unknown; roles: unknown[] }>(Object.entries(relationRegistry.types).map(([id, def]) => [id, def]))
  if ('type_defs' in input && !Array.isArray(input.type_defs)) add('schema.type-defs', '/type_defs', 'type_defs 必须是数组。')
  if (Array.isArray(input.type_defs)) input.type_defs.forEach((def, i) => {
    const p = `/type_defs/${i}`; if (!isObject(def)) return add('schema.type-def', p, 'type_defs 项必须是对象。')
    requireKeys(def, ['id','p','v','roles','definition','not'], p); allowedKeys(def, ['id','p','v','roles','definition','not'], p)
    if (!nonempty(def.id) || !ROLE.test(def.id)) add('schema.type-id', `${p}/id`, '自定义类型 ID 必须使用小写 snake_case。'); if (![0,1,2,3].includes(def.p as number) || !Number.isInteger(def.p)) add('schema.priority', `${p}/p`, '自定义类型 p 必须为 0 到 3。'); if (typeof def.v !== 'string' || !/^\d+\.\d+\.\d+$/.test(def.v)) add('schema.semver', `${p}/v`, 'v 必须是 SemVer 三段版本。'); stringArray(def.roles, `${p}/roles`, 2, true, ROLE); if (!nonempty(def.definition) || !nonempty(def.not)) add('schema.type-description', p, 'definition 与 not 必须非空。')
    if (typeDefs.has(String(def.id))) add('business.type-override', `${p}/id`, `不允许覆盖内置类型 ${String(def.id)}。`); else if (nonempty(def.id) && Array.isArray(def.roles)) typeDefs.set(def.id, { p: def.p, roles: def.roles })
  })
  if ('coverage' in input) {
    if (!isObject(input.coverage) || Object.keys(input.coverage).length === 0) add('schema.coverage', '/coverage', 'coverage 必须是非空对象。')
    else { allowedKeys(input.coverage, ['unprocessed','limits'], '/coverage'); if ('limits' in input.coverage) stringArray(input.coverage.limits, '/coverage/limits'); if ('unprocessed' in input.coverage) { if (!Array.isArray(input.coverage.unprocessed) || input.coverage.unprocessed.length === 0) add('schema.unprocessed', '/coverage/unprocessed', 'unprocessed 必须是非空数组。'); else input.coverage.unprocessed.forEach((item, i) => { const p = `/coverage/unprocessed/${i}`; if (!isObject(item)) add('schema.unprocessed-item', p, '未处理来源必须是对象。'); else { requireKeys(item, ['uri','why'], p); allowedKeys(item, ['uri','why'], p); if (!nonempty(item.uri) || !nonempty(item.why)) add('schema.unprocessed-item', p, 'uri 与 why 必须非空。') } }) } }
  }
  if (Array.isArray(input.relations)) input.relations.forEach((relation, i) => {
    if (!isObject(relation)) return; const id = String(relation.id); const p = `/relations/${i}`; const def = typeDefs.get(String(relation.type))
    if (relation.type === 'related_to') add('business.related-to', `${p}/type`, '禁止使用 related_to。', undefined, id)
    if (!def) add('business.unknown-type', `${p}/type`, `未定义关系类型 ${String(relation.type)}。`, '添加合规 type_defs 或修正类型。', id)
    else { if (relation.p !== def.p) add('business.priority-mismatch', `${p}/p`, `p 必须与注册表 P${String(def.p)} 一致。`, undefined, id); const roles = isObject(relation.args) ? new Set(Object.keys(relation.args)) : new Set<string>(); const missing = def.roles.filter(role => typeof role === 'string' && !roles.has(role)); if (missing.length) add('business.missing-role', `${p}/args`, `缺少角色 ${missing.join('、')}。`, undefined, id) }
    const refs = values(relation.args); refs.forEach((ref, j) => checkRef(ref, `${p}/args/${j}`, id)); if (new Set(refs).size < 2) add('business.relation-distinct', `${p}/args`, '关系至少需要两个不同节点。', undefined, id)
    for (const [j, ref] of (Array.isArray(relation.claim) ? relation.claim : []).entries()) checkRef(ref, `${p}/claim/${j}`, undefined, 'claims')
    if (relation.p === 3) { if (!nonempty(relation.reason)) add('business.p3-reason', `${p}/reason`, 'P3 必须保存推理。', undefined, id); if (!Array.isArray(relation.limits) || relation.limits.length === 0) add('business.p3-limits', `${p}/limits`, 'P3 必须保存反例问题或未决条件。', undefined, id); const evs = Array.isArray(relation.ev) ? relation.ev : []; const evidence = Array.isArray(input.evidence) ? input.evidence.filter(isObject) : []; const sources = Array.isArray(input.sources) ? input.sources.filter(isObject) : []; const groups = new Set(evs.map(eid => { const ev = evidence.find(e => e.id === eid); const source = sources.find(s => s.id === ev?.s); return source?.group ?? source?.id }).filter(Boolean)); if (groups.size < 2 && !nonempty(relation.single_source_reason)) add('business.p3-independence', p, 'P3 需要两个独立证据组，或 single_source_reason。', undefined, id) }
  })
  const fatalCodes = new Set([
    'schema.root', 'schema.required', 'schema.additional-property', 'schema.top-array',
    'schema.selection', 'schema.selection-profile', 'schema.selection-policy', 'schema.selection-strength',
    'business.duplicate-id', 'business.selection-strength',
    'version.schema', 'version.rule', 'version.types', 'version.selection',
  ])
  const fatal = diagnostics.some(item => fatalCodes.has(item.code) && (!item.objectId || item.code === 'business.duplicate-id'))
  return { valid: diagnostics.length === 0, fatal, diagnostics, isolatedIds }
}

export function isSupportedDataset(input: unknown): input is KnowledgeDataset {
  if (!isObject(input) || !isObject(input.generated) || input.generated.types !== RELATION_TYPES_VERSION) return false
  return (input.schema === CURRENT_DATASET_SCHEMA && input.generated.rule === CURRENT_EXTRACTOR_RULE)
    || (input.schema === LEGACY_DATASET_SCHEMA && input.generated.rule === LEGACY_EXTRACTOR_RULE)
}
