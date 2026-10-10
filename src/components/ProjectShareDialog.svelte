<script lang="ts">
  import { onMount } from 'svelte'
  import { open, ask } from '@tauri-apps/plugin-dialog'
  import { writeText } from '@tauri-apps/plugin-clipboard-manager'
  import { activeTab, tabs, isDirty, saveTab, reloadTabFromDisk } from '../lib/tabs.svelte'
  import { refreshSotvault, sotvaultStore } from '../lib/sotvault.svelte'
  import { isUnder } from '../lib/sotvault-logic'
  import { loadVaultSettings, vaultSettings } from '../lib/vault-settings.svelte'
  import { modalFocus } from '../lib/ui/modal-focus'
  import { scanProject, type ReferenceIssue } from '../lib/project-share/references'
  import { projectCommand, projectIdentities, publishProject, collaborationLink, pullProjectFeedback, stopProjectShare, rememberProjectLocation, type ProjectIdentity } from '../lib/project-share/host'
  import type { ProjectFile, ProjectInfo, LocalFeedback, ProjectSnapshot, ReviewFile } from '../lib/project-share/types'

  let { onClose }: { onClose: () => void } = $props()
  let busy = $state(false)
  let page = $state<'share' | 'feedback'>('share')
  let contentElement: HTMLDivElement | undefined = $state()
  let pullingFor = $state('')
  let error = $state('')
  let notice = $state('')
  let cloudError = $state('')
  let rebindProjectId = $state('')
  let boundSourceRoot = $state('')
  let projects = $state<Record<string, ProjectIdentity>>({})
  let info = $state<ProjectInfo | null>(null)
  let managementOnly = $state(false)
  let candidates = $state<string[]>([])
  let options = $state<ProjectFile[]>([])
  let files = $state<ProjectFile[]>([])
  let issues = $state<ReferenceIssue[]>([])
  let excluded = $state<string[]>([])
  let inbox = $state<LocalFeedback[]>([])
  let selected = $state<LocalFeedback | null>(null)
  let review = $state<ReviewFile | null>(null)
  let finalText = $state('')
  let oldSnapshot = $state<ProjectSnapshot | null>(null)
  let annotationPath = $state('')
  let mirror = $state<{ path: string; source: ProjectFile; mirror: ProjectFile } | null>(null)

  const pulling = $derived(!!info && pullingFor === info.project_id)
  const identity = $derived(info ? projects[info.project_id] : undefined)
  const blocking = $derived(issues.filter(issue => issue.kind !== 'private'))
  const pending = $derived(identity?.pending)
  const shareUrl = $derived(identity?.url)
  const editableLink = $derived(identity ? collaborationLink(identity) : undefined)
  const oldMarkdown = $derived(oldSnapshot?.files.find(file => file.path === annotationPath)?.markdown)
  const totalBytes = $derived(files.reduce((sum, file) => sum + file.bytes, 0))
  const pendingFeedback = $derived(inbox.filter(item => item.status === 'pending').length)
  const projectName = $derived(info?.sourceRoot.split('/').filter(Boolean).at(-1) ?? '')

  $effect(() => {
    void page
    void info?.project_id
    if (contentElement) contentElement.scrollTop = 0
  })

  function formatSize(bytes: number) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function formatDate(value: string) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  async function run(task: () => Promise<void>) {
    if (busy) return
    busy = true
    error = ''
    notice = ''
    try { await task() } catch (e) { error = String(e) } finally { busy = false }
  }
  function close() { if (!busy) onClose() }
  function rememberProject(project: ProjectInfo) {
    try {
      localStorage.setItem('projectShare.lastProjectId', project.project_id)
      localStorage.setItem('projectShare.lastProject', JSON.stringify({ project_id: project.project_id, sourceRoot: project.sourceRoot, entry: project.entry }))
    } catch { /* selection is only a convenience */ }
  }
  function statusLabel(status: string): string {
    return ({ pending: '待审阅', quarantined: '已隔离，不能应用', accepted: '已接受', rejected: '已拒绝', resolved: '已阅', source_changed: '原件已有变化，请人工对照', mirror_pending: '原件已写入，镜像待处理', recovery_conflict: '恢复状态需人工核对', not_applied: '尚未写入，可重新审阅' } as Record<string, string>)[status] ?? status
  }

  async function loadProject(sourceRoot: string, entry: string, projectId?: string) {
    page = 'share'
    const stored = (projectId ? projects[projectId] : undefined) ?? Object.values(projects).find(project => project.sourceRoot === sourceRoot)
    if (stored?.pending) entry = stored.pending.entry
    boundSourceRoot = sourceRoot
    rebindProjectId = projectId ?? Object.values(projects).find(project => project.sourceRoot === sourceRoot)?.project_id ?? ''
    managementOnly = false
    info = null; inbox = []; selected = null; review = null; mirror = null; oldSnapshot = null; cloudError = ''
    options = []; files = []; issues = []; excluded = []
    let opened: ProjectInfo
    let restoredManagement = false
    try { opened = await projectCommand<ProjectInfo>('open', { sourceRoot, entry }) } catch (e) {
      const saved = Object.values(projects).find(project => project.sourceRoot === sourceRoot && project.entry === entry && (project.pending || project.publishedSnapshotId))
      const snapshotId = saved?.pending?.snapshotId ?? saved?.publishedSnapshotId
      if (!saved || !snapshotId) throw e
      const snapshot = await projectCommand<ProjectSnapshot>('snapshot-get', { project_id: saved.project_id, snapshotId })
      opened = { project_id: saved.project_id, sourceRoot, mirrorRoot: '', entry: snapshot.entry, files: snapshot.files.map(file => file.path), publishedSnapshotId: saved.publishedSnapshotId, url: saved.url }
      restoredManagement = true
      notice = saved.pending
        ? '当前入口不可读取，已恢复上次冻结的发布原包；可原样重试，不会读取或覆盖当前原件。'
        : '当前入口不可读取，已恢复已发布项目的反馈管理。可审阅其他文件、检查反馈或停止分享；修复入口或选择有效入口并重新扫描后才能再次发布。'
    }
    info = opened
    managementOnly = restoredManagement
    rebindProjectId = opened.project_id
    try { candidates = await projectCommand<string[]>('list', { project_id: opened.project_id }) } catch (e) {
      if (!restoredManagement) throw e
      candidates = []
    }
    if (!candidates.includes(opened.entry)) candidates = [opened.entry, ...candidates]
    files = []; options = []; issues = []; excluded = []
    selected = null; review = null; mirror = null; oldSnapshot = null
    rememberProject(opened)
    inbox = await projectCommand<LocalFeedback[]>('inbox', { project_id: opened.project_id })
    // Reopening an existing share keeps its last approved scope; new references start unchecked.
    if (!restoredManagement) await scan(opened.files.length ? new Set(opened.files) : undefined)
    void checkFeedback()
  }
  async function initialize() {
    projects = await projectIdentities()
    let last: string | null = null
    let local: { project_id?: string; sourceRoot?: string; entry?: string } | null = null
    try {
      last = localStorage.getItem('projectShare.lastProjectId')
      local = JSON.parse(localStorage.getItem('projectShare.lastProject') ?? 'null')
    } catch { /* no persisted selection */ }
    const previous = (last && projects[last]) || (typeof local?.sourceRoot === 'string' && typeof local.entry === 'string' ? { project_id: typeof local.project_id === 'string' ? local.project_id : undefined, sourceRoot: local.sourceRoot, entry: local.entry } : undefined) || Object.values(projects).at(-1)
    if (previous) await loadProject(previous.sourceRoot, previous.entry, previous.project_id)
  }
  onMount(() => { void run(initialize) })

  async function chooseProject() {
    const root = await open({ directory: true, multiple: false, title: '选择项目根目录' })
    if (typeof root !== 'string') return
    let entryPath = activeTab()?.filePath
    if (!entryPath || !isUnder(entryPath, root) || !/\.(md|markdown|mdown|mkd|mdx)$/i.test(entryPath)) {
      const picked = await open({ defaultPath: root, multiple: false, title: '选择项目入口 Markdown', filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] }] })
      if (typeof picked !== 'string') return
      entryPath = picked
    }
    if (!isUnder(entryPath, root) || entryPath === root) throw new Error('入口必须位于所选项目根目录内')
    projects = await projectIdentities()
    await loadProject(root, entryPath.slice(root.replace(/\/$/, '').length + 1))
  }
  async function rebindProject() {
    if (!rebindProjectId) return
    const id = rebindProjectId
    const picked = await open({ directory: true, multiple: false, title: '重新选择此项目的源根目录' })
    if (typeof picked !== 'string') return
    await refreshSotvault()
    const oldRoot = info?.sourceRoot ?? projects[id]?.sourceRoot ?? boundSourceRoot
    const mirrorPaths = new Set(sotvaultStore.records.filter(record => record.project_id === id).map(record => record.vault_path))
    for (const tab of tabs.filter(tab => mirrorPaths.has(tab.filePath) || !!oldRoot && isUnder(tab.filePath, oldRoot))) window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: tab.id } }))
    if (tabs.some(tab => isDirty(tab.id) && (mirrorPaths.has(tab.filePath) || !!oldRoot && isUnder(tab.filePath, oldRoot)))) throw new Error('请先处理该项目原件和镜像中未保存的修改，再重新绑定。')
    await loadVaultSettings()
    if (!vaultSettings.vaultPath) throw new Error('请先配置当前 Vault')
    const expectedMirror = `${vaultSettings.vaultPath.replace(/\/$/, '')}/${vaultSettings.syncDir}/${id}`
    if (!await ask(`重新绑定已有项目？\n\n项目 ID：${id}\n当前镜像：${expectedMirror}\n新的源根：${picked}\n\n必须已有上述镜像目录；此操作不会搬动目录，并会核验现有文件。`, { title: '重新绑定项目目录' })) return
    const rebound = await projectCommand<ProjectInfo>('rebind', { project_id: id, sourceRoot: picked })
    await rememberProjectLocation(rebound)
    projects = await projectIdentities()
    await loadProject(rebound.sourceRoot, rebound.entry, id)
    notice = '项目已重新绑定，项目 ID、发布历史和反馈保持不变。'
  }
  async function changeEntry(entry: string) {
    if (!info || !entry) return
    await loadProject(info.sourceRoot, entry)
  }

  async function prepareBuffers(sourcePath?: string) {
    if (!info) return
    await refreshSotvault()
    const sourcePaths = new Set(sourcePath ? [sourcePath] : files.map(file => `${info!.sourceRoot}/${file.path}`))
    if (!sourcePath) {
      const approvedMirrors = new Set(files.map(file => `${info!.mirrorRoot}/${file.path}`))
      for (const record of sotvaultStore.records) {
        if (record.project_id === info.project_id && approvedMirrors.has(record.vault_path)) sourcePaths.add(record.source_path)
      }
    }
    const related = sotvaultStore.records.filter(record => sourcePaths.has(record.source_path))
    const mirrors = new Set(related.map(record => record.vault_path))
    const relatedTabs = tabs.filter(tab => sourcePaths.has(tab.filePath) || mirrors.has(tab.filePath))
    for (const tab of relatedTabs) window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: tab.id } }))
    const dirtyMirrors = relatedTabs.filter(tab => mirrors.has(tab.filePath) && isDirty(tab.id))
    const dirtySources = relatedTabs.filter(tab => sourcePaths.has(tab.filePath) && !mirrors.has(tab.filePath) && isDirty(tab.id))
    // Preserve mirror buffers before saving any source, so a conflict is visible instead of losing unsaved mirror edits.
    for (const tab of [...dirtyMirrors, ...dirtySources]) {
      await saveTab(tab.id)
      if (isDirty(tab.id)) throw new Error(`请先保存或处理未保存的文件：${tab.filePath}`)
    }
  }
  async function scan(approved?: Set<string>) {
    if (!info) return
    const project = info
    candidates = await projectCommand<string[]>('list', { project_id: project.project_id })
    const previous = options
    const read = (path: string): Promise<ProjectFile> => excluded.includes(path)
      ? Promise.resolve({ path, hash: '', bytes: 0 })
      : projectCommand<ProjectFile>('read', { project_id: project.project_id, path })
    let result = await scanProject(project.entry, candidates, read)
    options = result.files.map(file => excluded.includes(file.path) ? previous.find(prior => prior.path === file.path) ?? file : file)
    if (approved) {
      const newPaths = result.files.filter(file => file.path !== project.entry && !approved.has(file.path) && !excluded.includes(file.path)).map(file => file.path)
      if (newPaths.length) {
        excluded = [...excluded, ...newPaths]
        result = await scanProject(project.entry, candidates, read)
        options = result.files.map(file => options.find(prior => prior.path === file.path) ?? file)
      }
    }
    files = result.files.filter(file => !excluded.includes(file.path))
    issues = result.issues
    mirror = null
  }
  async function toggleFile(path: string, checked: boolean) {
    if (!info || path === info.entry) return
    excluded = checked ? excluded.filter(item => item !== path) : [...new Set([...excluded, path])]
    await scan()
  }
  async function excludeDocument(path: string) {
    if (!info || path === info.entry) return
    excluded = [...new Set([...excluded, path])]
    await scan()
  }
  async function saveAndScan() {
    if (managementOnly && info) {
      info = await projectCommand<ProjectInfo>('open', { sourceRoot: info.sourceRoot, entry: info.entry })
      managementOnly = false
    }
    const approved = new Set(files.length ? files.map(file => file.path) : info?.files ?? [])
    await prepareBuffers()
    await scan(approved.size ? approved : undefined)
    notice = '已保存批准文件及关联镜像的修改并重新核对引用；新发现的文件默认不分享。'
  }
  async function publish() {
    if (!info) return
    const project = info
    try {
      if (!pending) {
        if (managementOnly) throw new Error('请先修复入口或选择有效入口并重新扫描，再发布当前原件。')
        const approved = new Set(files.map(file => file.path))
        await prepareBuffers()
        await scan(approved)
        if (blocking.length) throw new Error('请先处理下方引用问题，再发布。入口中的问题需修改原文或调整项目根目录。')
        if (!files.some(file => file.path === project.entry)) throw new Error('必须包含入口文档')
      }
      const published = await publishProject(project, pending ? [] : files)
      info = published.info
      projects = { ...projects, [project.project_id]: published.identity }
      notice = '项目已发布。原件保存只刷新镜像；后续修改仍需手动重新发布。'
      await refreshSotvault()
    } catch (e) {
      projects = await projectIdentities()
      if (projects[project.project_id]?.pending) throw new Error(`发布结果未确认。本机已保留原包，下次点击“重试原包发布”会使用相同地址和内容。\n${String(e)}`)
      throw e
    }
  }
  async function copy(link: string | undefined) {
    if (!link) return
    await writeText(link)
    notice = '链接已复制。'
  }
  async function stop() {
    if (!info || !identity) return
    if (!await ask('停止此项目分享？本机原件、镜像、快照和反馈都会保留。', { title: '停止项目分享' })) return
    try {
      await stopProjectShare(info.project_id)
      projects = await projectIdentities()
      notice = '分享服务已确认停止分享；已下载的副本及缓存可能仍然存在。'
    } catch (e) {
      projects = await projectIdentities()
      throw new Error(`停止结果未确认，已保留本地分享记录，可再次检查或停止。\n${String(e)}`)
    }
  }

  async function checkFeedback() {
    if (!info || pullingFor === info.project_id) return
    const id = info.project_id
    pullingFor = id; cloudError = ''
    try {
      const local = await projectCommand<LocalFeedback[]>('inbox', { project_id: id })
      if (info?.project_id === id) inbox = local
      try {
        const pulled = await pullProjectFeedback(id)
        if (info?.project_id === id) inbox = pulled
      } catch (e) {
        if (info?.project_id === id) cloudError = `暂时无法检查云端反馈；本机已保存的反馈仍可审阅。${String(e)}`
      }
      if (info?.project_id === id && selected) selected = inbox.find(item => item.envelope.payload.submissionId === selected!.envelope.payload.submissionId) ?? selected
    } catch (e) { if (info?.project_id === id) cloudError = String(e) } finally { if (pullingFor === id) pullingFor = '' }
  }
  async function selectFeedback(item: LocalFeedback) {
    selected = item; review = null; finalText = ''; oldSnapshot = null; annotationPath = ''
    if (!info || item.status === 'quarantined' || !item.envelope.payload.annotations.length) return
    oldSnapshot = await projectCommand<ProjectSnapshot>('snapshot-get', { project_id: info.project_id, snapshotId: item.envelope.payload.snapshotId })
    annotationPath = item.envelope.payload.annotations[0].path
  }
  async function selectReview(path: string) {
    if (!info || !selected) return
    const initial = await projectCommand<ReviewFile>('review', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, path })
    await prepareBuffers(initial.sourcePath)
    review = await projectCommand<ReviewFile>('review', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, path })
    finalText = review.after
  }
  function updateFeedback(updated: LocalFeedback) {
    selected = updated
    inbox = inbox.map(item => item.envelope.payload.submissionId === updated.envelope.payload.submissionId ? updated : item)
  }
  async function applyReview() {
    if (!info || !selected || !review) return
    const original = review
    await prepareBuffers(original.sourcePath)
    const fresh = await projectCommand<ReviewFile>('review', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, path: original.path })
    review = fresh
    if (fresh.currentHash !== original.currentHash) {
      notice = '原件在审阅期间变化。已更新“当前原件”，保留你的最终文本；请重新对照后再点击接受。'
      return
    }
    const updated = await projectCommand<LocalFeedback>('apply', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, path: fresh.path, expectedHash: fresh.currentHash, content: finalText })
    updateFeedback(updated)
    await reloadTabFromDisk(fresh.sourcePath)
    await refreshSotvault()
    for (const record of sotvaultStore.records.filter(record => record.source_path === fresh.sourcePath)) await reloadTabFromDisk(record.vault_path)
    review = await projectCommand<ReviewFile>('review', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, path: fresh.path })
    notice = statusLabel(updated.decisions[fresh.path]?.status ?? updated.status)
  }
  async function reject(path?: string) {
    if (!info || !selected) return
    updateFeedback(await projectCommand<LocalFeedback>('reject', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId, ...(path ? { path } : {}) }))
    review = null
  }
  async function resolve() {
    if (!info || !selected) return
    updateFeedback(await projectCommand<LocalFeedback>('resolve', { project_id: info.project_id, submissionId: selected.envelope.payload.submissionId }))
  }
  async function viewMirror(path: string) {
    if (!info) return
    await refreshSotvault()
    const sourcePath = sotvaultStore.records.find(record => record.vault_path === `${info!.mirrorRoot}/${path}`)?.source_path ?? `${info.sourceRoot}/${path}`
    await prepareBuffers(sourcePath)
    const view = await projectCommand<{ source: ProjectFile; mirror: ProjectFile }>('mirror', { project_id: info.project_id, path })
    mirror = { path, ...view }
  }
  async function resolveMirror() {
    if (!info || !mirror) return
    const view = mirror
    await projectCommand<ProjectInfo>('resolve-mirror', { project_id: info.project_id, path: view.path, expectedSourceHash: view.source.hash, expectedMirrorHash: view.mirror.hash })
    await reloadTabFromDisk(`${info.mirrorRoot}/${view.path}`)
    await refreshSotvault()
    await scan(new Set(files.map(file => file.path)))
    notice = '已按刚才审阅的源版本覆盖镜像，并重新核对分享范围。'
  }
