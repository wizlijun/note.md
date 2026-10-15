<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { open, ask } from '@tauri-apps/plugin-dialog'
  import { writeText } from '@tauri-apps/plugin-clipboard-manager'
  import { activeTab, tabs, isDirty, saveTab, saveAs, closeTab, reloadTabFromDisk } from '../lib/tabs.svelte'
  import { refreshSotvault, sotvaultStore } from '../lib/sotvault.svelte'
  import { isUnder } from '../lib/sotvault-logic'
  import { loadVaultSettings, vaultSettings } from '../lib/vault-settings.svelte'
  import { pickSaveFile } from '../lib/dialogs'
  import { openSettings, uiState } from '../lib/ui-state.svelte'
  import { modalFocus } from '../lib/ui/modal-focus'
  import { scanProject, isBlockingReferenceIssue, type ReferenceIssue } from '../lib/project-share/references'
  import { projectCommand, projectIdentities, listProjects, createProject, deleteProject, cancelProjectDeletion, publishProject, collaborationLink, pullProjectFeedback, stopProjectShare, rememberProjectLocation, type ProjectIdentity, type ProjectPublishProgress } from '../lib/project-share/host'
  import { normalizeShareTitle } from '../lib/project-share/title'
  import type { ProjectFile, ProjectInfo, ProjectSummary, LocalFeedback } from '../lib/project-share/types'
  import ProjectReview from './project-review/ProjectReview.svelte'

  let { onClose }: { onClose: () => void } = $props()
  let busy = $state(false)
  let page = $state<'share' | 'feedback'>('share')
  let contentElement: HTMLDivElement | undefined = $state()
  let pullingFor = $state('')
  let error = $state('')
  let notice = $state('')
  let shareTitle = $state('')
  let useCurrentTheme = $state(true)
  let publishWarnings = $state<string[]>([])
  let publishing = $state<{ projectId: string; progress: ProjectPublishProgress } | null>(null)
  let cloudError = $state('')
  let rebindProjectId = $state('')
  let boundSourceRoot = $state('')
  let projects = $state<Record<string, ProjectIdentity>>({})
  let projectList = $state<ProjectSummary[]>([])
  let currentTabId = $state('')
  let currentDocument = $state<{ name: string; path: string } | null>(null)
  let currentReadOnly = $state(false)
  let info = $state<ProjectInfo | null>(null)
  let managementOnly = $state(false)
  let candidates = $state<string[]>([])
  let options = $state<ProjectFile[]>([])
  let files = $state<ProjectFile[]>([])
  let issues = $state<ReferenceIssue[]>([])
  let excluded = $state<string[]>([])
  let inbox = $state<LocalFeedback[]>([])
  let reviewComponent: { flush(): Promise<void>; destroy(): Promise<void>; isBusy(): boolean } | undefined = $state()
  const locked = $derived(busy || !!reviewComponent?.isBusy())
  let mirror = $state<{ path: string; source: ProjectFile; mirror: ProjectFile } | null>(null)

  const pulling = $derived(!!info && pullingFor === info.project_id)
  const identity = $derived(info ? projects[info.project_id] : undefined)
  const blocking = $derived(issues.filter(isBlockingReferenceIssue))
  const pending = $derived(identity?.pending)
  const shareUrl = $derived(identity?.url ?? info?.url ?? undefined)
  const editableLink = $derived(identity ? collaborationLink(identity) : undefined)
  const totalBytes = $derived(files.reduce((sum, file) => sum + file.bytes, 0))
  const pendingFeedback = $derived(inbox.filter(item => item.status === 'pending').length)
  const projectName = $derived(info?.entry.split('/').filter(Boolean).at(-1) ?? '')
  const publishProgress = $derived(publishing?.projectId === info?.project_id ? publishing?.progress : undefined)

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
    if (locked) return
    busy = true
    error = ''
    notice = ''
    publishWarnings = []
    try { await reviewComponent?.flush(); await task() } catch (e) { error = String(e) } finally { busy = false }
  }
  async function close() {
    if (locked) return
    busy = true
    try { await reviewComponent?.destroy(); onClose() }
    catch (e) { error = String(e) } finally { busy = false }
  }
  async function changePage(next: 'share' | 'feedback') {
    await run(async () => { page = next })
  }
  function rememberProject(project: ProjectInfo) {
    try {
      localStorage.setItem('projectShare.lastProjectId', project.project_id)
      localStorage.setItem('projectShare.lastProject', JSON.stringify({ project_id: project.project_id, sourceRoot: project.sourceRoot, entry: project.entry }))
    } catch { /* selection is only a convenience */ }
  }
  async function clearProject() {
    await reviewComponent?.destroy()
    page = 'share'; info = null; managementOnly = false; rebindProjectId = ''; boundSourceRoot = ''
    inbox = []; mirror = null; cloudError = ''
    candidates = []; options = []; files = []; issues = []; excluded = []; shareTitle = ''; useCurrentTheme = true; publishWarnings = []
    await tick()
  }
  async function refreshProjects() {
    const [listed, identities] = await Promise.all([listProjects(), projectIdentities()])
    projectList = listed; projects = identities
  }
  function projectStatus(project: ProjectSummary) {
    if (publishing?.projectId === project.project_id) return progressLabel(publishing.progress)
    const saved = projects[project.project_id]
    return project.deleting ? '删除中' : project.orphaned ? '仅有分享记录' : project.error ? '需处理' : project.sourceAvailable === false ? '源不可用' : saved?.pending ? '发布待确认' : project.url || saved?.url ? '已分享' : '草稿'
  }
  function uploadPercent(progress: Extract<ProjectPublishProgress, { phase: 'uploading' }>) {
    return progress.total > 0 ? Math.min(100, Math.floor(progress.loaded / progress.total * 100)) : undefined
  }
  function progressLabel(progress: ProjectPublishProgress) {
    if (progress.phase === 'preparing') return '正在准备分享…'
    if (progress.phase === 'processing') return '正在完成发布…'
    const percent = uploadPercent(progress)
    const artifact = progress.artifact === 'entry' ? '入口文档' : progress.artifact === 'reader' ? '阅读页' : '项目文件 ZIP'
    const part = progress.partNumber && progress.partCount ? ` · 第 ${progress.partNumber} / ${progress.partCount} 片` : ''
    return `正在上传${artifact}${percent === undefined ? '' : ` · ${percent}%`} · ${formatSize(progress.loaded)} / ${formatSize(progress.total)}${part}`
  }
  function entryPath(project: ProjectSummary) { return `${project.sourceRoot.replace(/\/$/, '')}/${project.entry}` }
  async function loadProject(projectId: string, created?: ProjectInfo) {
    await clearProject()
    const summary = projectList.find(project => project.project_id === projectId)
    let opened: ProjectInfo
    try { opened = created ?? (summary?.orphaned ? summary : await projectCommand<ProjectInfo>('get', { project_id: projectId })) }
    catch (e) {
      if (!summary) throw e
      opened = { ...summary, sourceAvailable: false, error: String(e) }
    }
    info = opened; boundSourceRoot = opened.sourceRoot
    const saved = projects[opened.project_id]
    shareTitle = normalizeShareTitle(saved?.pending?.shareTitle ?? saved?.shareTitle, saved?.pending?.entry ?? opened.entry)
    useCurrentTheme = saved?.pending ? saved.pending.useCurrentTheme ?? true : saved?.useCurrentTheme ?? true
    rebindProjectId = opened.orphaned ? '' : opened.project_id
    managementOnly = opened.sourceAvailable === false || !!opened.deleting || !!opened.orphaned || !!opened.error
    rememberProject(opened)
    if (opened.error) error = opened.error
    if (opened.orphaned) { notice = '本机绑定已不存在，仍可停止远端分享或移除残留分享记录。'; return }
    try { inbox = await projectCommand<LocalFeedback[]>('inbox', { project_id: opened.project_id }) }
    catch (e) { cloudError = String(e) }
    if (!managementOnly) {
      try { await scan(opened.files.length ? new Set(opened.files) : undefined) }
      catch (e) { managementOnly = true; error = String(e) }
    }
    if (!opened.deleting) void checkFeedback()
  }
  async function showCurrentDocument(restore = true) {
    await clearProject()
    currentTabId = activeTab()?.id ?? ''
    const tab = tabs.find(tab => tab.id === currentTabId)
    const markdown = tab && (tab.filePath ? /\.(md|markdown|mdown|mkd|mdx)$/i.test(tab.filePath) : tab.kind === 'markdown')
    currentDocument = markdown ? { name: tab.title || tab.filePath.split('/').at(-1) || '未命名文档', path: tab.filePath } : null
    currentReadOnly = false
    if (!markdown || !tab) return
    await refreshSotvault()
    const record = sotvaultStore.records.find(record => record.vault_path === tab.filePath && record.project_id)
    if (record) {
      if (projectList.some(project => project.project_id === record.project_id && !project.orphaned)) await loadProject(record.project_id!)
      else { currentReadOnly = true; notice = '这是没有本机项目绑定的同步镜像，只可阅读；请选择原始 Markdown 文档。' }
      return
    }
    await loadVaultSettings()
    const syncRoot = vaultSettings.vaultPath && `${vaultSettings.vaultPath.replace(/\/$/, '')}/${vaultSettings.syncDir}`
    if (tab.filePath && syncRoot && isUnder(tab.filePath, syncRoot)) {
      currentReadOnly = true; notice = '同步镜像不能创建新项目，请选择原始 Markdown 文档。'; return
    }
    const matching = projectList.filter(project => !project.orphaned && entryPath(project) === tab.filePath)
    if (matching.length === 1 && restore) await loadProject(matching[0].project_id)
    else if (matching.length > 1) notice = '当前文档匹配多个已有项目，请从本机项目列表明确选择。'
  }
  async function initialize() {
    await refreshProjects()
    await showCurrentDocument()
  }
  onMount(() => { void run(initialize) })

  async function createFromPath(path: string) {
    await refreshProjects()
    const matching = projectList.filter(project => !project.orphaned && entryPath(project) === path)
    if (matching.length > 1) throw new Error('当前文档匹配多个已有项目，请从本机项目列表明确选择。')
    const created = matching.length ? undefined : await createProject(path)
    await refreshProjects()
    await loadProject(created?.project_id ?? matching[0].project_id, created)
    notice = '本机项目已保存。请核对下方分享文件，再点击“发布分享”。'
  }
  async function createCurrentProject() {
    const tabId = currentTabId
    const tab = tabs.find(tab => tab.id === tabId)
    if (!tab || !currentDocument || currentReadOnly) return
    await refreshSotvault()
    const record = sotvaultStore.records.find(record => record.vault_path === tab.filePath && record.project_id)
    if (record) {
      if (!projectList.some(project => project.project_id === record.project_id && !project.orphaned)) throw new Error('这是没有本机绑定的同步镜像，只可阅读。')
      await loadProject(record.project_id!); return
    }
    window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId } }))
    if (!tab.filePath) {
      const path = await pickSaveFile('untitled.md')
      if (!path) return
      await saveAs(tabId, path)
    } else if (isDirty(tabId)) await saveTab(tabId)
    const saved = tabs.find(tab => tab.id === tabId)
    if (!saved?.filePath || isDirty(tabId)) throw new Error('当前文档未保存，尚未创建项目。')
    if (!/\.(md|markdown|mdown|mkd|mdx)$/i.test(saved.filePath)) throw new Error('请选择 Markdown 文档。')
    currentDocument = { name: saved.title || saved.filePath.split('/').at(-1) || '未命名文档', path: saved.filePath }
    await createFromPath(saved.filePath)
  }
  async function chooseDocument() {
    const picked = await open({ multiple: false, title: '选择 Markdown 文档', filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] }] })
    if (typeof picked !== 'string') return
    const tab = tabs.find(tab => tab.filePath === picked)
    if (tab) {
      currentTabId = tab.id; currentDocument = { name: tab.title || picked.split('/').at(-1) || picked, path: picked }
      currentReadOnly = false
      await createCurrentProject()
    } else await createFromPath(picked)
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
    await refreshProjects()
    await loadProject(id)
    notice = '项目已重新绑定，项目 ID、发布历史和反馈保持不变。'
  }
  async function prepareBuffers(sourcePath?: string) {
    if (!info) return
    if (info.deleting || info.orphaned) throw new Error('此项目当前不可修改。')
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
      info = await projectCommand<ProjectInfo>('get', { project_id: info.project_id })
      if (info.sourceAvailable === false || info.deleting || info.orphaned || info.error) throw new Error('项目源文件尚不可用，请先修复后重新扫描。')
      managementOnly = false
    }
    const approved = new Set(files.length ? files.map(file => file.path) : info?.files ?? [])
    await prepareBuffers()
    await scan(approved.size ? approved : undefined)
    notice = '已保存批准文件及关联镜像的修改并重新核对引用；新发现的文件默认不分享。'
  }
  async function publish() {
    if (!info || info.deleting || info.orphaned) return
    const project = info
    try {
      if (!pending) {
        if (managementOnly) throw new Error('请先修复入口并重新扫描，再发布当前原件。')
        const approved = new Set(files.map(file => file.path))
        await prepareBuffers()
        await scan(approved)
        if (blocking.length) throw new Error('存在不可安全发布的问题，请先处理下方列出的原因，再重新扫描。')
        if (!files.some(file => file.path === project.entry)) throw new Error('必须包含入口文档')
      }
      publishing = { projectId: project.project_id, progress: { phase: 'preparing' } }
      const published = await publishProject(project, pending ? [] : files, shareTitle, {
        useCurrentTheme,
        onProgress(progress) {
          if (publishing?.projectId === project.project_id) publishing = { projectId: project.project_id, progress }
        },
        onEntryPublished(result) {
          info = result.info
          projects = { ...projects, [project.project_id]: result.identity }
          notice = result.identity.publishedSnapshotId === result.identity.pending?.snapshotId
            ? '入口已发布，正在同步项目…链接现在可以复制。'
            : '现有分享继续可用，正在同步新版项目…链接现在可以复制。'
        },
      })
      info = published.info
      projects = { ...projects, [project.project_id]: published.identity }
      shareTitle = normalizeShareTitle(published.identity.shareTitle, published.info.entry)
      useCurrentTheme = published.identity.useCurrentTheme ?? true
      publishWarnings = published.warnings ?? []
      notice = '项目已发布。原件保存只刷新镜像；后续修改仍需手动重新发布。'
      await refreshSotvault()
    } catch (e) {
      projects = await projectIdentities()
      const frozen = projects[project.project_id]?.pending
      if (frozen) shareTitle = normalizeShareTitle(frozen.shareTitle ?? projects[project.project_id]?.shareTitle, frozen.entry)
      if (frozen) useCurrentTheme = frozen.useCurrentTheme ?? true
      if (frozen?.phase && projects[project.project_id]?.url) throw new Error(`完整项目尚未同步完成，已发布链接仍可访问和复制。请重试继续同步项目。\n${String(e)}`)
      if (frozen) throw new Error(`发布结果未确认。本机已保留原包，下次点击“重试原包发布”会使用相同地址和内容。\n${String(e)}`)
      throw e
    } finally { publishing = null }
  }
  async function copy(link: string | undefined) {
    if (!link) return
    await writeText(link)
    notice = '链接已复制。'
  }
  async function stop() {
    if (!info || info.deleting) return
    if (!await ask('停止此项目分享？本机原件、镜像、快照和反馈都会保留。', { title: '停止项目分享' })) return
    try {
      await stopProjectShare(info.project_id)
      info = { ...info, url: null }
      await refreshProjects()
      notice = '分享服务已确认停止分享；已下载的副本及缓存可能仍然存在。'
    } catch (e) {
      projects = await projectIdentities()
      throw new Error(`停止结果未确认，已保留本地分享记录，可再次检查或停止。\n${String(e)}`)
    }
  }

  async function checkMirrorBuffers(project: ProjectInfo) {
    await refreshSotvault()
    const paths = new Set(sotvaultStore.records.filter(record => record.project_id === project.project_id).map(record => record.vault_path))
    const related = tabs.filter(tab => paths.has(tab.filePath) || !!project.mirrorRoot && isUnder(tab.filePath, project.mirrorRoot))
    for (const tab of related) window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: tab.id } }))
    const dirty = related.filter(tab => isDirty(tab.id))
    if (dirty.length) throw new Error(`请先处理未保存的镜像修改，再删除项目：\n${dirty.map(tab => tab.filePath).join('\n')}`)
    return related.map(tab => tab.id)
  }
  async function removeProject() {
    if (!info) return
    const project = info
    await checkMirrorBuffers(project)
    if (!await ask(`删除此本机项目并撤回网页分享？\n\n入口：${project.entry}\n源目录：${project.sourceRoot}\n镜像目录：${project.mirrorRoot || '无本机镜像'}\n\n本机镜像、发布快照和已收反馈会移除。原始文档保留原位。已下载的副本不会被收回。`, { title: '删除项目' })) return
    let mirrorTabs: string[] = []
    try {
      await deleteProject(project.project_id, async () => { mirrorTabs = await checkMirrorBuffers(project) })
      for (const id of mirrorTabs) await closeTab(id, async () => 'cancel')
      await refreshSotvault()
      await refreshProjects()
      try {
        if (localStorage.getItem('projectShare.lastProjectId') === project.project_id) {
          localStorage.removeItem('projectShare.lastProjectId'); localStorage.removeItem('projectShare.lastProject')
        }
      } catch { /* selection is only a convenience */ }
      await clearProject()
      notice = '项目已删除，原始文档保持原位。'
    } catch (e) {
      await refreshProjects()
      const summary = projectList.find(item => item.project_id === project.project_id)
      if (summary) info = { ...project, ...summary }
      throw e
    }
  }
  async function cancelDeletion() {
    if (!info) return
    const id = info.project_id
    await cancelProjectDeletion(id)
    await refreshProjects()
    await loadProject(id)
    notice = '已取消本机删除；如已停止网页分享，可重新发布。'
  }

  async function checkFeedback() {
    if (!info || info.deleting || info.orphaned || pullingFor === info.project_id) return
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
    } catch (e) { if (info?.project_id === id) cloudError = String(e) } finally { if (pullingFor === id) pullingFor = '' }
  }
  function updateFeedback(updated: LocalFeedback) {
    inbox = inbox.map(item => item.envelope.payload.submissionId === updated.envelope.payload.submissionId ? updated : item)
  }
  async function refreshReviewSource(sourcePath: string) {
    await refreshSotvault()
    const paths = new Set([sourcePath, ...sotvaultStore.records.filter(record => record.source_path === sourcePath).map(record => record.vault_path)])
    for (const tab of tabs.filter(tab => paths.has(tab.filePath))) {
      window.dispatchEvent(new CustomEvent('notemd:flush-doc', { detail: { tabId: tab.id } }))
      if (isDirty(tab.id)) {
        tab.externalState = 'changed'; tab.externalBannerDismissed = false
        notice = '磁盘已变化，保留了未保存的原件或镜像修改，请核对外部变化提示。'
      } else {
        await reloadTabFromDisk(tab.filePath, { expectedContent: tab.currentContent })
        if (tab.externalState === 'changed') notice = '磁盘已变化，保留了读取期间输入的修改，请核对外部变化提示。'
      }
    }
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

{#if !uiState.showSettings}
<div class="overlay" role="presentation" onclick={event => { if (event.target === event.currentTarget) close() }}>
  <div class="dialog ui-surface" role="dialog" aria-modal="true" aria-labelledby="project-share-title" aria-busy={locked} tabindex="-1" use:modalFocus={{ onClose: close, canClose: () => !locked }}>
    <header class="dialog-header">
      <h2 id="project-share-title">分享项目</h2>
      <span class="current-page">{page === 'share' ? '分享内容' : '反馈收件箱'}</span>
    </header>
    <div class="share-layout">
      <aside class="sidebar">
        <nav aria-label="项目分享">
          <button class:active={page === 'share'} aria-current={page === 'share' ? 'page' : undefined} disabled={locked} onclick={() => { void changePage('share') }}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M8 10h4M8 13h4" /></svg>
            <span>分享内容</span>
          </button>
          <button class:active={page === 'feedback'} aria-current={page === 'feedback' ? 'page' : undefined} disabled={locked || !info || !!info.orphaned || !!info.deleting} onclick={() => { void changePage('feedback') }}>
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M3 3.5h14v10H8l-4 3v-3H3zM6 7h8M6 10h5" /></svg>
            <span>反馈收件箱</span>{#if pendingFeedback}<span class="count" aria-label={`${pendingFeedback} 份待审阅`}>{pendingFeedback}</span>{/if}
          </button>
        </nav>
        <div class="project-switch">
          <button data-initial-focus disabled={locked} onclick={() => run(() => showCurrentDocument(false))}>当前文档</button>
          {#if projectList.length}
            <label for="share-recent-project">本机项目</label>
            <select id="share-recent-project" disabled={locked} value={info?.project_id ?? ''} onchange={event => { const id = event.currentTarget.value; if (id) void run(() => loadProject(id)) }}>
              <option value="">选择项目</option>
              {#each projectList as item (item.project_id)}<option value={item.project_id}>{item.entry || item.project_id} — {item.sourceRoot} · {projectStatus(item)}</option>{/each}
            </select>
          {/if}
          <button disabled={locked} onclick={() => run(chooseDocument)}>选择其他文档…</button>
          <button disabled={locked} onclick={() => run(async () => { await reviewComponent?.destroy(); openSettings('share') })}>分享设置…</button>
        </div>
      </aside>
      <div class="content" bind:this={contentElement} role="region" aria-label={page === 'share' ? '分享内容' : '反馈收件箱'}>
        {#if error}<p class="message error" role="alert">{error}</p>{/if}
        {#if notice}<p class="message notice" role="status">{notice}</p>{/if}
        {#if publishWarnings.length}<ul class="message warning" aria-label="发布呈现提示" role="status">{#each publishWarnings as warning}<li>{warning}</li>{/each}</ul>{/if}
        {#if info}
          <div class="project-heading">
            <div class="project-title"><h3>{projectName}</h3><span class="badge">{publishProgress ? '发布中' : projectStatus(info)}</span></div>
            <p class="path">{info.sourceRoot}</p>
            {#if publishProgress}
              <div class="publish-progress">
                <p role="status">{progressLabel(publishProgress)}</p>
                {#if publishProgress.phase === 'uploading' && publishProgress.total > 0}
                  <progress max="100" value={uploadPercent(publishProgress)} aria-label={`${projectName} 上传进度`} aria-valuetext={progressLabel(publishProgress)}></progress>
                {:else}
                  <progress aria-label={`${projectName} 上传进度`} aria-valuetext={progressLabel(publishProgress)}></progress>
                {/if}
              </div>
            {/if}
          </div>
          {#if page === 'share'}
            <section class="entry-section">
              <label class="field-row" for="share-entry"><span>入口文档</span><input id="share-entry" readonly value={info.entry} /></label>
              <p class="desc">从这篇文档开始，包含你勾选的引用文档和资源。</p>
              <label class="field-row" for="share-title"><span>分享标题</span><input id="share-title" bind:value={shareTitle} readonly={!!pending} disabled={locked || !!info.deleting || !!info.orphaned} /></label>
              <label class="theme-option"><input id="share-current-theme" type="checkbox" bind:checked={useCurrentTheme} disabled={locked || !!pending || !!info.deleting || !!info.orphaned} />使用当前主题</label>
              <p class="desc">取消后使用应用内置的默认正文主题。</p>
              {#if pending}<p class="message warning">{pending.phase === 'preparing' || pending.phase === 'full' ? '入口链接已就绪，完整项目尚未同步完成。重试会继续本次批准范围；源文件变化时需要先处理。' : `上次发布结果尚未确认。重试会发送已冻结的原包（入口 ${pending.entry}），不包含此后编辑的内容。`}</p>{/if}
              {#if managementOnly && !pending}<p class="message warning">源文件暂时不可用。仍可管理分享和本机反馈；修复源文件后重新扫描才能发布。</p>{/if}
            </section>
            <section>
              <div class="section-heading"><h3>分享文件 <span class="section-meta">{files.length} 个 · {formatSize(totalBytes)}</span></h3><button disabled={locked || !!info.deleting || !!info.orphaned} onclick={() => run(saveAndScan)}>保存并重新扫描</button></div>
              <p class="desc">仅分享勾选的文件，个人手记和私密配置会自动排除。</p>
              <div class="file-list" aria-label="分享文件">
                {#each options as file (file.path)}
                  <div class="file-row">
                    <label><input type="checkbox" checked={!excluded.includes(file.path)} disabled={locked || file.path === info.entry || !!pending || !!info.deleting} onchange={event => run(() => toggleFile(file.path, event.currentTarget.checked))} /><span class="file-path">{file.path}</span>{#if file.path === info.entry}<span class="badge">入口</span>{/if}</label>
                    <span class="file-size">{formatSize(file.bytes)}</span>
                    {#if info.files.includes(file.path)}<button class="subtle" disabled={locked || !!info.deleting} onclick={() => run(() => viewMirror(file.path))}>镜像对照</button>{/if}
                  </div>
                {/each}
                {#if !options.length}<p class="list-empty">{managementOnly ? '修复入口后可重新扫描文件。' : '暂时没有可分享的文件。'}</p>{/if}
              </div>
              {#if issues.length}<details class="reference-issues" open><summary>已包含 {files.length} 个文件 · 未包含 {issues.length} 项引用{blocking.length ? ` · ${blocking.length} 项阻止发布` : ' · 可发布已包含内容'}</summary><ul class="issues">{#each issues as issue}<li class:warning={!isBlockingReferenceIssue(issue)} class:error={isBlockingReferenceIssue(issue)}><strong>{issue.from}</strong> → {issue.target}：{issue.message}{#if issue.from !== info.entry}<button disabled={locked || !!pending} onclick={() => run(() => excludeDocument(issue.from))}>排除此文档并重扫</button>{/if}</li>{/each}</ul></details>{/if}
              {#if blocking.length}<p class="warning desc">无法安全发布：{blocking.map(issue => issue.message).join('; ')}。请处理后重新扫描。</p>{/if}
            </section>
            {#if mirror}<section class="mirror-review"><h3>镜像对照：{mirror.path}</h3><div class="columns two"><div><h4>当前源文件</h4><pre>{mirror.source.markdown ?? `${mirror.source.bytes} bytes\n${mirror.source.hash}`}</pre></div><div><h4>当前镜像</h4><pre>{mirror.mirror.markdown ?? `${mirror.mirror.bytes} bytes\n${mirror.mirror.hash}`}</pre></div></div><p>确认后只用上面显示的源版本覆盖这份镜像；任一文件再变化都会要求重新审阅。</p><div class="actions"><button class="primary" disabled={locked} onclick={() => run(resolveMirror)}>确认用源版本覆盖镜像</button><button disabled={locked} onclick={() => mirror = null}>取消</button></div></section>{/if}
            {#if shareUrl}
              <section>
                <div class="section-heading"><h3>分享链接</h3><span class="section-meta">{identity?.expiresAt === null ? '长期有效' : identity?.expiresAt ? `有效期至 ${formatDate(identity.expiresAt)}` : ''}</span></div>
                <div class="field-row"><label for="share-read-link">阅读链接</label><input id="share-read-link" readonly value={shareUrl} /><button onclick={() => { void copy(shareUrl).catch(e => { error = String(e) }) }}>复制阅读链接</button></div>
                <div class="collaboration-row"><p class="desc">协作链接允许对方编辑和标注，修改由你审阅后合入。</p><button disabled={!editableLink} onclick={() => { void copy(editableLink).catch(e => { error = String(e) }) }}>复制协作链接</button></div>
              </section>
            {/if}
            <section class="project-management">
              <h3>项目管理</h3>
              <p class="desc">停止分享保留本机项目；删除项目会撤回网页并移除本机镜像、快照和反馈，原始文档保留原位。</p>
              {#if info.deleting}<p class="message warning">项目删除尚未完成。可以重试删除，或明确取消删除以恢复本机项目操作。</p>{/if}
              {#if info.orphaned}<p class="message warning">仅有分享记录，本机项目绑定不存在。</p>{/if}
              <div class="actions">
                {#if rebindProjectId}<button disabled={locked || !!info.deleting} onclick={() => run(rebindProject)}>重新绑定项目目录…</button>{/if}
                {#if shareUrl || pending}<button class="danger" disabled={locked || !!info.deleting} onclick={() => run(stop)}>{pending && !shareUrl ? '停止待确认的分享…' : '停止分享…'}</button>{/if}
                <button class="danger" disabled={locked} onclick={() => run(removeProject)}>{info.deleting ? '重试删除项目…' : '删除项目…'}</button>
                {#if info.deleting}<button disabled={locked} onclick={() => run(cancelDeletion)}>取消删除</button>{/if}
              </div>
            </section>
          {/if}
          <section hidden={page !== 'feedback'}>
            <div class="section-heading"><h3>反馈收件箱（{inbox.length}）</h3><button disabled={locked || pulling} onclick={() => { void checkFeedback() }}>{pulling ? '正在检查云端…' : '检查新反馈'}</button></div>
            {#if cloudError}<p class="warning">{cloudError}</p>{/if}
            {#if !inbox.length}<p>暂时没有本机反馈。打开分享时会尝试取回云端收件。</p>{/if}
            {#key info.project_id}<ProjectReview bind:this={reviewComponent} projectId={info.project_id} feedback={inbox} prepareSource={prepareBuffers} refreshSource={refreshReviewSource} onUpdated={updateFeedback} />{/key}
          </section>
        {:else}
          <div class="empty-state">
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 5h18l10 10v28H10zM28 5v10h10M18 25h12M18 32h12" /></svg>
            <h3>{currentDocument ? currentDocument.name : '选择 Markdown 文档'}</h3>
            {#if currentDocument}
              <p class="path">{currentDocument.path || '未命名文档，创建前会先另存为。'}</p>
              <p>以这篇文档所在文件夹为引用基准，只分享批准的文档和资源。</p>
              <div class="actions">
                <button disabled={locked || currentReadOnly} onclick={() => run(createCurrentProject)}>创建项目</button>
                <button class="primary" disabled={locked || currentReadOnly} onclick={() => run(createCurrentProject)}>分享为项目…</button>
              </div>
            {:else}<p>打开或选择一篇 Markdown，即可预览它的分享范围。</p>{/if}
            <p class="desc">项目先保存为本机草稿，核对预览后再发布。原文档保留原位。</p>
          </div>
        {/if}
      </div>
    </div>
    <footer>
      <span class="footer-status">{busy ? '正在处理…' : info && page === 'share' ? pending ? '将重试上次保留的发布内容。' : `${files.length} 个文件 · 修改后需重新发布` : info ? '审阅并接受后，修改才会写入原文档。' : '原文档保留在你的项目目录中。'}</span>
      <button disabled={locked} onclick={close}>完成</button>
      {#if info && page === 'share'}<button disabled={locked || !!info.deleting || !!info.orphaned || (!pending && (managementOnly || !files.length || !!blocking.length))} class="primary" onclick={() => run(publish)}>{pending ? '重试原包发布' : shareUrl ? '更新分享' : '发布分享'}</button>{/if}
    </footer>
  </div>
</div>
{/if}

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
  .publish-progress { margin-top: 12px; color: var(--ui-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
  .publish-progress p { margin: 0 0 6px; }
  .publish-progress progress { display: block; width: 100%; height: 6px; accent-color: var(--ui-accent); }
  .path { margin: 6px 0 0; color: var(--ui-secondary); font-size: 12px; overflow-wrap: anywhere; }
  .badge { border-radius: 4px; background: var(--ui-bg); border: 1px solid var(--ui-separator); padding: 1px 6px; font-size: 12px; white-space: nowrap; color: var(--ui-secondary); }
  section[hidden] { display: none; }
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
  input:not([type='checkbox']), select { min-width: 0; min-height: 32px; padding: 6px 9px; border: 1px solid var(--ui-control-border); border-radius: 6px; color: CanvasText; background: var(--ui-surface); }
  input[readonly] { color: var(--ui-secondary); background: var(--ui-bg); }
  .field-row { display: flex; align-items: center; gap: 12px; margin: 8px 0; }
  .field-row > span, .field-row > label { width: 70px; flex-shrink: 0; }
  .field-row input { flex: 1; width: 0; }
  .theme-option { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
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
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
  .columns { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; margin: 12px 0; } .columns.two { grid-template-columns: repeat(2,minmax(0,1fr)); } .columns > div { min-width: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 12px; border: 1px solid var(--ui-separator); border-radius: 6px; background: var(--ui-bg); font: 12px/1.6 ui-monospace, 'SF Mono', Menlo, Consolas, 'JetBrains Mono', 'CaskaydiaMono Nerd Font', 'DejaVu Sans Mono', monospace; max-height: 340px; overflow: auto; margin: 0 0 10px; }
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
    .field-row { flex-wrap: wrap; gap: 8px; } .field-row > span, .field-row > label { width: 100%; } .field-row input { width: 100%; flex-basis: 100%; }
    .collaboration-row { align-items: flex-start; flex-direction: column; gap: 4px; }
    .file-row { flex-wrap: wrap; gap: 6px; } .file-row label { flex-basis: 100%; }
    footer { flex-wrap: wrap; justify-content: flex-end; } .footer-status { flex-basis: 100%; }
  }
</style>
