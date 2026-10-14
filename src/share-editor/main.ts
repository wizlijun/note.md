import { createSourceSession } from '@moraya/core'
import { guestChanges, revertGuestHunk } from './changes'
import { mount as mountComponent, unmount } from 'svelte'
import type { ShareEditorModule, ShareEditorHost, ShareEditorHandleE1 } from './contract'
import type { DraftV2 } from '../lib/project-share/types'
import { buildGuestSubmission } from '../lib/project-share/guest-submission'
import { extractGuestAnnotations } from '../lib/share-merge'
import { createShareFileSession, type ShareFileSession } from './file-session'
import { acceptsOwnerFloor, ownerAnnotationFloor } from './owner-policy'
import { bundleMediaResolver, sharedPath, shareMediaPlugin } from './media'
import ShareEditor from './ShareEditor.svelte'
import { wikilinkPlugin } from '../lib/wikilink-plugin'
import { noteUi, readThemeStyle } from '../lib/note-anno/note-ui.svelte'
import type { FileMountSession } from '../editor-kit-v2/file-main'
import '../styles/popup-menu.css'
import './share-editor.css'

async function mount(container: HTMLElement, host: ShareEditorHost, opts: { path: string }): Promise<ShareEditorHandleE1> {
  if (host.apiVersion !== 1) throw new Error('Unsupported share editor host')
  const draft: DraftV2 = await host.loadDraft() ?? { v: 2, lineageId: crypto.randomUUID(), snapshotId: host.snapshot.snapshotId, base: {}, after: {}, annotationKinds: {} }
  const root = document.createElement('div'); root.className = 'share-editor-root'; root.dataset.theme = host.theme.themeId
  root.style.height = '100%'
  for (const [key, value] of Object.entries(host.theme.cssVars ?? {})) if (key.startsWith('--')) root.style.setProperty(key, value)
  container.append(root)
  let resolveTarget!: (target: HTMLElement) => void
  const targetReady = new Promise<HTMLElement>(resolve => { resolveTarget = resolve })
  let showChanges=false
  const ui = mountComponent(ShareEditor, { target: root, props: { ready: resolveTarget, notify: host.notify,
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
    const result = tail.then(() => { if (closed) throw new Error('share-editor-closed'); return action() })
    tail = result.catch(() => {}); return result
  }
  function fileFor(next: string) {
    const file = host.snapshot.files.find(file => file.path === next && typeof file.markdown === 'string')
    if (!file) throw new Error('File is outside this share')
    return file
  }
  function updateBadges() {
    const summaries=Object.keys(draft.after).sort().filter(p=>Object.hasOwn(draft.base,p)).map(p=> {
      const changes=guestChanges({path:p,base:draft.base[p].markdown,draft:draft.after[p]})
      return {path:p,changed:changes.extracted.clean!==draft.base[p].markdown,blocks:changes.hunks.length,annotations:changes.extracted.annotations.length}
    })
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
    const destination = host.snapshot.files.find(file => typeof file.markdown === 'string' && (file.path === resolved || file.path === resolved + '.md'))
    if (destination) host.openFile(destination.path)
    else host.notify('只能打开本次分享中的文件')
  }
  async function open(next: string) {
    const file = fileFor(next), base = draft.base[next]?.markdown ?? file.markdown!
    const initial = Object.hasOwn(draft.after, next) ? draft.after[next] : base
    const floor = ownerAnnotationFloor(base, initial), resolver = bundleMediaResolver(host.snapshot.files, next)
    session = await createShareFileSession({ path: next, snapshotId: host.snapshot.snapshotId, raw: file.markdown!, draft,
      policy: { acceptRawChange: (_before, after) => {
        const accepted = acceptsOwnerFloor(floor, after)
        if (!accepted) host.notify('分享者批注需保留；请添加自己的批注')
        return accepted
      } },
      adapters: { mediaResolver: resolver, linkOpener: { open: openLink }, platform: { getCurrentFilePath: () => next, isMacOS: /Mac/.test(navigator.platform) } },
      render: { enableMath: true, enableMermaid: false }, styles: 'host',
      plugins: [shareMediaPlugin(resolver, host.notify), wikilinkPlugin()], mountTarget: target, saveDraft: live => host.saveDraft(live),
    })
    path = next
    ui.install(session.mounted, path, extractGuestAnnotations({ base, draft: initial }).ownerAnnotationsTouched.length)
    unsubscribe = session.mounted.owner.observe(() => { updateBadges(); scheduleSave() }); updateBadges()
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
    if (session) await session.close()
    await unmount(ui); root.remove(); throw error
  }
  return {
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
