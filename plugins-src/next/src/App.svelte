<script lang="ts">
  import '../../../src/styles/ui-foundation.css'
  import { onMount, tick } from 'svelte'
  import CreateIdeaSheet, { type IdeaDraft } from './components/CreateIdeaSheet.svelte'
  import CreateTaskSheet, { type TaskDraft } from './components/CreateTaskSheet.svelte'
  import KickoffConsent from './components/KickoffConsent.svelte'
  import KickoffPicker from './components/KickoffPicker.svelte'
  import KickoffProgress from './components/KickoffProgress.svelte'
  import KickoffSheet from './components/KickoffSheet.svelte'
  import { createKickoffClient, KickoffClientError, type KickoffSnapshot, type KickoffResult } from './lib/kickoff/client'
  import { kickoffEligible, kickoffButtonState, type ButtonStateInput } from './lib/kickoff/button-state'
  import { POLL_MS } from './lib/kickoff/status'
  import type { KickoffAnswer } from './lib/kickoff/document'
  import type { KickoffFailure } from './lib/kickoff/registry'
  import { commitPrefill, type InitialCommit, type ExtraOptions } from './lib/kickoff/prefill'
  import { rememberedProvider, rememberProvider, providerKey } from './lib/agent-picker/types'
  import IdeaCard from './components/IdeaCard.svelte'
  import MetadataSheet from './components/MetadataSheet.svelte'
  import CompletionConfetti from './components/CompletionConfetti.svelte'
  import PlaceMenu from './components/PlaceMenu.svelte'
  import PlaceSheet from './components/PlaceSheet.svelte'
  import ReminderMenu from './components/ReminderMenu.svelte'
  import ReminderSheet from './components/ReminderSheet.svelte'
  import type { ReminderInput, ReminderView } from './lib/reminders'
  import RelinkSheet from './components/RelinkSheet.svelte'
  import SettingsPage from './components/SettingsPage.svelte'
  import TaskHookStatus from './components/TaskHookStatus.svelte'
  import { bridge, toast, vaultRead, vaultWrite, vaultExists, vaultList, vaultInfo, agentProviders, agentLimits, agentRun, agentStatus, editorOpen } from './lib/bridge'
  import { quickPlaceInput, type PlaceInput, type QuickPlaceInput } from './lib/events'
  import { canCompleteWithNote, CompletionNoteError, createCompletionNote, type CompletionNoteOperation } from './lib/completion-note'
  import { projectTagsOf } from './lib/model'
  import { planningDefaults, type NextSettings } from './lib/settings'
  import { DEFAULT_PRIORITY, type PlanningMetadata } from './lib/metadata'
  import { itemSearchText, type WorkspaceItem } from './lib/repository'
  import type { IdeaSource } from './lib/source'
  import {
    createIdea,
    createTask,
    completeWithNote,
    open as openItem,
    place,
    refresh,
    relink,
    reopen,
    state as store,
    updateSettings,
    updateMetadata,
    updateReminder,
  } from './lib/store.svelte'
  import { setLocale, t, CATALOGS, type MessageKey } from './lib/strings'
  import { isDormantDue, previewPosition, sortWorkspaceItems, type SortMode } from './lib/view'

  type Lane = 'capture' | 'wip' | 'waiting' | 'dormant' | 'closed'
  type Route = PlaceInput['route']
  type LocalKickoffFailure = KickoffFailure & { runId?: string; previousResultRunId?: string }

  interface LaneView {
    id: Lane
    title: MessageKey
    empty: MessageKey
    items: WorkspaceItem[]
    count: string
  }

  setLocale(bridge().locale)

  // Production deliberately passes no verified-provider override. Admission is
  // enabled only after the separate real-harness safety verification succeeds.
  const kickoffClient = createKickoffClient({
    read: vaultRead, write: vaultWrite, exists: vaultExists, list: vaultList,
    vaultInfo, agentProviders, agentLimits, agentRun, agentStatus,
    currentItem: async (taskId) => {
      await refresh()
      return store.workspace?.items.find((item) => item.task?.id === taskId) ?? null
    },
  }, {
    notificationTitles: { ok: t('kickoff.readyNotice'), fail: t('kickoff.failedNotice') },
  })
  let kickoffSnapshot = $state<KickoffSnapshot>(kickoffClient.snapshot())
  let kickoffLoaded = $state(false)
  let kickoffStarting = $state<string[]>([])
  let kickoffFailures = $state<Record<string, LocalKickoffFailure>>({})
  let kickoffPicker = $state<WorkspaceItem | null>(null)
  let kickoffConsent = $state<{ item: WorkspaceItem; providerId: string } | null>(null)
  let kickoffProgress = $state<WorkspaceItem | null>(null)
  let kickoffResult = $state<{ item: WorkspaceItem; result: KickoffResult } | null>(null)
  let kickoffSaving = $state(false)
  let kickoffSaveError = $state('')
  let kickoffAnnouncement = $state('')
  let kickoffReturnFocus = $state<HTMLElement | null>(null)
  let kickoffActive = false
  let kickoffPolling = false
  let kickoffInitializing = false
  let kickoffWorkspace: typeof store.workspace = null
  let placementCommit = $state<InitialCommit | undefined>()
  let placementExtraOptions = $state<ExtraOptions | undefined>()

  function kickoffInput(item: WorkspaceItem): ButtonStateInput {
    const id = item.task?.id ?? ''
    const run = kickoffSnapshot.registry.runs[id]
    const localFailure = kickoffFailures[id]
    return {
      starting: kickoffStarting.includes(id),
      run: localFailure ? {
        run_id: run?.run_id ?? null, harness: run?.harness ?? '',
        requested_at: run?.requested_at ?? localFailure.at,
        task_path: item.path ?? '', based_on: run?.based_on ?? '', state: 'failed', failure: localFailure,
      } : run,
      result: kickoffSnapshot.results[id]?.doc.kickoff,
      status: kickoffSnapshot.statuses[id],
      taskHash: kickoffSnapshot.hashes[id],
      unread: kickoffSnapshot.registry.unread.includes(id),
    }
  }

  function cardKickoff(item: WorkspaceItem): ButtonStateInput | undefined {
    return kickoffLoaded && !kickoffSnapshot.unsupported && kickoffEligible(item) ? kickoffInput(item) : undefined
  }

  function kickoffErrorLabel(error: unknown): string {
    const key = `kickoff.failure.${error instanceof KickoffClientError ? error.kind : 'io-error'}`
    return key in CATALOGS.en ? t(key as MessageKey) : t('kickoff.failure.error')
  }

  function adoptKickoff(snapshot: KickoffSnapshot, announce = false) {
    const previous = kickoffSnapshot
    kickoffSnapshot = snapshot
    for (const [id, failure] of Object.entries(kickoffFailures)) {
      const run = snapshot.registry.runs[id]
      const resultRunId = snapshot.results[id]?.doc.kickoff.run_id
      const recoveredRun = run?.state === 'running' && (!failure.runId || failure.runId === run.run_id)
      const recoveredResult = resultRunId && (failure.runId
        ? resultRunId === failure.runId : resultRunId !== failure.previousResultRunId)
      if (recoveredRun || recoveredResult) delete kickoffFailures[id]
    }
    if (kickoffProgress) {
      const id = kickoffProgress.task!.id
      if (snapshot.results[id] && !snapshot.registry.runs[id] && !kickoffFailures[id]) {
        void showKickoffResult(kickoffProgress)
      }
    }
    if (!announce) return
    const ready = snapshot.registry.unread.some((id) => !previous.registry.unread.includes(id))
    const failed = Object.entries(snapshot.registry.runs).some(([id, run]) => run.state === 'failed' && previous.registry.runs[id]?.state !== 'failed')
    if (ready) kickoffAnnouncement = t('kickoff.readyNotice')
    else if (failed) kickoffAnnouncement = t('kickoff.failed')
  }

  async function loadKickoff() {
    if (typeof bridge().request !== 'function' || kickoffInitializing) return
    kickoffInitializing = true
    try {
      const snapshot = await kickoffClient.load(store.workspace?.items ?? [])
      if (!kickoffActive) return
      adoptKickoff(snapshot)
      kickoffWorkspace = store.workspace
      kickoffLoaded = true
      const reconciled = await kickoffClient.reconcile()
      if (kickoffActive) adoptKickoff(reconciled, true)
    } catch (error) {
      if (kickoffActive) await toast('error', kickoffErrorLabel(error))
    } finally {
      kickoffInitializing = false
    }
  }

  async function pollKickoff() {
    if (!kickoffActive || kickoffPolling) return
    kickoffPolling = true
    try {
      const snapshot = await kickoffClient.reconcile()
      if (kickoffActive) adoptKickoff(snapshot, true)
    } catch (error) {
      if (kickoffActive) await toast('error', kickoffErrorLabel(error))
    } finally {
      kickoffPolling = false
    }
  }

  $effect(() => {
    if (!kickoffLoaded || !Object.values(kickoffSnapshot.registry.runs).some((run) => run.state === 'running')) return
    const timer = setInterval(() => void pollKickoff(), POLL_MS)
    return () => clearInterval(timer)
  })

  $effect(() => {
    const current = store.workspace
    if (!kickoffLoaded || !current || current === kickoffWorkspace) return
    kickoffWorkspace = current
    void kickoffClient.load(current.items).then((snapshot) => {
      if (kickoffActive) adoptKickoff(snapshot)
    }).catch((error) => { if (kickoffActive) void toast('error', kickoffErrorLabel(error)) })
  })

  function rememberedKickoff(): string {
    return rememberedProvider('next.kickoff', kickoffSnapshot.providers.map((provider) => provider.id), kickoffSnapshot.providerDefault)
  }

  function rememberKickoffFocus(item: WorkspaceItem) {
    const card = [...document.querySelectorAll<HTMLElement>('[data-item-key]')]
      .find((element) => element.dataset.itemKey === item.key)
    kickoffReturnFocus = card?.querySelector<HTMLButtonElement>('[data-kickoff-state]') ?? null
  }

  function chooseKickoff(item: WorkspaceItem) {
    rememberKickoffFocus(item)
    closePreview()
    kickoffProgress = null
    kickoffResult = null
    kickoffPicker = item
  }

  async function showKickoffResult(item: WorkspaceItem) {
    const id = item.task!.id
    const result = kickoffSnapshot.results[id]
    if (!result) return
    kickoffProgress = null
    kickoffSaveError = ''
    kickoffResult = { item, result }
    try { adoptKickoff(await kickoffClient.markRead(id)) }
    catch (error) { await toast('error', kickoffErrorLabel(error)) }
  }

  function clickKickoff(item: WorkspaceItem) {
    rememberKickoffFocus(item)
    const state = kickoffButtonState(kickoffInput(item))
    if (state === 'starting') return
    if (state === 'running' || state === 'failed') {
      closePreview()
      kickoffProgress = item
      return
    }
    if (state !== 'idle') { void showKickoffResult(item); return }
    let saved = false
    try { saved = Boolean(localStorage.getItem(providerKey('next.kickoff'))) } catch { /* storage is optional */ }
    const providerId = rememberedKickoff()
    const provider = kickoffSnapshot.providers.find((option) => option.id === providerId)
    if (!saved || !provider?.harness?.ok) chooseKickoff(item)
    else void requestKickoff(item, providerId)
  }

  async function requestKickoff(item: WorkspaceItem, providerId: string, consent = false) {
    const id = item.task!.id
    kickoffPicker = null
    kickoffProgress = null
    kickoffResult = null
    kickoffStarting = [...kickoffStarting, id]
    delete kickoffFailures[id]
    try {
      // A read-only preflight precedes the first-use confirmation; cancellation
      // never seeds procedures, starts an agent, or changes the Task lifecycle.
      await kickoffClient.preflight({ item, providerId })
      if (kickoffSnapshot.needsConsent && !consent) {
        kickoffConsent = { item, providerId }
        return
      }
      kickoffConsent = null
      adoptKickoff(await kickoffClient.startKickoff({ item, providerId, consent }), true)
      kickoffAnnouncement = t('kickoff.starting')
    } catch (error) {
      const snapshot = kickoffClient.snapshot()
      const run = snapshot.registry.runs[id]
      kickoffFailures[id] = {
        kind: error instanceof KickoffClientError ? error.kind : 'io-error',
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
        warning: snapshot.providers.find((provider) => provider.id === providerId)?.harness?.warning ?? undefined,
        runId: run?.state === 'running' ? run.run_id : undefined,
        previousResultRunId: kickoffSnapshot.results[id]?.doc.kickoff.run_id,
      }
      adoptKickoff(snapshot)
      kickoffProgress = item
      kickoffAnnouncement = kickoffErrorLabel(error)
    } finally {
      kickoffStarting = kickoffStarting.filter((value) => value !== id)
    }
  }

  async function saveKickoffAnswers(answers: KickoffAnswer[], placeAfter: boolean) {
    const opened = kickoffResult
    if (!opened || kickoffSaving) return
    kickoffSaving = true
    kickoffSaveError = ''
    try {
      const saved = await kickoffClient.saveAnswers({ taskId: opened.item.task!.id, runId: opened.result.doc.kickoff.run_id, answers })
      adoptKickoff(saved.snapshot)
      kickoffResult = { ...opened, result: saved.result }
      if (!saved.rerendered) await toast('success', t('kickoff.saved'), t('kickoff.bodyPreserved'))
      if (placeAfter) {
        await refresh()
        const current = store.workspace?.items.find((item) => item.task?.id === opened.item.task!.id)
        if (!current || !kickoffEligible(current)) throw new KickoffClientError('task-changed', '')
        const prefill = commitPrefill(saved.result.doc.kickoff.payload, saved.result.doc.kickoff.answers)
        // An ongoing commitment only changes where the person answered a question.
        // Keep the agent's other suggestions as choices, preserving existing work.
        if (current.projection?.state === 'wip') {
          for (const field of ['commitment', 'next_action', 'close_condition'] as const) {
            const answered = saved.result.doc.kickoff.payload.questions.some((question) =>
              question.decides === field && saved.result.doc.kickoff.answers.some((answer) => answer.question_id === question.id))
            if (!answered) prefill.initialCommit[field] = current.projection[field] ?? ''
          }
        }
        kickoffResult = null
        openPlacement(current, 'commit')
        placementCommit = prefill.initialCommit
        placementExtraOptions = prefill.extraOptions
      } else if (saved.rerendered) await toast('success', t('kickoff.saved'))
    } catch (error) {
      kickoffSaveError = `${t('kickoff.saveError')} ${kickoffErrorLabel(error)}`
    } finally {
      kickoffSaving = false
    }
  }

  async function openKickoffFile(path: string) {
    try { await editorOpen(path) }
    catch (error) { await toast('error', t('error.open'), String(error)) }
  }

  let showPlaced = $state(false)
  let creating = $state(false)
  let creatingTask = $state(false)
  let search = $state('')
  let sortMode = $state<SortMode>('priority')
  let selectedProject = $state('')
  let selectedKind = $state<'idea' | 'task' | ''>('')
  let placeMenu = $state<{ item: WorkspaceItem; anchor: HTMLButtonElement } | null>(null)
  let placementSaving = $state(false)
  let celebration = $state(0)
  let placing = $state<WorkspaceItem | null>(null)
  let placementRoute = $state<Route | undefined>()
  let placementProjects = $state<string[]>([])
  let completionNote = $state(false)
  let completionOperation = $state<CompletionNoteOperation | null>(null)
  let completionNoteError = $state('')
  let relinking = $state<WorkspaceItem | null>(null)
  let reminderMenu = $state<{ item: WorkspaceItem; anchor: HTMLButtonElement; view: ReminderView } | null>(null)
  let reminderNow = $state(Date.now())
  let editingReminder = $state<{ item: WorkspaceItem; view: ReminderView } | null>(null)
  let editingMetadata = $state<WorkspaceItem | null>(null)
  let settingsOpen = $state(false)
  let dragging = $state<WorkspaceItem | null>(null)
  let dragOver = $state<Lane | null>(null)
  let dragPress: {
    item: WorkspaceItem
    anchor: HTMLElement
    tipId: string
    startX: number
    startY: number
    pointerId: number
  } | null = null
  let ghostX = $state(0)
  let ghostY = $state(0)
  let previewing = $state<WorkspaceItem | null>(null)
  let previewAnchor: HTMLElement | null = null
  let previewTip = $state<HTMLElement | null>(null)
  let previewTipId = $state('')
  let previewX = $state(12)
  let previewY = $state(12)
  let previewPositionVersion = 0
  let previewPointerActive = false
  let previewFocusActive = false
  let previewCloseTimer: ReturnType<typeof setTimeout> | null = null
  const laneElements = $state<Partial<Record<Lane, HTMLElement>>>({})
  const dragThreshold = 5

  const workspace = $derived(store.workspace)
  const wipAtLimit = $derived(Boolean(
    workspace && workspace.wip.length >= workspace.projection.wipLimit,
  ))
  const projectOptions = $derived(workspace?.projectOptions ?? [])
  const activeProject = $derived(projectOptions.includes(selectedProject) ? selectedProject : '')
  const filtering = $derived(Boolean(search.trim() || activeProject || selectedKind))
  const blocked = $derived(Boolean(workspace?.readOnlyError || workspace?.projection.hasBlockingIssues))
  const interactionDisabled = $derived(store.saving || placementSaving || blocked)
  const createDefaults = $derived(planningDefaults(store.settings))
  const newIdeaShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘N'
    : 'Ctrl+N'
  const newTaskShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⇧⌘N'
    : 'Ctrl+Shift+N'
  const repair = $derived(workspace?.items.filter((item) => (
    item.state === 'unsupported' || (item.state === 'capture' && item.orphan)
  ) && matchesFilters(item)) ?? [])

  $effect(() => {
    if (workspace && selectedProject && !projectOptions.includes(selectedProject)) selectedProject = ''
  })

  function matchesProject(item: WorkspaceItem): boolean {
    if (!activeProject) return true
    const projection = item.projection
    if (projectTagsOf(projection).includes(activeProject)) return true
    return projection?.state === 'closed'
      && projection.exit.kind === 'transferred'
      && projection.exit.via === 'project'
      && projection.target === activeProject
  }

  function matchesFilters(item: WorkspaceItem): boolean {
    if (selectedKind && (item.kind ?? 'idea') !== selectedKind) return false
    if (!matchesProject(item)) return false
    const query = search.trim().toLocaleLowerCase()
    return !query || itemSearchText(item).includes(query)
  }

  function filter(items: WorkspaceItem[]): WorkspaceItem[] {
    return items.filter(matchesFilters)
  }

  function toggleKind(kind: 'idea' | 'task') {
    closePreview()
    selectedKind = selectedKind === kind ? '' : kind
  }

  function toggleProject(project: string) {
    closePreview()
    selectedProject = activeProject === project ? '' : project
  }

  const lanes = $derived.by<LaneView[]>(() => {
    if (!workspace) return []
    const capture = workspace.capture.filter((item) => !item.orphan)
    const dormant = showPlaced
      ? workspace.dormant
      : workspace.dormant.filter((item) => isDormantDue(item))
    const closed = showPlaced ? workspace.closed : []
    const sortedCapture = sortWorkspaceItems(filter(capture), sortMode)
    const visibleCapture = filtering ? sortedCapture : sortedCapture.slice(0, 10)
    const visibleDormant = sortWorkspaceItems(filter(dormant), sortMode)
    const visibleClosed = sortWorkspaceItems(filter(closed), sortMode)
    return [
      { id: 'capture', title: 'section.capture', empty: 'empty.capture', items: visibleCapture, count: String(visibleCapture.length) },
      {
        id: 'wip',
        title: 'section.wip',
        empty: 'empty.wip',
        items: sortWorkspaceItems(filter(workspace.wip), sortMode),
        count: t('count.wip', { count: workspace.wip.length, limit: workspace.projection.wipLimit }),
      },
      { id: 'waiting', title: 'section.waiting', empty: 'empty.waiting', items: sortWorkspaceItems(filter(workspace.waiting), sortMode), count: t('count.waiting', { count: workspace.waiting.length }) },
      { id: 'dormant', title: 'status.dormant', empty: 'empty.dormant', items: visibleDormant, count: String(visibleDormant.length) },
      { id: 'closed', title: 'status.closed', empty: 'empty.closed', items: visibleClosed, count: String(visibleClosed.length) },
    ]
  })

  async function report(action: () => Promise<void>, messageKey: 'error.save' | 'error.open' | 'error.load' | 'error.create') {
    try {
      await action()
    } catch (error) {
      await toast('error', t(messageKey), String(error))
    }
  }

  function openCreation() {
    if (kickoffPicker || kickoffConsent || kickoffProgress || kickoffResult) return
    if (store.loading || store.saving || placing || relinking || editingMetadata || editingReminder || creatingTask) return
    closePreview()
    placeMenu = null
    reminderMenu = null
    settingsOpen = false
    creating = true
  }

  function openTaskCreation() {
    if (kickoffPicker || kickoffConsent || kickoffProgress || kickoffResult) return
    if (store.loading || store.saving || placing || relinking || editingMetadata || editingReminder || creating) return
    closePreview()
    placeMenu = null
    reminderMenu = null
    settingsOpen = false
    creatingTask = true
  }

  function toggleSettings() {
    if (store.loading || store.saving || placing || relinking || editingMetadata || editingReminder || creating || creatingTask) return
    closePreview()
    placeMenu = null
    reminderMenu = null
    settingsOpen = !settingsOpen
  }

  async function submitSettings(settings: NextSettings): Promise<void> {
    await updateSettings(settings)
    settingsOpen = false
  }

  function openPlaceMenu(item: WorkspaceItem, anchor: HTMLButtonElement) {
    if (interactionDisabled) return
    closePreview()
    reminderMenu = null
    placeMenu = placeMenu?.item.key === item.key ? null : { item, anchor }
  }

  async function quickPlace(item: WorkspaceItem, input: QuickPlaceInput) {
    if (interactionDisabled) return
    placementSaving = true
    closePreview()
    try {
      await report(async () => {
        const current = store.workspace?.items.find((value) => value.key === item.key) ?? item
        if (current.state === 'dormant' || current.state === 'closed') await reopen(current)
        await place(item, input)
        if (input.route === 'settle' && input.exit.kind === 'done') celebration += 1
        placeMenu = null
      }, 'error.save')
    } finally {
      placementSaving = false
    }
  }

  function openPlacement(item: WorkspaceItem, route?: Route, initialProjects: readonly string[] = []) {
    closePreview()
    placeMenu = null
    reminderMenu = null
    placing = item
    placementRoute = route
    placementProjects = [...initialProjects]
    placementCommit = undefined
    placementExtraOptions = undefined
    completionNote = false
    completionOperation = null
    completionNoteError = ''
  }

  function openCompletionNote(item: WorkspaceItem) {
    if (interactionDisabled || !canCompleteWithNote(item)) return
    openPlacement(item, 'settle')
    completionNote = true
  }

  function openRelink(item: WorkspaceItem) {
    closePreview()
    placeMenu = null
    reminderMenu = null
    relinking = item
  }

  function openMetadata(item: WorkspaceItem) {
    if (!item.path || item.orphan || item.repairReason || store.saving) return
    closePreview()
    placeMenu = null
    reminderMenu = null
    editingMetadata = item
  }

  function effectiveReminderView(view: ReminderView): ReminderView {
    return view.status === 'paused' && view.pausedUntil && Date.parse(view.pausedUntil) <= reminderNow
      ? { ...view, status: 'automatic' } : view
  }

  // Update labels at the pause boundary without reloading or discarding an open draft.
  $effect(() => {
    const views = [...Object.values(store.reminders ?? {}), reminderMenu?.view, editingReminder?.view]
    const deadlines = views.filter((view) => view?.status === 'paused' && view.pausedUntil)
      .map((view) => Date.parse(view!.pausedUntil!)).filter((time) => time > reminderNow)
    if (!deadlines.length) return
    const timer = setTimeout(() => { reminderNow = Date.now() }, Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - Date.now()) + 1))
    return () => clearTimeout(timer)
  })

  function reminderFor(item: WorkspaceItem): ReminderView | undefined {
    const view = store.reminders?.[item.task?.id?.toLowerCase() ?? '']
    return view && effectiveReminderView(view)
  }

  function openReminderDetails(item: WorkspaceItem, view = reminderFor(item)) {
    if (!view || store.saving) return
    closePreview()
    placeMenu = null
    reminderMenu = null
    editingReminder = { item, view }
  }

  function openReminderMenu(item: WorkspaceItem, anchor: HTMLButtonElement) {
    const view = reminderFor(item)
    if (!view || interactionDisabled) return
    if (item.state === 'closed' || item.state === 'unsupported') {
      openReminderDetails(item, view)
      return
    }
    closePreview()
    placeMenu = null
    reminderMenu = reminderMenu?.item.key === item.key ? null : { item, anchor, view }
  }

  async function saveReminder(item: WorkspaceItem, view: ReminderView, input: ReminderInput) {
    const result = await updateReminder(item, input, view.raw)
    if (result.refreshError) await toast('warn', t('reminder.refreshWarning'), result.refreshError)
    else await toast('success', t('reminder.saved'))
  }

  async function quickReminder(input: ReminderInput) {
    if (!reminderMenu || store.saving) return
    const { item, view } = reminderMenu
    try {
      await saveReminder(item, view, input)
      reminderMenu = null
    } catch (error) {
      await toast('error', t('reminder.saveError'), String(error))
    }
  }

  async function submitReminder(input: ReminderInput) {
    if (!editingReminder) return
    try {
      await saveReminder(editingReminder.item, editingReminder.view, input)
      editingReminder = null
    } catch (error) {
      await toast('error', t('reminder.saveError'), String(error))
      throw error // The sheet retains its draft and displays the failed save.
    }
  }

  function planningMetadataOf(item: WorkspaceItem): PlanningMetadata {
    const due = item.due ?? item.task?.due
    return {
      priority: item.priority ?? item.task?.priority ?? DEFAULT_PRIORITY,
      ...(due ? { due } : {}),
      contexts: item.contexts ?? item.task?.contexts ?? [],
    }
  }

  async function submitMetadata(metadata: PlanningMetadata): Promise<void> {
    if (!editingMetadata) return
    const item = editingMetadata
    try {
      const result = await updateMetadata(item, metadata)
      editingMetadata = null
      if (result.refreshError) await toast('warn', t('metadata.edit.refreshWarning'), result.refreshError)
    } catch (error) {
      await toast('error', t('metadata.edit.saveError'), String(error))
    }
  }

  async function refreshWorkspace() {
    closePreview()
    await refresh()
    if (kickoffLoaded) {
      kickoffWorkspace = store.workspace
      adoptKickoff(await kickoffClient.load(store.workspace?.items ?? []))
    } else await loadKickoff()
  }

  async function submitIdea(input: IdeaDraft) {
    await report(async () => {
      await createIdea(input)
      creating = false
    }, 'error.create')
  }

  async function submitTask(input: TaskDraft, markCurrent: boolean) {
    try {
      const result = await createTask(input, markCurrent)
      creatingTask = false
      if (result.refreshError) {
        await toast('warn', t(markCurrent ? 'error.createRefreshCurrent' : 'error.createRefresh'), result.refreshError)
      } else if (result.placementError) {
        await toast('warn', t('error.createCurrent'), result.placementError)
      }
    } catch (error) {
      await toast('error', t('error.createTask'), String(error))
    }
  }

  function closePlacement() {
    placing = null
    placementRoute = undefined
    placementProjects = []
    completionNote = false
    completionOperation = null
    completionNoteError = ''
  }

  async function submitPlacement(input: PlaceInput) {
    if (!placing || store.saving || placementSaving) return
    const item = placing
    if (completionNote) {
      if (input.route !== 'settle' || input.status_only || input.exit.kind !== 'done') return
      placementSaving = true
      completionNoteError = ''
      try {
        // Retain the exact operation on every failure, including an uncertain
        // write acknowledgement; a retry must not append the same note twice.
        completionOperation ??= createCompletionNote(item, input.result ?? '')
        await completeWithNote(item, completionOperation)
        celebration += 1
        closePlacement()
      } catch (error) {
        completionNoteError = t(error instanceof CompletionNoteError && error.noteSaved
          ? 'completionNote.savedPending' : 'completionNote.failed')
        await toast('error', completionNoteError, String(error))
      } finally {
        placementSaving = false
      }
      return
    }
    await report(async () => {
      const current = store.workspace?.items.find((value) => value.key === item.key) ?? item
      if (current.state === 'dormant' || current.state === 'closed') await reopen(current)
      await place(item, input)
      if (input.route === 'settle' && input.exit.kind === 'done') celebration += 1
      closePlacement()
    }, 'error.save')
  }

  async function submitRelink(source: IdeaSource) {
    if (!relinking) return
    const item = relinking
    await report(async () => {
      await relink(item, source)
      relinking = null
    }, 'error.save')
  }

  function doOpen(item: WorkspaceItem) {
    closePreview()
    void report(() => openItem(item), 'error.open')
  }

  function doReopen(item: WorkspaceItem) {
    closePreview()
    void report(() => reopen(item), 'error.save')
  }

  function canDrop(item: WorkspaceItem, lane: Lane): boolean {
    if (interactionDisabled || item.state === 'unsupported' || item.state === lane) return false
    if (lane === 'capture') return item.state === 'dormant' || item.state === 'closed'
    return true
  }

  function dragStart(item: WorkspaceItem, event: PointerEvent) {
    if (dragPress || interactionDisabled || item.state === 'unsupported') return
    closePreview()
    const anchor = event.currentTarget as HTMLElement
    dragPress = {
      item,
      anchor,
      tipId: anchor.getAttribute('aria-describedby') ?? '',
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
    }
    ghostX = event.clientX
    ghostY = event.clientY
  }

  function dragEnd() {
    dragPress = null
    dragging = null
    dragOver = null
  }

  function closePreview() {
    if (previewCloseTimer !== null) clearTimeout(previewCloseTimer)
    previewCloseTimer = null
    previewPointerActive = false
    previewFocusActive = false
    previewing = null
    previewAnchor = null
    previewTip = null
    previewTipId = ''
    previewPositionVersion += 1
  }

  function cancelPreviewClose() {
    if (previewCloseTimer !== null) clearTimeout(previewCloseTimer)
    previewCloseTimer = null
  }

  async function positionPreview(item: WorkspaceItem, anchor: HTMLElement, version: number) {
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const fallbackSize = {
      width: Math.min(380, Math.max(0, viewport.width - 24)),
      height: Math.min(480, Math.max(0, viewport.height - 24)),
    }
    const initial = previewPosition(anchor.getBoundingClientRect(), fallbackSize, viewport)
    previewX = initial.x
    previewY = initial.y
    await tick()
    if (version !== previewPositionVersion || previewing !== item || previewAnchor !== anchor || !previewTip) return
    const measured = previewTip.getBoundingClientRect()
    const actualSize = {
      width: measured.width || fallbackSize.width,
      height: measured.height || fallbackSize.height,
    }
    const final = previewPosition(
      anchor.getBoundingClientRect(),
      actualSize,
      { width: window.innerWidth, height: window.innerHeight },
    )
    previewX = final.x
    previewY = final.y
  }

  function previewStart(item: WorkspaceItem, anchor: HTMLElement, trigger: 'pointer' | 'focus', tipId: string) {
    if (!item.body?.trim() || dragPress || dragging || placeMenu || placing || placementSaving) return
    cancelPreviewClose()
    if (previewAnchor !== anchor) {
      previewPointerActive = false
      previewFocusActive = false
    }
    if (trigger === 'pointer') previewPointerActive = true
    else previewFocusActive = true
    previewing = item
    previewAnchor = anchor
    previewTipId = tipId
    previewPositionVersion += 1
    void positionPreview(item, anchor, previewPositionVersion)
  }

  function schedulePreviewClose() {
    if (previewPointerActive || previewFocusActive || previewCloseTimer !== null) return
    previewCloseTimer = setTimeout(() => {
      previewCloseTimer = null
      if (!previewPointerActive && !previewFocusActive) closePreview()
    }, 100)
  }

  function previewEnd(trigger: 'pointer' | 'focus') {
    if (trigger === 'pointer') previewPointerActive = false
    else previewFocusActive = false
    schedulePreviewClose()
  }

  function previewTipEnter() {
    cancelPreviewClose()
    previewPointerActive = true
  }

  function previewTipLeave() {
    previewPointerActive = false
    schedulePreviewClose()
  }

  function previewKeydown(event: KeyboardEvent) {
    if (!previewTip || !previewing || event.target !== previewAnchor) return
    const page = Math.max(120, previewTip.clientHeight * 0.8)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = previewTip.scrollTop + 40
    else if (event.key === 'ArrowUp') next = previewTip.scrollTop - 40
    else if (event.key === 'PageDown') next = previewTip.scrollTop + page
    else if (event.key === 'PageUp') next = previewTip.scrollTop - page
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = previewTip.scrollHeight
    if (next === null) return
    event.preventDefault()
    previewTip.scrollTop = Math.max(0, next)
  }

  function laneAtPoint(x: number, y: number): Lane | null {
    for (const lane of ['capture', 'wip', 'waiting', 'dormant', 'closed'] as const) {
      const rect = laneElements[lane]?.getBoundingClientRect()
      if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return lane
    }
    return null
  }

  function moveToLane(item: WorkspaceItem, lane: Lane) {
    if (!canDrop(item, lane)) return
    if (lane === 'capture') {
      doReopen(item)
      return
    }
    void quickPlace(item, quickPlaceInput(lane === 'wip' ? 'commit' : lane === 'waiting' ? 'wait' : lane === 'dormant' ? 'park' : 'done'))
  }

  function pointerMove(event: PointerEvent) {
    if (!dragPress || event.pointerId !== dragPress.pointerId) return
    if (!dragging) {
      const distance = Math.hypot(event.clientX - dragPress.startX, event.clientY - dragPress.startY)
      if (distance < dragThreshold) return
      if (interactionDisabled) {
        dragEnd()
        return
      }
      closePreview()
      dragging = dragPress.item
    }
    event.preventDefault()
    ghostX = event.clientX
    ghostY = event.clientY
    const lane = laneAtPoint(event.clientX, event.clientY)
    dragOver = lane && canDrop(dragging, lane) ? lane : null
  }

  function pointerUp(event: PointerEvent) {
    const press = dragPress
    if (!dragPress || event.pointerId !== dragPress.pointerId) return
    const item = dragging
    const hovered = item ? laneAtPoint(event.clientX, event.clientY) : null
    const lane = item && hovered && canDrop(item, hovered) ? hovered : null
    dragEnd()
    if (!item && press && !interactionDisabled && press.tipId) {
      const rect = press.anchor.getBoundingClientRect()
      const pointerInside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      const focused = press.anchor.contains(document.activeElement)
      if (pointerInside || focused) {
        previewStart(press.item, press.anchor, focused ? 'focus' : 'pointer', press.tipId)
      }
      return
    }
    if (item && lane) moveToLane(item, lane)
  }

  onMount(() => {
    kickoffActive = true
    void report(refreshWorkspace, 'error.load')
    const onFocus = () => {
      if (!store.saving) void report(refreshWorkspace, 'error.load')
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (dragPress || dragging)) {
        event.preventDefault()
        dragEnd()
        return
      }
      if (event.key === 'Escape' && previewing) {
        event.preventDefault()
        closePreview()
        return
      }
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault()
        settingsOpen = false
        return
      }
      previewKeydown(event)
      if (event.defaultPrevented) return
      if (event.key.toLocaleLowerCase() !== 'n' || (!event.metaKey && !event.ctrlKey) || event.altKey) return
      event.preventDefault()
      if (event.shiftKey) {
        if (!creatingTask) openTaskCreation()
      } else if (!creating) openCreation()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('keydown', onKey)
    return () => {
      kickoffActive = false
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onKey)
      cancelPreviewClose()
    }
  })
