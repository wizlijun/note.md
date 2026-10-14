import { createSourceSession } from '@moraya/core'
import { guestChanges, revertGuestHunk } from './changes'
import { mount as mountComponent, unmount } from 'svelte'
import type { ShareEditorModule, ShareEditorHost, ShareEditorHandle } from './contract'
import type { DraftV2, ProjectAnnotationV2 } from '../lib/project-share/types'
import { buildGuestSubmission } from '../lib/project-share/guest-submission'
import { extractGuestAnnotations } from '../lib/share-merge'
import { createShareFileSession, type ShareFileSession } from './file-session'
import { acceptsOwnerFloor, ownerAnnotationFloor } from './owner-policy'
import { bundleMediaResolver, sharedPath, shareMediaPlugin } from './media'
import ShareEditor from './ShareEditor.svelte'
import RebasePanel from './RebasePanel.svelte'
import { prepareGuestRebase, undoGuestRebase, type RebaseCandidate } from './rebase'
import { shareMermaidLoader } from './mermaid-loader'
import { wikilinkPlugin } from '../lib/wikilink-plugin'
import { noteUi, readThemeStyle } from '../lib/note-anno/note-ui.svelte'
import type { FileMountSession } from '../editor-kit-v2/file-main'
import '../styles/popup-menu.css'
import './share-editor.css'