</script>

<div class="overlay" role="presentation" onclick={event => { if (event.target === event.currentTarget) close() }}>
  <div class="dialog ui-surface" role="dialog" aria-modal="true" aria-labelledby="project-share-title" aria-busy={busy} tabindex="-1" use:modalFocus={{ onClose: close, canClose: () => !busy }}>
    <header class="dialog-header">
      <h2 id="project-share-title">分享项目</h2>
      <span class="current-page">{page === 'share' ? '分享内容' : '反馈收件箱'}</span>
    </header>
    <div class="share-layout">
      <aside class="sidebar">
        <nav aria-label="项目分享">
          <button class:active={page === 'share'} aria-current={page === 'share' ? 'page' : undefined} disabled={busy} onclick={() => page = 'share'}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M8 10h4M8 13h4" /></svg>
            <span>分享内容</span>
          </button>
          <button class:active={page === 'feedback'} aria-current={page === 'feedback' ? 'page' : undefined} disabled={busy || !info} onclick={() => page = 'feedback'}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 3.5h14v10H8l-4 3v-3H3zM6 7h8M6 10h5" /></svg>
            <span>反馈收件箱</span>{#if pendingFeedback}<span class="count" aria-label={`${pendingFeedback} 份待审阅`}>{pendingFeedback}</span>{/if}
          </button>
        </nav>
        {#if info || Object.keys(projects).length}
          <div class="project-switch">
            {#if Object.keys(projects).length}
              <label for="share-recent-project">最近项目</label>
              <select id="share-recent-project" disabled={busy} value={info?.project_id ?? ''} onchange={event => { const item = projects[event.currentTarget.value]; if (item) void run(() => loadProject(item.sourceRoot, item.entry, item.project_id)) }}>
                <option value="">选择项目</option>
                {#each Object.values(projects) as item (item.project_id)}<option value={item.project_id}>{item.sourceRoot.split('/').filter(Boolean).at(-1)} — {item.sourceRoot}</option>{/each}
              </select>
            {/if}
            <button data-initial-focus disabled={busy} onclick={() => run(chooseProject)}>选择项目…</button>
          </div>
        {/if}
      </aside>
      <div class="content" bind:this={contentElement} role="region" aria-label={page === 'share' ? '分享内容' : '反馈收件箱'}>
        {#if error}<p class="message error" role="alert">{error}</p>{/if}
        {#if notice}<p class="message notice" role="status">{notice}</p>{/if}
        {#if info}
          <div class="project-heading">
            <div class="project-title"><h3>{projectName}</h3><span class="badge">{pending ? '发布待确认' : shareUrl ? '已分享' : '未发布'}</span></div>
            <p class="path">{info.sourceRoot}</p>
          </div>
          {#if page === 'share'}
            <section class="entry-section">
              <label class="field-row" for="share-entry"><span>入口文档</span><select id="share-entry" value={info.entry} disabled={busy || !!pending} onchange={event => run(() => changeEntry(event.currentTarget.value))}>{#each candidates as path (path)}<option value={path}>{path}</option>{/each}</select></label>
              <p class="desc">从这篇文档开始，包含你勾选的引用文档和资源。</p>
              {#if pending}<p class="message warning">上次发布结果尚未确认。重试会发送已冻结的原包（入口 {pending.entry}），不包含此后编辑的内容。</p>{/if}
              {#if managementOnly && !pending}<p class="message warning">入口暂时无法读取。仍可管理分享和反馈；重新选择有效入口并扫描后可再次发布。</p>{/if}
            </section>
            <section>
              <div class="section-heading"><h3>分享文件 <span class="section-meta">{files.length} 个 · {formatSize(totalBytes)}</span></h3><button disabled={busy} onclick={() => run(saveAndScan)}>保存并重新扫描</button></div>
              <p class="desc">仅分享勾选的文件，个人手记和私密配置会自动排除。</p>
              <div class="file-list" aria-label="分享文件">
                {#each options as file (file.path)}
                  <div class="file-row">
                    <label><input type="checkbox" checked={!excluded.includes(file.path)} disabled={busy || file.path === info.entry || !!pending} onchange={event => run(() => toggleFile(file.path, event.currentTarget.checked))} /><span class="file-path">{file.path}</span>{#if file.path === info.entry}<span class="badge">入口</span>{/if}</label>
                    <span class="file-size">{formatSize(file.bytes)}</span>
                    {#if info.files.includes(file.path)}<button class="subtle" disabled={busy} onclick={() => run(() => viewMirror(file.path))}>镜像对照</button>{/if}
                  </div>
                {/each}
                {#if !options.length}<p class="list-empty">{managementOnly ? '修复入口后可重新扫描文件。' : '暂时没有可分享的文件。'}</p>{/if}
              </div>
              {#if issues.length}<details class="reference-issues" open={blocking.length > 0}><summary>{blocking.length ? `${blocking.length} 个引用问题需要处理` : '查看已排除的私密引用'}</summary><ul class="issues">{#each issues as issue}<li class:warning={issue.kind !== 'private'}><strong>{issue.from}</strong> → {issue.target}：{issue.message}{#if issue.from !== info.entry}<button disabled={busy || !!pending} onclick={() => run(() => excludeDocument(issue.from))}>排除此文档并重扫</button>{/if}</li>{/each}</ul></details>{/if}
              {#if blocking.length}<p class="warning desc">处理缺失、越界或同名歧义后才能发布。可修改原文、调整项目目录，或排除有问题的非入口文档。</p>{/if}
            </section>
            {#if mirror}<section class="mirror-review"><h3>镜像对照：{mirror.path}</h3><div class="columns two"><div><h4>当前源文件</h4><pre>{mirror.source.markdown ?? `${mirror.source.bytes} bytes\n${mirror.source.hash}`}</pre></div><div><h4>当前镜像</h4><pre>{mirror.mirror.markdown ?? `${mirror.mirror.bytes} bytes\n${mirror.mirror.hash}`}</pre></div></div><p>确认后只用上面显示的源版本覆盖这份镜像；任一文件再变化都会要求重新审阅。</p><div class="actions"><button class="primary" disabled={busy} onclick={() => run(resolveMirror)}>确认用源版本覆盖镜像</button><button disabled={busy} onclick={() => mirror = null}>取消</button></div></section>{/if}
            {#if shareUrl}
              <section>
                <div class="section-heading"><h3>分享链接</h3><span class="section-meta">{identity?.expiresAt === null ? '长期有效' : identity?.expiresAt ? `有效期至 ${formatDate(identity.expiresAt)}` : ''}</span></div>
                <div class="field-row"><label for="share-read-link">阅读链接</label><input id="share-read-link" readonly value={shareUrl} /><button disabled={busy} onclick={() => run(() => copy(shareUrl))}>复制阅读链接</button></div>
                <div class="collaboration-row"><p class="desc">协作链接允许对方编辑和标注，修改由你审阅后合入。</p><button disabled={busy || !editableLink} onclick={() => run(() => copy(editableLink))}>复制协作链接</button></div>
              </section>
            {/if}
            <details class="project-management">
              <summary>项目管理</summary>
              <p class="desc">目录移动后可重新绑定；停止分享会保留本机文件和已收到的反馈。</p>
              <div class="actions">
                {#if rebindProjectId}<button disabled={busy} onclick={() => run(rebindProject)}>重新绑定项目目录…</button>{/if}
                {#if shareUrl || pending}<button class="danger" disabled={busy} onclick={() => run(stop)}>{pending && !shareUrl ? '停止待确认的分享…' : '停止分享…'}</button>{/if}
              </div>
            </details>
          {:else}
            <section><div class="section-heading"><h3>反馈收件箱（{inbox.length}）</h3><button disabled={busy || pulling} onclick={() => { void checkFeedback() }}>{pulling ? '正在检查云端…' : '检查新反馈'}</button></div>{#if cloudError}<p class="warning">{cloudError}</p>{/if}{#if !inbox.length}<p>暂时没有本机反馈。打开分享时会尝试取回云端收件。</p>{/if}<div class="inbox-list">{#each inbox as item (item.envelope.payload.submissionId)}<button class:selected={selected?.envelope.payload.submissionId === item.envelope.payload.submissionId} disabled={busy} onclick={() => run(() => selectFeedback(item))}><strong>{item.envelope.payload.name || '未署名协作者'}</strong><span>{formatDate(item.envelope.receivedAt)} · {statusLabel(item.status)} · {item.envelope.payload.edits.length} 处编辑 / {item.envelope.payload.annotations.length} 条标注</span></button>{/each}</div>
          {#if selected}<div class="feedback-detail"><h4>{selected.envelope.payload.name || '未署名协作者'} · {statusLabel(selected.status)}</h4>{#if selected.error}<p class="warning">{selected.error}</p>{/if}{#if selected.status === 'quarantined'}<p class="warning">这份反馈的快照、文件集合或基线不可信，已保留原包但不能写回原件。</p>{:else}<div class="actions"><button disabled={busy || selected.status === 'accepted'} onclick={() => run(() => reject())}>拒绝整份反馈</button>{#if !selected.envelope.payload.edits.length}<button disabled={busy || selected.status === 'resolved'} onclick={() => run(resolve)}>标注已阅</button>{/if}</div>{/if}
            {#each selected.envelope.payload.edits as edit (edit.path)}<div class="edit-row"><span>{edit.path} · {statusLabel(selected.decisions[edit.path]?.status ?? 'pending')}</span><button disabled={busy || selected.status === 'quarantined'} onclick={() => run(() => selectReview(edit.path))}>审阅文件</button><button disabled={busy || selected.status === 'quarantined' || ['accepted', 'rejected', 'mirror_pending'].includes(selected.decisions[edit.path]?.status ?? '')} onclick={() => run(() => reject(edit.path))}>拒绝此文件</button></div>{/each}
            {#if review}<h3>文件审阅：{review.path}</h3><p>{statusLabel(review.status)} · {review.sourcePath}</p><div class="columns"><div><h4>发布时的基线</h4><pre>{review.base}</pre></div><div><h4>当前原件</h4><pre>{review.current}</pre></div><div><h4>协作者提交</h4><pre>{review.after}</pre></div></div><label>最终写回文本（可人工合入）<textarea bind:value={finalText} disabled={busy || ['accepted', 'rejected', 'mirror_pending', 'recovery_conflict'].includes(review.status)} spellcheck="false" rows="12"></textarea></label><button class="primary" disabled={busy || ['accepted', 'rejected', 'mirror_pending', 'recovery_conflict'].includes(review.status)} onclick={() => run(applyReview)}>接受此文件并写回原件</button>{/if}
            {#if selected.envelope.payload.annotations.length}<h3>旧快照中的标注</h3><p>以下选文和评论保留在提交时的快照中，不会自动迁移到当前正文。</p>{#each selected.envelope.payload.annotations as annotation}<article class="annotation"><button disabled={busy || !oldSnapshot} onclick={() => annotationPath = annotation.path}>{annotation.path}</button><blockquote>{annotation.quote}</blockquote><p>{annotation.comment}</p></article>{/each}{#if oldMarkdown !== undefined}<details open><summary>{annotationPath} · 提交时原文</summary><pre>{oldMarkdown}</pre></details>{/if}{/if}
          </div>{/if}
        </section>
          {/if}
        {:else}
          <div class="empty-state">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M6 14a3 3 0 0 1 3-3h10l4 5h16a3 3 0 0 1 3 3v17a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM24 31V21m-4 4 4-4 4 4" /></svg>
            <h3>分享整个项目的文档</h3>
            <p>选择项目目录与入口文档，把相关引用一起分享。<br />对方可在浏览器编辑和标注，收到的修改由你审阅。</p>
            <button class="primary" data-initial-focus disabled={busy} onclick={() => run(chooseProject)}>选择项目…</button>
            <p class="desc">支持 Vault 外的目录。请先配置 Vault 和分享服务。</p>
            {#if rebindProjectId}<button disabled={busy} onclick={() => run(rebindProject)}>重新绑定项目目录…</button>{/if}
          </div>
        {/if}
      </div>
    </div>
    <footer>
      <span class="footer-status">{busy ? '正在处理…' : info && page === 'share' ? pending ? '将重试上次保留的发布内容。' : `${files.length} 个文件 · 修改后需重新发布` : info ? '审阅并接受后，修改才会写入原文档。' : '原文档保留在你的项目目录中。'}</span>
      <button disabled={busy} onclick={close}>完成</button>
      {#if info && page === 'share'}<button disabled={busy || (!pending && (managementOnly || !files.length || !!blocking.length))} class="primary" onclick={() => run(publish)}>{pending ? '重试原包发布' : identity?.url ? '更新分享' : '发布分享'}</button>{/if}
    </footer>
  </div>
</div>

<style>
  .overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
  .dialog { width: min(1000px, calc(100vw - 48px)); height: min(780px, calc(100dvh - 48px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--ui-separator); border-radius: 12px; background: var(--ui-surface); box-shadow: 0 12px 40px rgba(0,0,0,.25); }
  .dialog-header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 16px; padding: 18px 22px; border-bottom: 1px solid var(--ui-separator); flex-shrink: 0; }
  h2 { margin: 0; font-size: 17px; font-weight: 600; }
  h3, h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
  p { margin: 8px 0; line-height: 1.5; }
  .current-page, .desc, .section-meta, .footer-status { color: var(--ui-secondary); }
  .desc, .section-meta, .footer-status { font-size: 12px; }
  .share-layout { display: grid; grid-template-columns: 182px minmax(0,1fr); flex: 1; min-height: 0; }
  .sidebar { display: flex; flex-direction: column; gap: 24px; min-height: 0; overflow: auto; padding: 12px; background: var(--ui-bg); border-right: 1px solid var(--ui-separator); }
  nav { display: flex; flex-direction: column; gap: 4px; }
  nav button { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 0; background: transparent; text-align: start; border-radius: 7px; }
  nav button.active { background: var(--ui-selection); font-weight: 600; }
  nav svg { width: 18px; height: 18px; flex-shrink: 0; }
  .count { margin-left: auto; font-size: 12px; font-variant-numeric: tabular-nums; }
  .project-switch { display: grid; gap: 8px; margin-top: auto; min-width: 0; }
  .project-switch label { color: var(--ui-secondary); font-size: 12px; }
  .project-switch select { width: 100%; }
  .content { overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable; padding: 22px 26px; min-width: 0; min-height: 0; }
  .project-heading { margin-bottom: 20px; }
  .project-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .project-title h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
  .path { margin: 6px 0 0; color: var(--ui-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .badge { border-radius: 4px; background: var(--ui-bg); border: 1px solid var(--ui-separator); padding: 1px 6px; font-size: 12px; white-space: nowrap; color: var(--ui-secondary); }
  section { padding: 20px 0; border-top: 1px solid var(--ui-separator); }
  .entry-section { padding-top: 0; border-top: 0; }
  .section-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px 12px; margin-bottom: 8px; }
  .section-heading h3 { margin: 0; }
  .section-meta { font-weight: 400; margin-left: 6px; overflow-wrap: anywhere; }
  button { min-height: 32px; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--ui-control-border); background: var(--ui-surface); color: CanvasText; cursor: pointer; line-height: 1.4; overflow-wrap: anywhere; }
  button:not(:disabled):hover { background: var(--ui-hover); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--ui-accent); border-color: var(--ui-accent); color: var(--ui-accent-foreground); font-weight: 500; }
  button.primary:not(:disabled):hover { background: color-mix(in srgb, var(--ui-accent) 88%, black); }
  button.danger { color: var(--ui-danger); }
  button.subtle { border-color: transparent; background: transparent; color: var(--ui-secondary); font-size: 12px; padding: 4px 8px; }
  input:not([type='checkbox']), select, textarea { min-width: 0; min-height: 32px; padding: 6px 9px; border: 1px solid var(--ui-control-border); border-radius: 6px; color: CanvasText; background: var(--ui-surface); }
  input[readonly] { color: var(--ui-secondary); background: var(--ui-bg); }
  .field-row { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
  .field-row > span, .field-row > label { width: 70px; flex-shrink: 0; }
  .field-row select, .field-row input { flex: 1; width: 0; }
  .collaboration-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .collaboration-row button { flex-shrink: 0; }
  .file-list { margin-top: 12px; max-height: 264px; overflow: auto; border: 1px solid var(--ui-separator); border-radius: 6px; }
  .file-row { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-bottom: 1px solid var(--ui-separator); min-height: 36px; }
  .file-row:last-child { border-bottom: 0; }
  .file-row label { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; cursor: pointer; }
  .file-row input { flex-shrink: 0; margin: 0; }
  .file-path { min-width: 0; overflow-wrap: anywhere; }
  .file-size { font-size: 12px; color: var(--ui-secondary); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .file-row button { flex-shrink: 0; }
  .list-empty { padding: 10px; color: var(--ui-secondary); }
  .message { padding: 10px 12px; margin: 0 0 16px; border-radius: 6px; background: var(--ui-bg); white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { color: var(--ui-danger); } .warning { color: var(--ui-warning); } .notice { color: var(--ui-success); }
  .reference-issues { margin-top: 12px; }
  .issues { padding-left: 20px; font-size: 12px; } .issues li { line-height: 1.6; margin: 8px 0; overflow-wrap: anywhere; } .issues button { margin: 4px 0; }
  .project-management { padding: 16px 0 0; border-top: 1px solid var(--ui-separator); }
  summary { cursor: pointer; color: var(--ui-secondary); }
  .project-management[open] summary { margin-bottom: 12px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
  .columns { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; margin: 12px 0; } .columns.two { grid-template-columns: repeat(2,minmax(0,1fr)); } .columns > div { min-width: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--ui-separator); border-radius: 6px; background: var(--ui-bg); font: 12px/1.6 ui-monospace, Menlo, monospace; max-height: 340px; overflow: auto; margin: 0 0 10px; }
  .feedback-detail { padding-top: 20px; overflow-wrap: anywhere; }
  .feedback-detail > label { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
  textarea { width: 100%; font-family: ui-monospace, Menlo, monospace; resize: vertical; }
  .inbox-list { display: grid; border: 1px solid var(--ui-separator); border-radius: 6px; overflow: hidden; }
  .inbox-list:empty { display: none; }
  .inbox-list button { display: flex; flex-direction: column; text-align: left; gap: 5px; border: 0; border-bottom: 1px solid var(--ui-separator); border-radius: 0; padding: 12px; }
  .inbox-list button:last-child { border-bottom: 0; }
  .inbox-list button.selected { background: var(--ui-selection); }
  .inbox-list span { color: var(--ui-secondary); font-size: 12px; }
  .edit-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--ui-separator); } .edit-row span { flex: 1; min-width: 0; }
  .annotation { padding: 12px; margin: 10px 0; border: 1px solid var(--ui-separator); border-radius: 6px; } blockquote { white-space: pre-wrap; margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--ui-control-border); } .annotation p { white-space: pre-wrap; }
  .empty-state { display: flex; min-height: 100%; flex-direction: column; justify-content: center; align-items: center; text-align: center; box-sizing: border-box; gap: 12px; padding: 24px 0; }
  .empty-state svg { width: 48px; height: 48px; color: var(--ui-secondary); }
  .empty-state h3 { font-size: 16px; margin: 0; } .empty-state p { color: var(--ui-secondary); margin: 0; }
  footer { display: flex; align-items: center; gap: 8px; padding: 12px 22px; border-top: 1px solid var(--ui-separator); flex-shrink: 0; }
  .footer-status { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  footer button { flex-shrink: 0; }
  @media (max-width: 760px) {
    .dialog { width: calc(100vw - 24px); height: calc(100dvh - 24px); }
    .dialog-header { padding: 14px 16px; }
    .share-layout { grid-template-columns: minmax(0,1fr); grid-template-rows: auto minmax(0,1fr); }
    .sidebar { padding: 8px; border-right: 0; border-bottom: 1px solid var(--ui-separator); gap: 8px; max-height: 180px; }
    nav { flex-direction: row; } nav button { flex: 1; }
    .project-switch { display: flex; align-items: center; margin: 0; } .project-switch label { flex-shrink: 0; } .project-switch select { flex: 1; min-width: 0; width: 0; } .project-switch button { flex-shrink: 0; }
    .content { padding: 18px 16px; }
    .columns, .columns.two { grid-template-columns: minmax(0,1fr); }
    footer { padding: 12px 16px; }
  }
  @media (max-width: 480px) {
    .field-row { flex-wrap: wrap; gap: 8px; } .field-row > span, .field-row > label { width: 100%; } .field-row select { width: 100%; flex-basis: 100%; }
    .collaboration-row { align-items: flex-start; flex-direction: column; gap: 4px; }
    .file-row { flex-wrap: wrap; gap: 6px; } .file-row label { flex-basis: 100%; }
    footer { flex-wrap: wrap; justify-content: flex-end; } .footer-status { flex-basis: 100%; }
  }
</style>