</script>

<svelte:window
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onpointercancel={dragEnd}
  onblur={() => { dragEnd(); closePreview() }}
  onresize={closePreview}
  onscroll={closePreview}
/>

<div class="window-surface ui-surface">
<main class="app">
  <header class="topbar">
    <div class="title-block">
      <h1>{t('app.title')}</h1>
      <div class="subtitle-row">
        <p>{t('app.value')}</p>
        <div class="project-filters" role="group" aria-label={t('filter.items')}>
          {#each ['idea', 'task'] as kind}
            <button
              type="button"
              data-kind-filter={kind}
              aria-pressed={selectedKind === kind}
              class:active={selectedKind === kind}
              onclick={() => toggleKind(kind as 'idea' | 'task')}
            >{kind === 'idea' ? 'Idea' : 'Task'}</button>
          {/each}
          {#each projectOptions as project}
            <button
              type="button"
              data-project-filter={project}
              aria-pressed={activeProject === project}
              class:active={activeProject === project}
              onclick={() => toggleProject(project)}
            >{project}</button>
          {/each}
        </div>
      </div>
    </div>
    <div class="top-actions">
      <button type="button" data-action="new-task" class="new-task" aria-keyshortcuts="Meta+Shift+N Control+Shift+N" disabled={store.loading || store.saving} onclick={openTaskCreation}>
        <span aria-hidden="true">＋</span>
        <span>{t('action.newTask')}</span>
        <kbd>{newTaskShortcut}</kbd>
      </button>
      <button type="button" data-action="new-idea" class="new-idea" aria-keyshortcuts="Meta+N Control+N" disabled={store.loading || store.saving} onclick={openCreation}>
        <span>{t('action.newIdea')}</span>
        <kbd>{newIdeaShortcut}</kbd>
      </button>
      <button type="button" class="refresh" disabled={store.loading || store.saving} onclick={() => void report(refreshWorkspace, 'error.load')}>
        ↻ <span>{t('common.refresh')}</span>
      </button>
      <button
        type="button"
        data-action="settings"
        class="settings-button"
        class:active={settingsOpen}
        aria-label={t('action.settings')}
        aria-pressed={settingsOpen}
        title={t('action.settings')}
        disabled={store.loading || store.saving || Boolean(placing || relinking || editingMetadata || editingReminder || creating || creatingTask)}
        onclick={toggleSettings}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M9 3v2.2L6.8 6.5 5 5.4 3 9l2 1.1v3.8L3 15l2 3.6 1.8-1.1L9 18.8V21h6v-2.2l2.2-1.3 1.8 1.1 2-3.6-2-1.1v-3.8L21 9l-2-3.6-1.8 1.1L15 5.2V3z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>{t('action.settings')}</span>
      </button>
    </div>
  </header>

  <TaskHookStatus />
  {#if settingsOpen}
    <SettingsPage settings={store.settings} saving={store.saving} onCancel={() => settingsOpen = false} onSave={submitSettings} />
  {:else if store.loading && !workspace}
    <div class="loading">{t('common.loading')}</div>
  {:else if workspace}
    <div class="content">
      {#if blocked}
        <div class="banner danger">
          <strong>{t('warning.readOnly')}</strong>
          <span>{workspace.readOnlyError ?? workspace.projection.issues.map((issue) => issue.message).join(' · ')}</span>
        </div>
      {/if}
      {#if workspace.scanErrors.length}
        <div class="banner warning" title={workspace.scanErrors.join('\n')}>{t('common.error')} · {workspace.scanErrors[0]}</div>
      {/if}
      {#if wipAtLimit}
        <div class="banner danger wip-warning" role="alert" aria-live="polite" data-warning="wip">
          <strong>{t('warning.wip', {
            count: workspace.wip.length,
            limit: workspace.projection.wipLimit,
          })}</strong>
        </div>
      {/if}
      {#if workspace.projection.waitingExceeded}<div class="banner calm">{t('warning.waiting')}</div>{/if}

      {#if repair.length}
        <section class="repair">
          <div class="section-head"><h2>{t('section.repair')}</h2></div>
          <div class="repair-cards">
            {#each repair as item (item.key)}
              <IdeaCard
                {item}
                disabled={interactionDisabled}
                metadataDisabled={store.saving}
                canPlace={item.state === 'capture'}
                placeMenuOpen={placeMenu?.item.key === item.key}
                reminderView={reminderFor(item)}
                reminderMenuOpen={reminderMenu?.item.key === item.key}
                onReminder={item.kind === 'task' && !item.orphan && !item.repairReason ? openReminderMenu : undefined}
                onPlace={openPlaceMenu}
                onComplete={(value) => quickPlace(value, quickPlaceInput('done'))}
                onOpen={doOpen}
                onReopen={doReopen}
                onRelink={openRelink}
                onEditMetadata={item.path && !item.orphan && !item.repairReason ? openMetadata : undefined}
                onSuggestProject={(value, project) => openPlacement(value, undefined, [project])}
                onPreviewStart={previewStart}
                onPreviewEnd={previewEnd}
              />
            {/each}
          </div>
        </section>
      {/if}

      <div class="board-tools">
        <input class="search" type="search" bind:value={search} placeholder={t('search.placeholder')} />
        <label class="sort-control">
          <span>{t('sort.label')}</span>
          <select name="sortMode" value={sortMode} onchange={(event) => sortMode = event.currentTarget.value as SortMode}>
            <option value="priority">{t('sort.priority')}</option>
            <option value="due">{t('sort.due')}</option>
            <option value="created">{t('sort.created')}</option>
          </select>
        </label>
        <button class:active={showPlaced} aria-pressed={showPlaced} onclick={() => showPlaced = !showPlaced}>
          {showPlaced ? t('action.hidePlaced') : t('action.findPlaced')}
        </button>
      </div>

        <div class="board-scroll" onscroll={closePreview}>
        <div class="board">
          {#each lanes as lane (lane.id)}
            <section
              bind:this={laneElements[lane.id]}
              class="lane"
              aria-label={t(lane.title)}
              class:over={dragOver === lane.id}
              class:wip-limited={lane.id === 'wip' && wipAtLimit}
              class:available={Boolean(dragging && canDrop(dragging, lane.id))}
              data-lane={lane.id}
            >
              <header class="lane-head">
                <h2>{t(lane.title)}</h2>
                <span>{lane.count}</span>
              </header>
              <div class="lane-body" role="list" aria-label={t(lane.title)}>
                {#each lane.items as item (item.key)}
                  <div role="listitem">
                    <IdeaCard
                      {item}
                      disabled={interactionDisabled}
                      metadataDisabled={store.saving}
                      canDrag={item.state !== 'unsupported'}
                      dragging={dragging?.key === item.key}
                      canPlace={item.state !== 'closed' && item.state !== 'unsupported'}
                      canReopen={item.state === 'dormant' || item.state === 'closed'}
                      placeMenuOpen={placeMenu?.item.key === item.key}
                      reminderView={reminderFor(item)}
                      reminderMenuOpen={reminderMenu?.item.key === item.key}
                      onReminder={item.kind === 'task' && !item.orphan && !item.repairReason ? openReminderMenu : undefined}
                      kickoff={cardKickoff(item)}
                      onKickoff={clickKickoff}
                      onChooseKickoff={chooseKickoff}
                      onPlace={openPlaceMenu}
                      onComplete={(value) => quickPlace(value, quickPlaceInput('done'))}
                      onOpen={doOpen}
                      onReopen={doReopen}
                      onRelink={openRelink}
                      onEditMetadata={item.path && !item.orphan && !item.repairReason ? openMetadata : undefined}
                      onSuggestProject={(value, project) => openPlacement(value, undefined, [project])}
                      onDragStart={dragStart}
                      onPreviewStart={previewStart}
                      onPreviewEnd={previewEnd}
                    />
                  </div>
                {:else}
                  <p class="empty">{t(lane.empty)}</p>
                {/each}
              </div>
            </section>
          {/each}
        </div>
      </div>
      <p class="drag-help">{t('board.dragHelp')}</p>
    </div>
  {/if}
</main>

{#if dragging}
  <div class="drag-ghost" style="left:{ghostX}px; top:{ghostY}px">{dragging.title}</div>
{/if}

{#if previewing?.body}
  <aside
    bind:this={previewTip}
    id={previewTipId}
    class="idea-preview-tip"
    role="tooltip"
    style="left:{previewX}px; top:{previewY}px"
    onpointerenter={previewTipEnter}
    onpointerleave={previewTipLeave}
  ><pre>{previewing.body}</pre></aside>
{/if}

{#if celebration}
  {#key celebration}<CompletionConfetti />{/key}
{/if}

{#if placeMenu}
  <PlaceMenu
    anchor={placeMenu.anchor}
    itemTitle={placeMenu.item.title}
    saving={store.saving || placementSaving}
    onCancel={() => placeMenu = null}
    onSelect={(input) => placeMenu && quickPlace(placeMenu.item, input)}
    onMore={() => placeMenu && openPlacement(placeMenu.item)}
    onCompleteWithNote={canCompleteWithNote(placeMenu.item) ? () => placeMenu && openCompletionNote(placeMenu.item) : undefined}
  />
{/if}

{#if reminderMenu}
  <ReminderMenu anchor={reminderMenu.anchor} itemTitle={reminderMenu.item.title}
    view={effectiveReminderView(reminderMenu.view)} saving={store.saving}
    onCancel={() => reminderMenu = null} onSelect={quickReminder}
    onMore={() => reminderMenu && openReminderDetails(reminderMenu.item, reminderMenu.view)} />
{/if}

<span class="sr-only" role="status" aria-live="polite">{kickoffAnnouncement}</span>

{#if kickoffPicker}
  <KickoffPicker returnFocus={kickoffReturnFocus} options={kickoffSnapshot.providers} selected={rememberedKickoff()} dataSources={kickoffSnapshot.dataSources}
    onSelect={(providerId) => {
      const item = kickoffPicker!
      rememberProvider('next.kickoff', providerId)
      void requestKickoff(item, providerId)
    }} onClose={() => kickoffPicker = null} />
{/if}

{#if kickoffConsent}
  <KickoffConsent returnFocus={kickoffReturnFocus} onConfirm={() => {
    const pending = kickoffConsent!
    kickoffConsent = null
    void requestKickoff(pending.item, pending.providerId, true)
  }} onCancel={() => kickoffConsent = null} />
{/if}

{#if kickoffProgress}
  <KickoffProgress returnFocus={kickoffReturnFocus} title={kickoffProgress.title} input={kickoffInput(kickoffProgress)}
    hasPrevious={Boolean(kickoffSnapshot.results[kickoffProgress.task!.id])}
    onClose={() => kickoffProgress = null}
    onRetry={() => {
      const item = kickoffProgress!
      const providerId = kickoffSnapshot.registry.runs[item.task!.id]?.harness || rememberedKickoff()
      void requestKickoff(item, providerId)
    }} onChoose={() => chooseKickoff(kickoffProgress!)}
    onPrevious={() => void showKickoffResult(kickoffProgress!)} />
{/if}

{#if kickoffResult}
  {#key kickoffResult.result.doc.kickoff.run_id}
    <KickoffSheet returnFocus={kickoffReturnFocus} title={kickoffResult.item.title} result={kickoffResult.result}
      stale={kickoffSnapshot.hashes[kickoffResult.item.task!.id] !== undefined && kickoffResult.result.doc.kickoff.based_on !== kickoffSnapshot.hashes[kickoffResult.item.task!.id]}
      saving={kickoffSaving} error={kickoffSaveError} onSave={saveKickoffAnswers}
      onRegenerate={() => chooseKickoff(kickoffResult!.item)} onOpen={(path) => void openKickoffFile(path)}
      onClose={() => { if (!kickoffSaving) kickoffResult = null }} />
  {/key}
{/if}

{#if placing}
  <PlaceSheet
    item={placing}
    suspended={Boolean(editingReminder)}
    onReminder={placing.kind === 'task' && reminderFor(placing) ? () => openReminderDetails(placing!) : undefined}
    saving={store.saving || placementSaving}
    {completionNote}
    completionNoteLocked={Boolean(completionOperation)}
    {completionNoteError}
    initialRoute={placementRoute}
    initialProjects={placementProjects}
    initialCommit={placementCommit}
    extraOptions={placementExtraOptions}
    projectOptions={workspace?.projectOptions ?? []}
    onCancel={closePlacement}
    onSubmit={submitPlacement}
  />
{/if}

{#if relinking}
  <RelinkSheet item={relinking} saving={store.saving} onCancel={() => relinking = null} onSubmit={submitRelink} />
{/if}

{#if editingMetadata}
  <MetadataSheet
    itemTitle={editingMetadata.title}
    suspended={Boolean(editingReminder)}
    onReminder={editingMetadata.kind === 'task' && reminderFor(editingMetadata) ? () => openReminderDetails(editingMetadata!) : undefined}
    metadata={planningMetadataOf(editingMetadata)}
    saving={store.saving}
    onCancel={() => editingMetadata = null}
    onSubmit={submitMetadata}
  />
{/if}

{#if editingReminder}
  <ReminderSheet item={workspace?.items.find((value) => value.key === editingReminder!.item.key) ?? editingReminder.item}
    view={effectiveReminderView(editingReminder.view)} saving={store.saving}
    onCancel={() => editingReminder = null} onSubmit={submitReminder} />
{/if}

{#if creating}
  <CreateIdeaSheet
    ideaDir={workspace?.ideaDir ?? 'inbox/ideas'}
    defaults={createDefaults}
    saving={store.saving}
    onCancel={() => creating = false}
    onSubmit={submitIdea}
  />
{/if}

{#if creatingTask}
  <CreateTaskSheet
    taskDir={workspace?.taskDir ?? 'inbox/tasks'}
    defaultPriority={createDefaults.priority}
    defaultDue={createDefaults.due}
    defaultContexts={createDefaults.contexts}
    saving={store.saving}
    onCancel={() => creatingTask = false}
    onSubmit={submitTask}
  />
{/if}
</div>

<style>
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  :global(:root) {
    color-scheme: light dark;
    --bg: #f7f7f8;
    --card: #fff;
    --sheet: #fff;
    --input: #fff;
    --fg: #1d1d1f;
    --muted: #77777d;
    --muted-strong: #5d5d62;
    --line: #e3e3e7;
    --line-strong: #c9c9cf;
    --chip: #efeff2;
    --hover: #f2f2f4;
    --accent: #1677ff;
    --accent-soft: #eaf3ff;
    --proof-bg: #e8f5ed;
    --proof-fg: #247447;
    --warn-bg: #fff2d8;
    --warn-fg: #8b5b00;
    --danger: #c72c36;
    --shadow: #000;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #171719;
      --card: #222225;
      --sheet: #252528;
      --input: #1d1d20;
      --fg: #f2f2f4;
      --muted: #99999f;
      --muted-strong: #b7b7bc;
      --line: #343438;
      --line-strong: #4b4b51;
      --chip: #303034;
      --hover: #2c2c30;
      --accent: #4093ff;
      --accent-soft: #17385e;
      --proof-bg: #173a28;
      --proof-fg: #7bdca3;
      --warn-bg: #443316;
      --warn-fg: #f3c96f;
      --danger: #ff7b85;
      --shadow: #000;
    }
  }
  :global(html), :global(body) { height: 100%; }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Segoe UI', sans-serif; }
  :global(button), :global(input), :global(textarea), :global(select) { font-family: inherit; }
  .window-surface { --muted: var(--ui-secondary); --muted-strong: var(--ui-secondary); --accent: var(--ui-accent); --line: var(--ui-separator); --line-strong: var(--ui-control-border); }
  .app { min-height: 100vh; }
  .topbar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 20px 28px 16px; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter: blur(18px); }
  .title-block { min-width: 0; }
  h1 { margin: 0; font-size: 24px; line-height: 1.1; letter-spacing: -0.02em; }
  .subtitle-row { display: flex; align-items: center; min-width: 0; gap: 10px; margin-top: 5px; }
  .topbar p { margin: 0; color: var(--muted); }
  .project-filters { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; max-width: min(680px, 52vw); gap: 5px; overflow-x: auto; scrollbar-width: none; }
  .project-filters::-webkit-scrollbar { display: none; }
  .project-filters button { flex: none; max-width: 180px; overflow: hidden; border: 1px solid var(--line); border-radius: 999px; background: var(--chip); color: var(--muted-strong); padding: 3px 8px; font: inherit; font-size: 12px; font-weight: 600; line-height: 1.35; cursor: pointer; text-overflow: ellipsis; white-space: nowrap; }
  .project-filters button:hover { background: var(--hover); }
  .project-filters button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ui-accent-text); }
  .top-actions { flex: none; display: flex; align-items: center; gap: 8px; }
  .new-task, .new-idea, .refresh, .settings-button { min-height: 34px; box-sizing: border-box; border-radius: 9px; padding: 7px 10px; font-weight: 650; cursor: pointer; }
  .new-task, .new-idea { display: flex; align-items: center; gap: 7px; }
  .new-task { border: 1px solid var(--accent); background: var(--accent); color: #fff; }
  .new-task:hover:not(:disabled), .new-idea:hover:not(:disabled) { filter: brightness(1.06); }
  .new-idea { border: 1px solid var(--line-strong); background: var(--card); color: var(--fg); }
  .new-task kbd, .new-idea kbd { border-radius: 5px; background: color-mix(in srgb, currentColor 12%, transparent); padding: 1px 5px; font: 10px/1.5 inherit; }
  .refresh, .settings-button { flex: none; border: 1px solid var(--line); background: var(--card); color: var(--fg); font-weight: 600; }
  .settings-button { display: flex; align-items: center; gap: 6px; }
  .settings-button svg { width: 15px; height: 15px; }
  .refresh:hover:not(:disabled), .settings-button:hover:not(:disabled) { background: var(--hover); }
  .settings-button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--ui-accent-text); }
  .refresh:disabled, .settings-button:disabled, .new-task:disabled, .new-idea:disabled { opacity: 0.45; cursor: default; }
  .loading { min-height: 60vh; display: grid; place-items: center; color: var(--muted); }
  .content { padding: 22px 28px 48px; }
  .banner, .repair, .board-tools, .board-scroll, .drag-help { max-width: 1500px; margin-right: auto; margin-left: auto; }
  .banner { display: grid; gap: 3px; margin-bottom: 10px; padding: 10px 12px; border-radius: 10px; font-size: 12px; box-sizing: border-box; }
  .banner span { opacity: 0.75; overflow-wrap: anywhere; }
  .banner.danger { background: color-mix(in srgb, var(--danger) 12%, var(--card)); color: var(--danger); }
  .banner.wip-warning { border: 1px solid color-mix(in srgb, var(--danger) 72%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 10%, transparent); font-size: 13px; }
  .banner.warning { background: var(--warn-bg); color: var(--warn-fg); }
  .banner.calm { background: var(--chip); color: var(--muted-strong); }
  .repair { margin-bottom: 16px; }
  .section-head { margin: 0 2px 8px; }
  .section-head h2 { margin: 0; font-size: 13px; }
  .repair-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); gap: 8px; }
  .board-tools { display: flex; gap: 8px; margin-bottom: 12px; }
  .search { flex: 1; min-width: 160px; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--input); color: var(--fg); padding: 9px 11px; outline: none; }
  .search:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .sort-control { flex: none; display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--muted-strong); padding: 0 8px 0 10px; font-size: 12px; font-weight: 650; }
  .sort-control select { min-width: 118px; border: 0; background: transparent; color: var(--fg); padding: 8px 2px; outline: none; font: inherit; }
  .sort-control:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .board-tools button { flex: none; border: 1px solid var(--line); border-radius: 10px; background: var(--card); color: var(--fg); padding: 8px 12px; font-weight: 650; cursor: pointer; }
  .board-tools button:hover { background: var(--hover); }
  .board-tools button.active { border-color: var(--accent); color: var(--ui-accent-text); background: var(--accent-soft); }
  .board-scroll { overflow-x: auto; padding: 2px 2px 14px; }
  .board { display: grid; grid-template-columns: repeat(5, minmax(248px, 1fr)); gap: 12px; min-width: 1312px; }
  .lane { min-width: 0; min-height: 420px; margin: 0; padding: 10px; border: 1px solid var(--line); border-radius: 16px; background: color-mix(in srgb, var(--chip) 48%, transparent); transition: border-color 120ms ease, background 120ms ease; }
  .lane.available { border-style: dashed; }
  .lane.over { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
  .lane.wip-limited { border-color: color-mix(in srgb, var(--danger) 70%, var(--line)); background: color-mix(in srgb, var(--danger) 7%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 24%, transparent); }
  .lane.wip-limited .lane-head span { background: var(--danger); color: #fff; font-weight: 700; }
  .drag-ghost { position: fixed; z-index: 60; max-width: 240px; transform: translate(10px, 10px); overflow: hidden; border: 1px solid var(--accent); border-radius: 10px; background: var(--card); color: var(--fg); box-shadow: 0 8px 24px color-mix(in srgb, var(--shadow) 22%, transparent); padding: 9px 12px; font-size: 12px; font-weight: 650; opacity: 0.88; pointer-events: none; text-overflow: ellipsis; white-space: nowrap; }
  .idea-preview-tip { position: fixed; z-index: 15; width: min(380px, calc(100vw - 24px)); max-height: min(480px, calc(100vh - 24px)); box-sizing: border-box; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--line-strong); border-radius: 12px; background: color-mix(in srgb, var(--card) 96%, transparent); color: var(--fg); box-shadow: 0 14px 38px color-mix(in srgb, var(--shadow) 28%, transparent); padding: 14px 16px; backdrop-filter: blur(18px); }
  .idea-preview-tip pre { margin: 0; font-family: inherit; font-size: 12.5px; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
  .lane-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 4px 10px; }
  .lane-head h2 { margin: 0; font-size: 13px; letter-spacing: 0.01em; }
  .lane-head span { min-width: 20px; border-radius: 999px; background: var(--card); color: var(--muted); padding: 2px 7px; text-align: center; font-size: 12px; }
  .lane-body { display: grid; align-content: start; gap: 8px; min-height: 360px; }
  .empty { margin: 0; padding: 14px 5px; color: var(--muted); font-size: 12px; }
  .drag-help { margin-top: 8px; color: var(--muted); font-size: 12px; }
  @media (max-width: 900px) {
    .topbar { gap: 14px; }
    .new-task kbd, .new-idea kbd, .refresh span, .settings-button span { display: none; }
  }
  @media (max-width: 660px) {
    .topbar { align-items: flex-start; flex-wrap: wrap; padding: 16px 18px 13px; }
    .title-block { width: 100%; }
    .top-actions { flex-wrap: wrap; }
    .topbar p { max-width: 440px; }
    .board-tools { flex-wrap: wrap; }
    .sort-control { flex: 1 1 auto; }
    .subtitle-row { display: grid; gap: 6px; }
    .project-filters { width: 100%; max-width: 100%; }
    .content { padding: 18px 16px 36px; }
    .board { grid-template-columns: repeat(5, 248px); }
  }
</style>