async function mount(container: HTMLElement, host: ShareEditorHost, opts: { path: string }): Promise<ShareEditorHandle> {
  if (host.apiVersion !== 1) throw new Error('Unsupported share editor host')
  let draft: DraftV2 = await host.loadDraft() ?? { v: 2, lineageId: crypto.randomUUID(), snapshotId: host.snapshot.snapshotId, base: {}, after: {}, annotationKinds: {} }
  const root = document.createElement('div'); root.className = 'share-editor-root'; root.dataset.theme = host.theme.themeId
  root.style.height = '100%'
  for (const [key, value] of Object.entries(host.theme.cssVars ?? {})) if (key.startsWith('--')) root.style.setProperty(key, value)
  container.append(root)
  let resolveTarget!: (target: HTMLElement) => void
  const targetReady = new Promise<HTMLElement>(resolve => { resolveTarget = resolve })
  let snapshot = host.snapshot, rebasing = false, rebaseFault = false
  let showChanges=false
  const ui = mountComponent(ShareEditor, { target: root, props: { ready: resolveTarget, notify: host.notify,
    discardRecovery: () => { void serial(clearRecovery).catch(error => host.notify(error.message)) },
    undoRebase: () => { void serial(async () => {
      const next = undoGuestRebase(draft)
      const previousSnapshot = { ...snapshot, snapshotId: next.snapshotId, files: Object.entries(next.base).map(([path, file]) => ({ path, ...file })) }
      await applyBaseline(next, previousSnapshot, draft.previous?.annotations ?? [])
    }).catch(error => host.notify(error.message)) },
    recoverRebase: () => { void serial(async () => {
      const recovery = draft.rebaseRecovery
      if (!recovery || recovery.snapshot.project_id !== host.snapshot.project_id || recovery.snapshot.snapshotId !== host.snapshot.snapshotId
        || JSON.stringify(recovery.snapshot.files) !== JSON.stringify(host.snapshot.files)) throw Error('公开版本已变化，请先导出保留的迁移候选')
      await applyBaseline(structuredClone(recovery.candidate), host.snapshot)
    }).catch(error => host.notify(error.message)) },
    toggleChanges: (value:boolean)=> {showChanges=value;updateBadges()},
    revert: (id:string)=> {void serial(async()=> {
      await session!.mounted.owner.flush()
      const snapshot=session!.mounted.owner.snapshot()
      const value=revertGuestHunk({path,base:draft.base[path].markdown,draft:snapshot.raw,hunkId:id})
      const result=session!.mounted.owner.replaceSource({expectedGeneration:snapshot.generation,value})
      if(!result.ok) throw Error('无法撤销这处，修改仍保留')
      await session!.save();updateBadges()
    }).catch(error=>host.notify(error.message))},
  } })
  const target = await targetReady
  let session: ShareFileSession | undefined, path = '', closed = false, unsubscribe = () => {}
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  function cancelSave() { if (saveTimer !== undefined) clearTimeout(saveTimer); saveTimer = undefined }
  function scheduleSave() {
    cancelSave()
    const current = session
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      void serial(async () => { if (session === current) await current?.save() })
        .catch(() => { if (!closed) host.notify('草稿保存失败，输入仍保留，请重试或导出') })
    }, 300)
  }
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = tail.then(() => { if (closed) throw new Error('share-editor-closed'); if (rebaseFault) throw new Error('请重新加载后撤销 rebase，耐久候选与原稿均已保留'); return action() })
    tail = result.catch(() => {}); return result
  }
  const mermaidLoader = shareMermaidLoader(host, root)
  function fileFor(next: string) {
    const old = draft.base[next]
    if (old) return { path: next, ...old }
    const file = snapshot.files.find(file => file.path === next && typeof file.markdown === 'string')
    if (!file) throw new Error('File is outside this share')
    return file
  }
  function updateBadges() {
    const summaries=Object.keys(draft.after).sort().filter(p=>Object.hasOwn(draft.base,p)).map(p=> {
      const changes=guestChanges({path:p,base:draft.base[p].markdown,draft:draft.after[p]})
      return {path:p,changed:changes.extracted.clean!==draft.base[p].markdown,blocks:changes.hunks.length,annotations:changes.extracted.annotations.length}
    })
    ui.rebaseState(!!draft.previous, !!draft.rebaseRecovery)
    host.setFileBadges?.(summaries)
    if(!session || !draft.base[path]) return
    const snapshot=session.mounted.owner.snapshot(), changes=guestChanges({path,base:draft.base[path].markdown,draft:snapshot.raw})
    ui.warning(changes.extracted.ownerAnnotationsTouched.length)
    ui.updateChanges(changes.hunks.map(({hunk})=>({id:hunk.id,label:hunk.theirs.trim() || '删除：'+hunk.base.trim()})),summaries)
    if(!showChanges) {session.mounted.decorations.removeLayer('proposal');return}
    const view=(session.mounted as FileMountSession).view, source=createSourceSession(snapshot.raw,view.state.schema)
    if(!source.ok) {session.mounted.decorations.removeLayer('proposal');return}
    session.mounted.decorations.setLayer('proposal',snapshot.bindings.flatMap(binding=> {
      const root=source.session.roots.find(root=>root.id===binding.rootOrdinal)
      if(!root) return []
      const count=changes.hunks.filter(row=>changes.rawOffset(row.from)<root.sourceTo && changes.rawOffset(row.to,true)>root.sourceFrom).length
      return count?[{blockId:binding.id,kind:'proposal' as const,label:count+' 处修改'}]:[]
    }))
  }
  function openLink(href: string) {
    const resolved = sharedPath(href, path)
    const destination = snapshot.files.find(file => typeof file.markdown === 'string' && (file.path === resolved || file.path === resolved + '.md'))
    if (destination) host.openFile(destination.path)
    else host.notify('只能打开本次分享中的文件')
  }
  async function open(next: string) {
    const file = fileFor(next), base = draft.base[next]?.markdown ?? file.markdown!
    if (!draft.base[next]) draft.base[next] = { markdown: file.markdown!, hash: file.hash }
    const initial = Object.hasOwn(draft.after, next) ? draft.after[next] : base
    path = next
    const resolver = { loadLocalImage: (src: string) => bundleMediaResolver(snapshot.files, path).loadLocalImage(src), loadLocalMedia: async () => '', loadRemoteMedia: async () => '' }
    session = await createShareFileSession({ get path() { return path }, snapshotId: snapshot.snapshotId, raw: file.markdown!, get draft() { return draft },
      policy: policyFor(draft, next),
      adapters: { mermaidLoader, mediaResolver: resolver, linkOpener: { open: openLink }, platform: { getCurrentFilePath: () => path, isMacOS: /Mac/.test(navigator.platform) } },
      render: { enableMath: true, enableMermaid: true }, styles: 'host',
      plugins: [shareMediaPlugin(resolver, host.notify), wikilinkPlugin()], mountTarget: target, saveDraft: live => host.saveDraft(live),
    })
    path = next
    ui.install(session.mounted, path, extractGuestAnnotations({ base, draft: initial }).ownerAnnotationsTouched.length)
    unsubscribe = session.mounted.owner.observe(() => { updateBadges(); scheduleSave() }); updateBadges()
  }
  function policyFor(value: DraftV2, file: string) {
    const floor = ownerAnnotationFloor(value.base[file].markdown, value.after[file] ?? value.base[file].markdown)
    return { acceptRawChange: (_before: string, after: string) => {
      const accepted = acceptsOwnerFloor(floor, after)
      if (!accepted) host.notify('分享者批注需保留；请添加自己的批注')
      return accepted
    } }
  }
  async function clearRecovery() {
    if (rebaseFault) throw Error('回滚尚未保存，请重新加载后撤销 rebase')
    if (!draft.rebaseRecovery) return
    if (!host.transitionDraft) throw Error('宿主不支持安全迁移')
    cancelSave(); await session!.save({ requireConfirmed: true })
    const next = structuredClone(draft), annotations = await host.loadAnnotations?.() ?? []
    delete next.rebaseRecovery
    await host.transitionDraft(draft, next, { expectedAnnotations: annotations, annotations })
    draft = next; updateBadges()
  }
  async function applyBaseline(next: DraftV2, nextSnapshot: ShareEditorHost['snapshot'], nextNotes: readonly ProjectAnnotationV2[] = []) {
    if (!host.transitionDraft) throw Error('宿主不支持安全迁移，请导出备份')
    cancelSave(); await session!.save({ requireConfirmed: true })
    if (!await session!.mounted.setMode('rich')) throw Error('请先完成当前输入')
    const old = draft, oldPath = path, oldNotes = structuredClone([...(await host.loadAnnotations?.() ?? [])])
    next.message = old.message
    let nextPath = Object.hasOwn(next.base, path) ? path : Object.keys(next.base)[0]
    if (!nextPath) {
      const file = nextSnapshot.files.find(file => typeof file.markdown === 'string')
      if (!file) throw Error('新版本没有可编辑文件；请保留导出的原稿')
      nextPath = file.path; next.base[nextPath] = { markdown: file.markdown!, hash: file.hash }; next.after[nextPath] = file.markdown!
    }
    session!.setReadOnly(true)
    let persisted = false, rollbackFailed = false
    try {
      const expectedDurable = JSON.stringify(next)
      const durable = await host.transitionDraft(old, next, { expectedAnnotations: oldNotes, annotations: nextNotes }); persisted = true
      // A later queued description may mutate next after this exact write.
      if (JSON.stringify(durable) !== expectedDurable) throw Error('迁移尚未完成本机保存')
      const result = session!.mounted.owner.installBaseline({ documentId: `${next.lineageId}:${nextPath}`, authority: `${next.lineageId}:${next.snapshotId}:${nextPath}`, raw: next.after[nextPath] ?? next.base[nextPath].markdown }, { policy: policyFor(next, nextPath) })
      if (!result.ok) throw Error(result.reason)
      draft = next; snapshot = nextSnapshot; path = nextPath
      ui.install(session!.mounted, path, 0); updateBadges(); host.openFile(path)
    } catch (error) {
      if (persisted) {
        const candidate = structuredClone(next); delete candidate.rebaseRecovery; delete candidate.pending
        const restored = structuredClone(old)
        // Undo failures already have a durable complete previous; an old
        // snapshot must never be granted current-public-snapshot authority.
        if (nextSnapshot.snapshotId === host.snapshot.snapshotId) restored.rebaseRecovery = { snapshot: structuredClone(nextSnapshot), candidate }
        try { await host.transitionDraft(next, restored, { expectedAnnotations: nextNotes, annotations: oldNotes }); draft = restored }
        catch { rollbackFailed = true; rebaseFault = true; host.notify('迁移安装和回滚保存均失败；原文仍保留。请重新加载后撤销 rebase，勿关闭未导出的输入') }
      }
      path = oldPath; updateBadges(); throw error
    } finally { if (!rollbackFailed) session!.setReadOnly(false) }
  }
  function markConflicts(candidate: RebaseCandidate) {
    const conflicts = candidate.files.find(file => file.path === path)?.proposal.hunks.filter(h => h.kind === 'conflict') ?? []
    const value = session!.mounted.owner.snapshot(), view = (session!.mounted as FileMountSession).view
    const source = createSourceSession(value.raw, view.state.schema)
    if (!source.ok) return
    const changes = guestChanges({ path, base: candidate.old.base[path].markdown, draft: value.raw })
    const ranges = conflicts.flatMap(hunk => {
      const at = changes.extracted.clean.indexOf(hunk.theirs)
      return at < 0 ? [] : [{ from: changes.rawOffset(at), to: changes.rawOffset(at + hunk.theirs.length, true) }]
    })
    session!.mounted.decorations.setLayer('proposal', value.bindings.flatMap(binding => {
      const block = source.session.roots.find(root => root.id === binding.rootOrdinal)
      const count = block ? ranges.filter(range => range.from < block.sourceTo && range.to >= block.sourceFrom).length : 0
      return count ? [{ blockId: binding.id, kind: 'proposal' as const, label: `${count} 处待处理冲突` }] : []
    }))
  }
  function hover(event: MouseEvent) {
    const el = (event.target as Element).closest<HTMLElement>('[data-note]')
    if (!el?.dataset.note) { noteUi.hover = null; return }
    const rect = el.getBoundingClientRect(); noteUi.hover = { x: rect.left, y: rect.bottom + 4, note: el.dataset.note, style: readThemeStyle(el) }
  }
  function click(event: MouseEvent) {
    if (!session) return
    const el = event.target as Element, badge = el.closest('.note-badge, .moraya-note-anchor')
    if (badge) {
      event.preventDefault(); event.stopPropagation()
      const view = (session.mounted as FileMountSession).view, pos = view.posAtDOM(badge, 0)
      session.mounted.annotations.editAt(badge.classList.contains('moraya-note-anchor') && view.state.doc.nodeAt(pos)?.type.name === 'note_anchor' ? pos : pos - 1)
    } else {
      const wiki = el.closest('[data-wikilink]')
      if (wiki) { event.preventDefault(); event.stopPropagation(); openLink(wiki.getAttribute('data-wikilink')!); return }
      const link = el.closest('a[href]')
      if (link) { event.preventDefault(); event.stopPropagation(); openLink(link.getAttribute('href')!) }
    }
  }
  function linkDown(event: MouseEvent) {
    if ((event.target as Element).closest('a[href], [data-wikilink]')) { event.preventDefault(); event.stopPropagation() }
  }
  function key(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'm' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); session?.mounted.annotations.insert()
    }
  }
  target.addEventListener('mousedown', linkDown, true); target.addEventListener('mouseover', hover); target.addEventListener('click', click); target.addEventListener('keydown', key)
  try { await open(opts.path) } catch (error) {
    cancelSave(); unsubscribe()
    if (session && !await session.closeAfterFailedMount()) {
      error = Object.assign(new Error('草稿未保存，输入仍保留，请重试或导出'), { unsavedDraft: true })
    }
    closed = true; noteUi.hover = null
    target.removeEventListener('mousedown', linkDown, true); target.removeEventListener('mouseover', hover); target.removeEventListener('click', click); target.removeEventListener('keydown', key)
    try { await unmount(ui) } finally { root.remove() }
    throw error
  }
  return {
    rebase: (nextSnapshot, supplied) => serial(async () => {
      if (rebasing || supplied !== draft) throw Error('草稿身份已变化')
      if (draft.pending || draft.previous) prepareGuestRebase(draft, nextSnapshot)
      cancelSave(); await session!.save({ requireConfirmed: true })
      const candidate = prepareGuestRebase(draft, nextSnapshot, await host.loadAnnotations?.() ?? [])
      rebasing = true; session!.setReadOnly(true); markConflicts(candidate)
      return new Promise<import('./contract').RebaseUiResult>(resolve => {
        const panel = document.createElement('div'); root.prepend(panel)
        const finish = async () => { rebasing = false; session!.setReadOnly(rebaseFault); await unmount(component); panel.remove(); updateBadges() }
        const component = mountComponent(RebasePanel, { target: panel, props: { candidate, changed: () => markConflicts(candidate),
          cancel: async () => { await clearRecovery(); await finish(); resolve({ status: 'cancelled' }) },
          done: async next => { await applyBaseline(next, nextSnapshot); await finish(); resolve({ status: 'applied', draft }) },
        } })
      })
    }),
    switchFile: next => serial(async () => {
      fileFor(next); if (next === path) return
      const previous = path
      cancelSave(); await session!.close(); unsubscribe(); session = undefined
      try { await open(next) } catch (error) { await open(previous); throw error }
    }),
    buildSubmission: input => serial(async () => {
      cancelSave(); await session!.save({requireConfirmed:true})
      const snapshot = session!.mounted.owner.snapshot(), saved=session!.saved()
      if(saved?.generation!==snapshot.generation || saved.hash!==snapshot.sourceHash) throw Error('file-save-not-confirmed')
      const captured = structuredClone(draft)
      captured.after[path] = snapshot.raw
      const { body, submissionId, summary } = buildGuestSubmission({ project_id: host.snapshot.project_id, draft: captured,
        submissionId: crypto.randomUUID(), client: { kind: 'browser', version: 'share-editor-1' }, ...input })
      return { body, submissionId, summary }
    }),
    destroy: () => serial(async () => {
      cancelSave(); await session!.close(); unsubscribe(); closed = true
      noteUi.hover = null
      target.removeEventListener('mousedown', linkDown, true); target.removeEventListener('mouseover', hover); target.removeEventListener('click', click); target.removeEventListener('keydown', key)
      await unmount(ui); root.remove()
    }),
  }
}
export const shareEditor: ShareEditorModule = { apiVersion: 1, mount }
if (typeof window !== 'undefined') Object.assign(window, { NotemdShareEditor: shareEditor })
