export type Locale = 'en' | 'zh' | 'ja' | 'de'

export type MessageKey =
  | 'kickoff.bodyPreserved'
  | 'kickoff.sourceFallback'
  | 'kickoff.source.taskOnly'
  | 'kickoff.failedNotice'
  | 'kickoff.source.task'
  | 'kickoff.source.marks'
  | 'kickoff.source.done-tasks'
  | 'kickoff.source.diary'
  | 'kickoff.failure.ineligible'
  | 'kickoff.failure.already-running'
  | 'kickoff.failure.capacity'
  | 'kickoff.failure.io-error'
  | 'kickoff.failure.conflict'
  | 'kickoff.picker.by'
  | 'kickoff.picker.title'
  | 'kickoff.picker.unknown'
  | 'kickoff.picker.broken'
  | 'kickoff.picker.notInstalled'
  | 'kickoff.picker.model'
  | 'kickoff.picker.empty'
  | 'kickoff.action'
  | 'kickoff.accessible'
  | 'kickoff.starting'
  | 'kickoff.view'
  | 'kickoff.stale'
  | 'kickoff.failed'
  | 'kickoff.steps'
  | 'kickoff.duration'
  | 'kickoff.choose'
  | 'kickoff.progress'
  | 'kickoff.continues'
  | 'kickoff.limit'
  | 'kickoff.retry'
  | 'kickoff.oldResult'
  | 'kickoff.raw'
  | 'kickoff.market'
  | 'kickoff.consentTitle'
  | 'kickoff.consentBody'
  | 'kickoff.consentStart'
  | 'kickoff.dataSources'
  | 'kickoff.sourceDisabled'
  | 'kickoff.unverifiedProvider'
  | 'kickoff.result'
  | 'kickoff.generated'
  | 'kickoff.staleBanner'
  | 'kickoff.regenerate'
  | 'kickoff.summary'
  | 'kickoff.questions'
  | 'kickoff.decides'
  | 'kickoff.recommended'
  | 'kickoff.other'
  | 'kickoff.context'
  | 'kickoff.inference'
  | 'kickoff.unverified'
  | 'kickoff.suggestions'
  | 'kickoff.blockers'
  | 'kickoff.waiting'
  | 'kickoff.gaps'
  | 'kickoff.place'
  | 'kickoff.save'
  | 'kickoff.saved'
  | 'kickoff.saveError'
  | 'kickoff.readyNotice'
  | 'kickoff.source'
  | 'kickoff.field.commitment'
  | 'kickoff.field.next_action'
  | 'kickoff.field.close_condition'
  | 'kickoff.field.owner'
  | 'kickoff.field.scope'
  | 'kickoff.field.other'
  | 'kickoff.failure.agent-missing'
  | 'kickoff.failure.start-error'
  | 'kickoff.failure.timeout'
  | 'kickoff.failure.error'
  | 'kickoff.failure.cancelled'
  | 'kickoff.failure.skipped'
  | 'kickoff.failure.lost'
  | 'kickoff.failure.missing-result'
  | 'kickoff.failure.invalid-output'
  | 'kickoff.failure.task-changed'
  | 'kickoff.failure.provider-unavailable'
  | 'kickoff.failure.consent-required'
  | 'kickoff.failure.result-changed'
  | 'kickoff.failure.unsupported'
  | 'kickoff.failure.busy'
  | 'kickoff.failure.save-error'
  | 'hook.environment.title'
  | 'hook.environment.help'
  | 'hook.environment.configured'
  | 'hook.environment.none'
  | 'hook.environment.save'
  | 'hook.environment.clear'
  | 'hook.environment.local'
  | 'hook.environment.saved'
  | 'hook.environment.cleared'
  | 'hook.environment.error'
  | 'hook.environment.unavailable'
  | 'hook.settings.title'
  | 'hook.settings.help'
  | 'hook.settings.none'
  | 'hook.settings.select'
  | 'hook.settings.clear'
  | 'hook.settings.local'
  | 'hook.settings.unavailable'
  | 'hook.settings.error'
  | 'hook.status.running'
  | 'hook.status.synced'
  | 'hook.status.noChanges'
  | 'hook.status.changes'
  | 'hook.status.pending'
  | 'hook.status.pendingReason'
  | 'hook.error.missingConfig'
  | 'hook.error.connection'
  | 'hook.error.busy'
  | 'hook.error.serverVersion'
  | 'hook.retry'
  | 'hook.dismiss'
  | 'app.title'
  | 'app.value'
  | 'filter.items'
  | 'common.loading'
  | 'common.refresh'
  | 'common.open'
  | 'common.cancel'
  | 'common.close'
  | 'common.save'
  | 'common.optional'
  | 'common.error'
  | 'empty.wip'
  | 'empty.waiting'
  | 'empty.capture'
  | 'empty.dormant'
  | 'empty.closed'
  | 'empty.search'
  | 'section.wip'
  | 'section.waiting'
  | 'section.capture'
  | 'section.resurfaced'
  | 'section.placed'
  | 'section.repair'
  | 'count.wip'
  | 'count.waiting'
  | 'action.placeOne'
  | 'action.newTask'
  | 'action.newIdea'
  | 'action.settings'
  | 'action.hideCapture'
  | 'action.findPlaced'
  | 'action.hidePlaced'
  | 'action.place'
  | 'action.placeMore'
  | 'action.completeWithNote'
  | 'field.completionNote'
  | 'field.completionNote.placeholder'
  | 'completionNote.savedPending'
  | 'completionNote.failed'
  | 'action.transfer'
  | 'action.reopen'
  | 'action.relink'
  | 'action.openSource'
  | 'badge.proofed'
  | 'badge.task'
  | 'badge.agent'
  | 'badge.orphan'
  | 'badge.unsupported'
  | 'badge.dueNone'
  | 'badge.due'
  | 'badge.overdue'
  | 'badge.contextMissing'
  | 'metadata.label'
  | 'metadata.edit.title'
  | 'metadata.edit.help'
  | 'metadata.edit.save'
  | 'metadata.edit.saveError'
  | 'metadata.edit.refreshWarning'
  | 'priority.P0'
  | 'priority.P1'
  | 'priority.P2'
  | 'priority.P3'
  | 'warning.wip'
  | 'warning.waiting'
  | 'warning.readOnly'
  | 'search.placeholder'
  | 'sort.label'
  | 'sort.priority'
  | 'sort.due'
  | 'sort.created'
  | 'board.dragHelp'
  | 'create.title'
  | 'create.destination'
  | 'create.field'
  | 'create.placeholder'
  | 'create.save'
  | 'create.saveShortcut'
  | 'task.create.title'
  | 'task.create.destination'
  | 'task.create.field'
  | 'task.create.placeholder'
  | 'task.create.body'
  | 'task.create.bodyPlaceholder'
  | 'task.create.doneWhen'
  | 'task.create.doneWhenPlaceholder'
  | 'task.create.saveInbox'
  | 'task.create.saveCurrent'
  | 'task.create.saveShortcut'
  | 'sheet.title'
  | 'sheet.choose'
  | 'route.commit'
  | 'route.commit.detail'
  | 'route.wait'
  | 'route.wait.detail'
  | 'route.park'
  | 'route.park.detail'
  | 'route.settle'
  | 'route.settle.detail'
  | 'field.commitment'
  | 'field.commitment.placeholder'
  | 'field.nextAction'
  | 'field.nextAction.placeholder'
  | 'field.closeCondition'
  | 'field.closeCondition.placeholder'
  | 'field.waitingFor'
  | 'field.waitingFor.placeholder'
  | 'field.reviewAt'
  | 'field.wakeTrigger'
  | 'field.wakeTrigger.placeholder'
  | 'field.wakeTrigger.help'
  | 'field.exitKind'
  | 'field.exitKind.placeholder'
  | 'field.exitVia'
  | 'field.exitVia.placeholder'
  | 'field.reason'
  | 'field.reason.placeholder'
  | 'field.target'
  | 'field.target.placeholder'
  | 'field.result'
  | 'field.result.placeholder'
  | 'field.project'
  | 'field.priority'
  | 'field.due'
  | 'field.contexts'
  | 'field.contexts.placeholder'
  | 'settings.title'
  | 'settings.description'
  | 'settings.wipLimit'
  | 'settings.wipLimit.help'
  | 'settings.defaultPriority'
  | 'settings.defaultPriority.help'
  | 'settings.defaultDueDays'
  | 'settings.defaultDueDays.help'
  | 'settings.defaultContext'
  | 'settings.defaultContext.help'
  | 'settings.validation'
  | 'settings.save'
  | 'settings.saving'
  | 'settings.saveError'
  | 'field.project.placeholder'
  | 'field.project.selected'
  | 'field.project.existing'
  | 'field.project.add'
  | 'field.project.help'
  | 'field.project.target'
  | 'field.project.target.placeholder'
  | 'project.suggestion'
  | 'project.suggestion.detail'
  | 'field.article'
  | 'field.article.placeholder'
  | 'preset.commit.verify'
  | 'preset.commit.prototype'
  | 'preset.commit.plan'
  | 'preset.commit.deliver'
  | 'preset.next.evidence'
  | 'preset.next.experiment'
  | 'preset.next.draft'
  | 'preset.next.user'
  | 'preset.close.decision'
  | 'preset.close.prototype'
  | 'preset.close.used'
  | 'preset.close.metric'
  | 'preset.wait.person'
  | 'preset.wait.agent'
  | 'preset.wait.review'
  | 'preset.wait.evidence'
  | 'preset.date.tomorrow'
  | 'preset.date.days3'
  | 'preset.date.week1'
  | 'preset.date.weeks2'
  | 'preset.date.month1'
  | 'preset.wake.week'
  | 'preset.wake.month'
  | 'preset.wake.related'
  | 'preset.wake.repeat'
  | 'preset.wake.evidence'
  | 'preset.reason.value'
  | 'preset.reason.timing'
  | 'preset.reason.disproved'
  | 'preset.reason.better'
  | 'preset.result.accepted'
  | 'preset.result.source'
  | 'preset.result.delivered'
  | 'preset.result.recorded'
  | 'exit.done'
  | 'exit.stopped'
  | 'exit.transferred'
  | 'exit.compressed'
  | 'via.none'
  | 'via.delegateDone'
  | 'via.article'
  | 'via.delegateTransferred'
  | 'via.drop'
  | 'via.disproved'
  | 'via.ignore'
  | 'via.merge'
  | 'via.project'
  | 'via.buy'
  | 'via.publish'
  | 'via.principle'
  | 'via.automate'
  | 'relink.title'
  | 'relink.helpExact'
  | 'relink.helpManual'
  | 'relink.created'
  | 'relink.createdUnknown'
  | 'relink.noCandidates'
  | 'error.required'
  | 'error.ideaRequired'
  | 'error.taskRequired'
  | 'error.doneWhenRequired'
  | 'error.createTask'
  | 'error.createRefresh'
  | 'error.createRefreshCurrent'
  | 'error.createCurrent'
  | 'error.create'
  | 'error.load'
  | 'error.save'
  | 'error.open'
  | 'status.capture'
  | 'status.wip'
  | 'status.waiting'
  | 'status.dormant'
  | 'outcome.done'
  | 'outcome.stopped'
  | 'outcome.transferred'
  | 'outcome.compressed'
  | 'reminder.open'
  | 'reminder.title'
  | 'reminder.status.automatic'
  | 'reminder.status.paused'
  | 'reminder.status.muted'
  | 'reminder.status.legacy'
  | 'reminder.status.error'
  | 'reminder.status.closed'
  | 'reminder.saved'
  | 'reminder.saveError'
  | 'reminder.refreshWarning'
  | 'reminder.loading'
  | 'reminder.pauseHour'
  | 'reminder.pauseTomorrow'
  | 'reminder.resume'
  | 'reminder.mute'
  | 'reminder.more'
  | 'reminder.policy'
  | 'reminder.pauseUntil'
  | 'reminder.timeZone'
  | 'reminder.due'
  | 'reminder.noDue'
  | 'reminder.state'
  | 'reminder.help'
  | 'reminder.resumeHelp'
  | 'reminder.syncHelp'
  | 'reminder.legacyHelp'
  | 'reminder.errorHelp'
  | 'reminder.unsupportedHelp'
  | 'reminder.closedHelp'
  | 'reminder.save'
  | 'reminder.validation.invalid'
  | 'reminder.validation.past'
  | 'reminder.validation.ambiguous'
  | 'reminder.validation.nonexistent'
  | 'status.closed'
  | 'status.unsupported'

type Catalog = Record<MessageKey, string>

const en: Catalog = {
  "kickoff.bodyPreserved": "The body was edited manually and was not rendered again.",
  "kickoff.sourceFallback": "The procedure could not be parsed. Only the task file will be read.",
  "kickoff.source.taskOnly": "Task file",
  "kickoff.failedNotice": "Kickoff failed",
  "kickoff.source.task": "Task file and its sources",
  "kickoff.source.marks": "Annotation notes (your judgments)",
  "kickoff.source.done-tasks": "Completed tasks and completion notes in the same project",
  "kickoff.source.diary": "Diary and decision records",
  "kickoff.failure.ineligible": "This task is no longer in an eligible lane",
  "kickoff.failure.already-running": "This task already has a running kickoff",
  "kickoff.failure.capacity": "This agent has reached its run limit",
  "kickoff.failure.io-error": "Could not read or save kickoff files",
  "kickoff.failure.conflict": "Conflicting kickoff results were found",
  "kickoff.picker.by": "by {name}",
  "kickoff.picker.title": "Choose an agent",
  "kickoff.picker.unknown": "Status unavailable",
  "kickoff.picker.broken": "Agent unavailable",
  "kickoff.picker.notInstalled": "Not installed",
  "kickoff.picker.model": "Model {model}",
  "kickoff.picker.empty": "No agents installed",
  "kickoff.action": "Get me started",
  "kickoff.accessible": "Get me started: {title}",
  "kickoff.starting": "Starting…",
  "kickoff.view": "View kickoff",
  "kickoff.stale": "Outdated",
  "kickoff.failed": "Kickoff failed · Retry",
  "kickoff.steps": "Step {steps} · {last}",
  "kickoff.duration": "Took {time}",
  "kickoff.choose": "Choose another agent",
  "kickoff.progress": "Kickoff in progress",
  "kickoff.continues": "Closing this window does not stop the run.",
  "kickoff.limit": "Runs last at most 10 minutes. Stopping midway is not supported yet.",
  "kickoff.retry": "Retry",
  "kickoff.oldResult": "View previous kickoff",
  "kickoff.raw": "Raw output (first 2 KiB)",
  "kickoff.market": "Install or enable an agent plugin in the plugin marketplace.",
  "kickoff.consentTitle": "Add the kickoff procedure?",
  "kickoff.consentBody": "This adds skills/task-kickoff/SKILL.md and .notemd/agent-tasks/next-task-kickoff/ to this vault. The agent can only read this vault and cannot write files.",
  "kickoff.consentStart": "Add and start",
  "kickoff.dataSources": "Will read (this vault only, read-only)",
  "kickoff.sourceDisabled": "Not enabled",
  "kickoff.unverifiedProvider": "Update this agent plugin to support read-only kickoff",
  "kickoff.result": "Kickoff",
  "kickoff.generated": "Generated {time}",
  "kickoff.staleBanner": "This kickoff is based on an older version of the task.",
  "kickoff.regenerate": "Generate again",
  "kickoff.summary": "Summary",
  "kickoff.questions": "Your answers",
  "kickoff.decides": "Decides: {field}",
  "kickoff.recommended": "Recommended",
  "kickoff.other": "Other",
  "kickoff.context": "Known context",
  "kickoff.inference": "Inference",
  "kickoff.unverified": "Source missing",
  "kickoff.suggestions": "Suggestions",
  "kickoff.blockers": "Possible blockers",
  "kickoff.waiting": "Waiting for",
  "kickoff.gaps": "Not found",
  "kickoff.place": "Place with these answers in Now",
  "kickoff.save": "Save answers only",
  "kickoff.saved": "Answers saved",
  "kickoff.saveError": "Could not save answers. Your answers are kept here.",
  "kickoff.readyNotice": "Kickoff is ready",
  "kickoff.source": "Open source: {title}",
  "kickoff.field.commitment": "Commitment",
  "kickoff.field.next_action": "Next action",
  "kickoff.field.close_condition": "Closing condition",
  "kickoff.field.owner": "Owner",
  "kickoff.field.scope": "Scope",
  "kickoff.field.other": "Other",
  "kickoff.failure.agent-missing": "No available agent plugin",
  "kickoff.failure.start-error": "Could not start the agent",
  "kickoff.failure.timeout": "The run did not finish within 10 minutes",
  "kickoff.failure.error": "The agent reported an error",
  "kickoff.failure.cancelled": "The run was cancelled",
  "kickoff.failure.skipped": "The agent skipped the run",
  "kickoff.failure.lost": "The run was interrupted without a result",
  "kickoff.failure.missing-result": "The agent finished, but its result was too large or was not saved",
  "kickoff.failure.invalid-output": "The agent output did not match the required format",
  "kickoff.failure.task-changed": "The task was deleted or its identity changed during the run",
  "kickoff.failure.provider-unavailable": "This agent is not available for kickoff yet",
  "kickoff.failure.consent-required": "Confirm adding the kickoff procedure first",
  "kickoff.failure.result-changed": "The result changed. Reopen it before saving answers.",
  "kickoff.failure.unsupported": "This host does not support kickoff",
  "kickoff.failure.busy": "This task already has a running kickoff",
  "kickoff.failure.save-error": "The result could not be saved",
  "hook.environment.title": "Script environment variables",
  "hook.environment.help": "Enter one KEY=value per line. Only DESK_DISPLAY_URL and DESK_DISPLAY_TOKEN are supported. Saving replaces all saved variables.",
  "hook.environment.configured": "Saved variables: {keys}",
  "hook.environment.none": "No environment overrides saved",
  "hook.environment.save": "Save environment variables",
  "hook.environment.clear": "Clear saved variables",
  "hook.environment.local": "Saved immediately on this device for this Vault. NEXT script runs prioritize these values without changing the existing env file. Scheduled jobs are unaffected. Saving or clearing does not run the script; saved values are not shown again.",
  "hook.environment.saved": "Environment variables saved locally only. The connection has not been tested. The input has been cleared.",
  "hook.environment.cleared": "Environment overrides cleared. The script will use its original configuration.",
  "hook.environment.error": "Could not save environment variables. Check the KEY=value format and supported variable names, then try again.",
  "hook.environment.unavailable": "Update note.md to configure script environment variables here.",
  "hook.settings.title": "Cube sync script",
  "hook.settings.help": "After a Task status, reminder setting or due date is saved, run a Python script from this Vault’s skills folder. Runs directly without an AI model or tokens.",
  "hook.settings.none": "No script selected",
  "hook.settings.select": "Choose Python script…",
  "hook.settings.clear": "Disable",
  "hook.settings.local": "Selection takes effect immediately on this device and Vault. Python 3 and the script dependencies must be installed; Cube credentials stay on this device.",
  "hook.settings.unavailable": "This host does not support script execution. Update note.md to a version with task hook support.",
  "hook.settings.error": "Could not change the script configuration.",
  "hook.status.running": "“{title}” saved · Syncing Cube…",
  "hook.status.synced": "“{title}” saved · Script finished; no change counts provided.",
  "hook.status.noChanges": "“{title}” saved · Script reports: check complete, no changes needed this time.",
  "hook.status.changes": "“{title}” saved · Script reports: {created} created, {updated} updated, {deleted} removed. This does not confirm the device display.",
  "hook.status.pending": "“{title}” saved · Cube sync pending. Check the script, Python dependencies and Cube connection.",
  "hook.status.pendingReason": "“{title}” saved · Cube sync pending. {reason}",
  "hook.error.missingConfig": "Missing Cube configuration. Set DESK_DISPLAY_URL and DESK_DISPLAY_TOKEN in NEXT settings or ~/.config/desk-display/env.",
  "hook.error.connection": "Cannot connect to Cube. Check the server address and network.",
  "hook.error.busy": "Another sync is running. Try again shortly.",
  "hook.error.serverVersion": "The Cube server does not support safe creation. Update the Cube service.",
  "hook.retry": "Retry sync",
  "hook.dismiss": "Dismiss sync status",
  'app.title': 'Next',
  'app.value': 'Give ideas and tasks a clear next step — or a place to rest.',
  'filter.items': 'Type and project filters',
  'common.loading': 'Loading…',
  'common.refresh': 'Refresh',
  'common.open': 'Open',
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.save': 'Place item',
  'common.optional': 'Optional',
  'common.error': 'Something went wrong',
  'empty.wip': 'Nothing is actively committed.',
  'empty.waiting': 'Nothing is waiting for review.',
  'empty.capture': 'No recent items need a decision.',
  'empty.dormant': 'Nothing needs to return to view.',
  'empty.closed': 'Closed items stay out of sight until you show or search them.',
  'empty.search': 'No placed items match.',
  'section.wip': 'In Progress',
  'section.waiting': 'Waiting',
  'section.capture': 'Inbox',
  'section.resurfaced': 'Back in view',
  'section.placed': 'Placed items',
  'section.repair': 'Needs attention',
  'count.wip': '{count}/{limit}',
  'count.waiting': '{count}',
  'action.placeOne': 'Place an item',
  'action.newTask': 'New Task',
  'action.newIdea': 'New Idea',
  'action.settings': 'Settings',
  'action.hideCapture': 'Hide items',
  'action.findPlaced': 'Show placed items',
  'action.hidePlaced': 'Hide placed items',
  'action.place': 'Place',
  'action.placeMore': 'More…',
  'completionNote.savedPending': 'The note was saved to the Task source, but completion is not confirmed. Retry; the note will not be added twice.',
  'completionNote.failed': 'Saving is not confirmed. Your content is preserved; retry the same note.',
  'action.completeWithNote': 'Complete and add a note',
  'field.completionNote': 'Add a short note',
  'field.completionNote.placeholder': 'What was completed? You can paste multiple lines.',
  'action.transfer': 'Transfer to someone else',
  'action.reopen': 'Reopen',
  'action.relink': 'Relink',
  'action.openSource': 'Open source',
  'badge.proofed': 'Proofed',
  'badge.task': 'Task',
  'badge.agent': 'Agent',
  'badge.orphan': 'Source missing',
  'badge.unsupported': 'Needs repair',
  'badge.dueNone': 'No due date',
  'badge.due': 'Due {date}',
  'badge.overdue': 'Overdue {date}',
  'badge.contextMissing': 'Context not clarified',
  'metadata.label': 'Priority, due date, and contexts',
  'metadata.edit.title': 'Edit planning for “{title}”',
  'metadata.edit.help': 'These values are saved directly in the card source.',
  'metadata.edit.save': 'Save metadata',
  'metadata.edit.saveError': 'Could not save metadata. Your edits are still here.',
  'metadata.edit.refreshWarning': 'Metadata was saved, but Next could not refresh the board yet.',
  'priority.P0': 'P0 · Urgent',
  'priority.P1': 'P1 · High',
  'priority.P2': 'P2 · Normal',
  'priority.P3': 'P3 · Low',
  'warning.wip': 'WIP limit reached: {count} items are in progress (limit {limit}). Finish, wait, or move at least one to Later. This warning stays visible until In Progress is below the limit.',
  'warning.waiting': 'More than five items are waiting. Make sure each still has a real review responsibility.',
  'warning.readOnly': 'Next is read-only until its event document is repaired.',
  'search.placeholder': 'Search title, action, or destination',
  'sort.label': 'Sort',
  'sort.priority': 'Priority first',
  'sort.due': 'Due date first',
  'sort.created': 'Newest added first',
  'board.dragHelp': 'Drag a card to change its status. Choose More… under Place to add details.',
  'create.title': 'New Idea',
  'create.destination': 'Save to {path}',
  'create.field': 'Idea',
  'create.placeholder': 'Write down the thought before it disappears…',
  'create.save': 'Create Idea',
  'create.saveShortcut': '⌘↵ / Ctrl↵ to save',
  'task.create.title': 'New Task',
  'task.create.destination': 'Save to {path}',
  'task.create.field': 'Task',
  'task.create.placeholder': 'What needs to be done?',
  'task.create.body': 'Context',
  'task.create.bodyPlaceholder': 'The information needed to resume this task',
  'task.create.doneWhen': 'Done when',
  'task.create.doneWhenPlaceholder': 'What observable result means this is complete?',
  'task.create.saveInbox': 'Add to Inbox',
  'task.create.saveCurrent': 'Save and mark current',
  'task.create.saveShortcut': '⌘↵ / Ctrl↵ adds to Inbox',
  'sheet.title': 'Place “{title}”',
  'sheet.choose': 'What happens next?',
  'route.commit': 'Move forward now',
  'route.commit.detail': 'Take responsibility for a concrete next step.',
  'route.wait': 'Wait to review',
  'route.wait.detail': 'An external result still needs your acceptance.',
  'route.park': 'Look again later',
  'route.park.detail': 'Keep the memory without a current commitment.',
  'route.settle': 'End or move elsewhere',
  'route.settle.detail': 'Finish, stop, transfer, or turn it into a stable system.',
  'field.commitment': 'Commitment',
  'field.commitment.placeholder': 'What will you verify or deliver?',
  'field.nextAction': 'Next action',
  'field.nextAction.placeholder': 'A step you can start without thinking again',
  'field.closeCondition': 'Close condition',
  'field.closeCondition.placeholder': 'What result or evidence lets you stop?',
  'field.waitingFor': 'Waiting for',
  'field.waitingFor.placeholder': 'Person, result, evidence, or purchase trial',
  'field.reviewAt': 'Review on',
  'field.wakeTrigger': 'Wake trigger',
  'field.wakeTrigger.placeholder': 'A date or a concrete situation',
  'field.wakeTrigger.help': 'Dates resurface automatically. Situations stay searchable; Next does not detect them.',
  'field.exitKind': 'Outcome',
  'field.exitKind.placeholder': 'Choose an outcome',
  'field.exitVia': 'How',
  'field.exitVia.placeholder': 'Choose how',
  'field.reason': 'Reason',
  'field.reason.placeholder': 'Why is stopping the right decision?',
  'field.target': 'Destination',
  'field.target.placeholder': 'Project, person, product, link, rule, or automation',
  'field.result': 'Result',
  'field.result.placeholder': 'Optional result or evidence link',
  'field.project': 'Project',
  'field.priority': 'Priority',
  'field.due': 'Due date · Optional',
  'field.contexts': 'GTD context · Optional',
  'field.contexts.placeholder': '@computer, @phone (comma-separated)',
  'settings.title': 'Next Settings',
  'settings.description': 'These settings apply only to Next and to cards you create from now on.',
  'settings.wipLimit': 'In Progress limit',
  'settings.wipLimit.help': 'Show a persistent warning when In Progress reaches this number.',
  'settings.defaultPriority': 'Default priority',
  'settings.defaultPriority.help': 'Prefill the priority for new Ideas and Tasks.',
  'settings.defaultDueDays': 'Default due date',
  'settings.defaultDueDays.help': 'Days after creation; use 0 to leave new cards without a due date.',
  'settings.defaultContext': 'Default GTD context',
  'settings.defaultContext.help': 'Optional context prefilled for new cards, such as @computer or @phone.',
  'settings.validation': 'Enter whole numbers: the In Progress limit must be at least 1, and due days cannot be negative.',
  'settings.save': 'Save Settings',
  'settings.saving': 'Saving…',
  'settings.saveError': 'Next could not save these settings. Your edits are still here.',
  'field.project.placeholder': 'Choose or enter a project',
  'field.project.selected': 'Selected projects',
  'field.project.existing': 'Existing projects',
  'field.project.add': 'Add',
  'field.project.help': 'Select more than one, or create a new tag.',
  'field.project.target': 'Upgrade to which project?',
  'field.project.target.placeholder': 'Choose one project',
  'project.suggestion': 'Suggested · {project}',
  'project.suggestion.detail': 'Local match: {terms}. Click to confirm before placing.',
  'field.article': 'Published article',
  'field.article.placeholder': 'Article path or public URL',
  'preset.commit.verify': 'Verify whether “{title}” is worth continuing',
  'preset.commit.prototype': 'Build a usable prototype of “{title}”',
  'preset.commit.plan': 'Turn “{title}” into a reviewable plan',
  'preset.commit.deliver': 'Deliver the smallest useful result for “{title}”',
  'preset.next.evidence': 'Collect three key pieces of evidence',
  'preset.next.experiment': 'Run one minimal experiment',
  'preset.next.draft': 'Write the first version',
  'preset.next.user': 'Ask one real user to review it',
  'preset.close.decision': 'Reach a clear continue-or-stop decision',
  'preset.close.prototype': 'Complete a usable prototype',
  'preset.close.used': 'One person uses it and gives feedback',
  'preset.close.metric': 'Meet the chosen validation measure',
  'preset.wait.person': 'A person’s reply about “{title}”',
  'preset.wait.agent': 'An agent’s result for “{title}”',
  'preset.wait.review': 'Review or acceptance feedback on “{title}”',
  'preset.wait.evidence': 'Key evidence about “{title}”',
  'preset.date.tomorrow': 'Tomorrow',
  'preset.date.days3': 'In 3 days',
  'preset.date.week1': 'In 1 week',
  'preset.date.weeks2': 'In 2 weeks',
  'preset.date.month1': 'In 1 month',
  'preset.wake.week': 'Next week',
  'preset.wake.month': 'Next month',
  'preset.wake.related': 'When a related project starts',
  'preset.wake.repeat': 'When the same problem appears again',
  'preset.wake.evidence': 'When key evidence appears',
  'preset.reason.value': 'Not valuable enough',
  'preset.reason.timing': 'The timing is wrong',
  'preset.reason.disproved': 'The core assumption was disproved',
  'preset.reason.better': 'A better solution already exists',
  'preset.result.accepted': 'Completed and accepted',
  'preset.result.source': 'The source note is the result',
  'preset.result.delivered': 'Delivered',
  'preset.result.recorded': 'Evidence has been recorded',
  'exit.done': 'Done',
  'exit.stopped': 'Stopped',
  'exit.transferred': 'Moved elsewhere',
  'exit.compressed': 'Turned into a system',
  'via.none': 'Completed directly',
  'via.delegateDone': 'Delegated and accepted',
  'via.article': 'Organized and published as a complete article',
  'via.delegateTransferred': 'Responsibility transferred',
  'via.drop': 'Dropped',
  'via.disproved': 'Disproved',
  'via.ignore': 'Ignored',
  'via.merge': 'Merged',
  'via.project': 'Moved to project',
  'via.buy': 'Bought an existing solution',
  'via.publish': 'Published source material for others to continue',
  'via.principle': 'Turned into a principle',
  'via.automate': 'Automated',
  'relink.title': 'Relink source',
  'relink.helpExact': 'These files have the same creation time. Confirm the correct source; Next will not rename or edit it.',
  'relink.helpManual': 'No creation-time match was found. These are unclaimed idea files; check the path and time yourself.',
  'relink.created': 'Created',
  'relink.createdUnknown': 'unknown',
  'relink.noCandidates': 'No unclaimed idea files were found.',
  'error.required': 'Complete the required fields.',
  'error.ideaRequired': 'Write down the idea before saving.',
  'error.taskRequired': 'Name the task before saving.',
  'error.doneWhenRequired': 'Add a done condition before marking this task current.',
  'error.createTask': 'Next could not create this Task.',
  'error.createRefresh': 'The Task was saved, but Next could not refresh the Inbox.',
  'error.createRefreshCurrent': 'The Task was saved, but Inbox refresh failed, so it was not marked current.',
  'error.createCurrent': 'The Task is safe in Inbox, but could not be marked current.',
  'error.create': 'Next could not create this Idea.',
  'error.load': 'Next could not load your items.',
  'error.save': 'Next could not save this decision.',
  'error.open': 'The source file could not be opened.',
  'status.capture': 'Inbox',
  'status.wip': 'In Progress',
  'status.waiting': 'Waiting',
  'status.dormant': 'Someday',
  'outcome.done': 'Completed',
  'outcome.stopped': 'Stopped',
  'outcome.transferred': 'Transferred',
  'outcome.compressed': 'Compressed',
  'reminder.open': 'Manage reminders',
  'reminder.title': 'Reminders for “{title}”',
  'reminder.status.automatic': 'Automatic reminders',
  'reminder.status.paused': 'Paused until {time}',
  'reminder.status.muted': 'Reminders off',
  'reminder.status.legacy': 'Independently closed',
  'reminder.status.error': 'Reminder status unavailable',
  'reminder.status.closed': 'No further reminders',
  'reminder.saved': 'Reminder settings saved',
  'reminder.saveError': 'Could not save reminder settings. Your edits are preserved.',
  'reminder.refreshWarning': 'Reminder settings saved; status could not be refreshed yet.',
  'reminder.loading': 'Reading reminder status…',
  'reminder.pauseHour': 'Pause for 1 hour',
  'reminder.pauseTomorrow': 'Pause until tomorrow at 9:00',
  'reminder.resume': 'Resume automatic reminders',
  'reminder.mute': 'Turn off reminders',
  'reminder.more': 'More…',
  'reminder.policy': 'Reminders',
  'reminder.pauseUntil': 'Pause until (optional)',
  'reminder.timeZone': 'Local time zone: {zone}',
  'reminder.due': 'Due date',
  'reminder.noDue': 'No due date set',
  'reminder.state': 'Current reminder status',
  'reminder.help': 'Turning off reminders does not complete the task.',
  'reminder.resumeHelp': 'Resuming uses the existing reminder rules; it does not send immediately.',
  'reminder.syncHelp': 'Changes take effect at the next reminder sync; the current display may still show an earlier message.',
  'reminder.legacyHelp': 'An independent closure record still applies. Automatic reminders cannot be restored here.',
  'reminder.errorHelp': 'The existing reminder record could not be read. It will not be overwritten.',
  'reminder.unsupportedHelp': 'Repair this task before changing its reminders.',
  'reminder.closedHelp': 'This task has ended and will no longer receive reminders. Reopen the task before changing reminders.',
  'reminder.save': 'Save reminder settings',
  'reminder.validation.invalid': 'Enter a valid local date and time.',
  'reminder.validation.past': 'The pause end must be in the future.',
  'reminder.validation.ambiguous': 'This local time occurs twice because the clocks change. Choose another time.',
  'reminder.validation.nonexistent': 'This local time does not exist because the clocks change. Choose another time.',
  'status.closed': 'Closed',
  'status.unsupported': 'Unsupported',
}

const zh: Catalog = {
  "kickoff.bodyPreserved": "正文有手动修改，未重新渲染。",
  "kickoff.sourceFallback": "规程无法解析，仅读取任务文件。",
  "kickoff.source.taskOnly": "任务文件",
  "kickoff.failedNotice": "开头失败",
  "kickoff.source.task": "任务文件及其 sources",
  "kickoff.source.marks": "批注笔记（你的判断）",
  "kickoff.source.done-tasks": "同项目的已完成任务与完成笔记",
  "kickoff.source.diary": "日记与决策记录",
  "kickoff.failure.ineligible": "任务已不在可开头的泳道",
  "kickoff.failure.already-running": "这个任务已有正在运行的开头",
  "kickoff.failure.capacity": "此 agent 已达到并发运行上限",
  "kickoff.failure.io-error": "无法读取或保存开头文件",
  "kickoff.failure.conflict": "发现冲突的开头结果",
  "kickoff.picker.by": "由 {name}",
  "kickoff.picker.title": "选择 agent",
  "kickoff.picker.unknown": "状态不可用",
  "kickoff.picker.broken": "agent 不可用",
  "kickoff.picker.notInstalled": "尚未安装",
  "kickoff.picker.model": "模型 {model}",
  "kickoff.picker.empty": "尚未安装 agent",
  "kickoff.action": "帮我开个头",
  "kickoff.accessible": "帮我开个头：{title}",
  "kickoff.starting": "正在启动…",
  "kickoff.view": "查看开头",
  "kickoff.stale": "已过期",
  "kickoff.failed": "开头失败 · 重试",
  "kickoff.steps": "第 {steps} 步 · {last}",
  "kickoff.duration": "用时 {time}",
  "kickoff.choose": "换个 agent",
  "kickoff.progress": "正在帮你开个头",
  "kickoff.continues": "运行期间关闭窗口不影响结果。",
  "kickoff.limit": "运行最长 10 分钟，暂不支持中途停止。",
  "kickoff.retry": "重试",
  "kickoff.oldResult": "查看旧结果",
  "kickoff.raw": "原始输出（前 2 KiB）",
  "kickoff.market": "请在插件市场安装或启用 agent 插件。",
  "kickoff.consentTitle": "添加开头规程？",
  "kickoff.consentBody": "将在 vault 添加 skills/task-kickoff/SKILL.md 与 .notemd/agent-tasks/next-task-kickoff/。agent 只能读取本 vault，不能写入任何文件。",
  "kickoff.consentStart": "添加并开始",
  "kickoff.dataSources": "将读取（仅本 vault，只读）",
  "kickoff.sourceDisabled": "未启用",
  "kickoff.unverifiedProvider": "请更新此 Agent 插件以支持只读开头",
  "kickoff.result": "开个头",
  "kickoff.generated": "生成于 {time}",
  "kickoff.staleBanner": "结果基于任务的旧版本。",
  "kickoff.regenerate": "重新生成",
  "kickoff.summary": "一句话",
  "kickoff.questions": "需要你回答",
  "kickoff.decides": "决定：{field}",
  "kickoff.recommended": "推荐",
  "kickoff.other": "其他",
  "kickoff.context": "已知背景",
  "kickoff.inference": "推断",
  "kickoff.unverified": "来源缺失",
  "kickoff.suggestions": "建议",
  "kickoff.blockers": "可能的卡点",
  "kickoff.waiting": "要等的人",
  "kickoff.gaps": "没查到的",
  "kickoff.place": "用这些答案安放到现在推进",
  "kickoff.save": "只保存答案",
  "kickoff.saved": "答案已保存",
  "kickoff.saveError": "答案未能保存，已保留当前输入。",
  "kickoff.readyNotice": "开头已就绪",
  "kickoff.source": "打开来源：{title}",
  "kickoff.field.commitment": "承担表述",
  "kickoff.field.next_action": "下一步",
  "kickoff.field.close_condition": "关闭条件",
  "kickoff.field.owner": "承担人",
  "kickoff.field.scope": "范围",
  "kickoff.field.other": "其他",
  "kickoff.failure.agent-missing": "没有可用的 agent 插件",
  "kickoff.failure.start-error": "启动失败",
  "kickoff.failure.timeout": "超过 10 分钟仍未完成",
  "kickoff.failure.error": "agent 运行出错",
  "kickoff.failure.cancelled": "运行已取消",
  "kickoff.failure.skipped": "agent 跳过了运行",
  "kickoff.failure.lost": "运行中断，没有留下结果",
  "kickoff.failure.missing-result": "agent 完成了，但结果过大或没有保存",
  "kickoff.failure.invalid-output": "agent 的输出不符合格式",
  "kickoff.failure.task-changed": "任务在运行期间被删除，或换了身份",
  "kickoff.failure.provider-unavailable": "此 agent 暂不可用于开头功能",
  "kickoff.failure.consent-required": "请先确认添加开头规程",
  "kickoff.failure.result-changed": "结果已变化，请重新打开后保存答案。",
  "kickoff.failure.unsupported": "当前宿主不支持开头功能",
  "kickoff.failure.busy": "这个任务已有正在运行的开头",
  "kickoff.failure.save-error": "结果未能保存",
  "hook.environment.title": "脚本环境变量",
  "hook.environment.help": "每行填写 KEY=value，仅支持 DESK_DISPLAY_URL 和 DESK_DISPLAY_TOKEN。保存会替换全部已保存变量。",
  "hook.environment.configured": "已保存变量：{keys}",
  "hook.environment.none": "尚未保存环境变量覆盖",
  "hook.environment.save": "保存环境变量",
  "hook.environment.clear": "清除已保存变量",
  "hook.environment.local": "立即保存到本机当前 Vault 的配置。仅 NEXT 运行脚本时优先使用这里的值，不改写原有 env 文件，不影响定时任务。保存或清除不会运行脚本；已保存的值不再回显。",
  "hook.environment.saved": "环境变量已保存，仅保存在本机，尚未测试连接。输入框已清空。",
  "hook.environment.cleared": "环境变量覆盖已清除，脚本将恢复读取原有配置。",
  "hook.environment.error": "无法保存环境变量。请检查 KEY=value 格式及支持的变量名后重试。",
  "hook.environment.unavailable": "请更新 note.md 后在这里配置脚本环境变量。",
  "hook.settings.title": "Cube 同步脚本",
  "hook.settings.help": "任务状态、提醒设置或期限保存后，直接运行当前 Vault 的 skills 目录中的 Python 脚本。不调用模型，不消耗 token。",
  "hook.settings.none": "尚未选择脚本",
  "hook.settings.select": "选择 Python 脚本…",
  "hook.settings.clear": "停用",
  "hook.settings.local": "选择后立即对本机当前 Vault 生效。需要 Python 3 及脚本依赖；Cube 凭据保存在本机。",
  "hook.settings.unavailable": "当前宿主不支持直接执行脚本，请更新到支持此功能的 note.md。",
  "hook.settings.error": "无法更改脚本配置。",
  "hook.status.running": "“{title}”已保存 · 正在同步 Cube…",
  "hook.status.synced": "“{title}”已保存 · 脚本执行完成，未提供变更统计。",
  "hook.status.noChanges": "“{title}”已保存 · 脚本报告：检查完成，本次无需变更。",
  "hook.status.changes": "“{title}”已保存 · 脚本报告：新增 {created} 条、更新 {updated} 条、撤下 {deleted} 条；不代表设备已显示。",
  "hook.status.pending": "“{title}”已保存 · Cube 待同步。请检查脚本、Python 依赖和 Cube 连接。",
  "hook.status.pendingReason": "“{title}”已保存 · Cube 待同步。{reason}",
  "hook.error.missingConfig": "缺少 Cube 配置：请在 NEXT 设置或 ~/.config/desk-display/env 中配置 DESK_DISPLAY_URL 和 DESK_DISPLAY_TOKEN。",
  "hook.error.connection": "无法连接 Cube，请检查服务地址和网络。",
  "hook.error.busy": "另一个同步正在运行，请稍后重试。",
  "hook.error.serverVersion": "Cube 服务尚不支持安全创建，请更新 Cube 服务。",
  "hook.retry": "重试同步",
  "hook.dismiss": "关闭同步提示",
  'app.title': '下一步',
  'app.value': '让想法和任务都有明确的下一步，或一个安心的去处。',
  'filter.items': '类型与项目筛选',
  'common.loading': '正在载入…',
  'common.refresh': '刷新',
  'common.open': '打开',
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.save': '确认安放',
  'common.optional': '可选',
  'common.error': '出现了问题',
  'empty.wip': '手上没有正在承诺的事项。',
  'empty.waiting': '没有等待回收的结果。',
  'empty.capture': '最近没有需要安放的事项。',
  'empty.dormant': '没有需要再次浮现的事项。',
  'empty.closed': '已结束事项默认不常亮；显示或搜索时才会出现。',
  'empty.search': '没有匹配的已安放事项。',
  'section.wip': '进行中',
  'section.waiting': '等待',
  'section.capture': '收件箱',
  'section.resurfaced': '再次浮现',
  'section.placed': '已安放',
  'section.repair': '需要处理',
  'count.wip': '{count}/{limit}',
  'count.waiting': '{count}',
  'action.placeOne': '安放一个事项',
  'action.newTask': '新建任务',
  'action.newIdea': '新建 Idea',
  'action.settings': '设置',
  'action.hideCapture': '收起想法',
  'action.findPlaced': '显示已安放',
  'action.hidePlaced': '收起已安放',
  'action.place': '安放',
  'action.placeMore': '更多…',
  'completionNote.savedPending': '记录已写入 Task 原文，完成状态尚未确认。请重试；不会重复追加记录。',
  'completionNote.failed': '保存尚未确认。内容已保留，请重试同一笔记录。',
  'action.completeWithNote': '完成并记一笔',
  'field.completionNote': '一句话补充',
  'field.completionNote.placeholder': '补充这次完成的内容，可粘贴多行文字',
  'action.transfer': '转移他人',
  'action.reopen': '重新考虑',
  'action.relink': '重新关联',
  'action.openSource': '打开原文',
  'badge.proofed': '已有论证',
  'badge.task': '任务',
  'badge.agent': 'Agent 添加',
  'badge.orphan': '原文失联',
  'badge.unsupported': '需要修复',
  'badge.dueNone': '无截止日期',
  'badge.due': '截止 {date}',
  'badge.overdue': '已逾期 {date}',
  'badge.contextMissing': '情境未明确',
  'metadata.label': '优先级、截止日期与情境',
  'metadata.edit.title': '编辑“{title}”的规划元数据',
  'metadata.edit.help': '这些值会直接保存到卡片的来源文件。',
  'metadata.edit.save': '保存元数据',
  'metadata.edit.saveError': '无法保存元数据，当前编辑仍保留。',
  'metadata.edit.refreshWarning': '元数据已保存，但 Next 暂时无法刷新看板。',
  'priority.P0': 'P0 · 紧急',
  'priority.P1': 'P1 · 高',
  'priority.P2': 'P2 · 普通',
  'priority.P3': 'P3 · 低',
  'warning.wip': '已达到 WIP 上限：进行中有 {count} 项（上限 {limit}）。请先完成、转为等待或移到稍后至少一项；在数量降到上限以下前，此警告会一直显示。',
  'warning.waiting': '等待项已超过五个。请确认每一项仍有真实的回收责任。',
  'warning.readOnly': '事件文档修复前，Next 将保持只读。',
  'search.placeholder': '搜索标题、下一步或去向',
  'sort.label': '排序',
  'sort.priority': '优先级优先',
  'sort.due': '截止日期优先',
  'sort.created': '最新添加优先',
  'board.dragHelp': '拖动卡片即可改变状态；需要补充详情时，选择安放菜单中的“更多…”。',
  'create.title': '新建 Idea',
  'create.destination': '保存到 {path}',
  'create.field': 'Idea',
  'create.placeholder': '趁念头还在，把它写下来…',
  'create.save': '创建 Idea',
  'create.saveShortcut': '⌘↵ / Ctrl↵ 保存',
  'task.create.title': '新建任务',
  'task.create.destination': '保存到 {path}',
  'task.create.field': '任务',
  'task.create.placeholder': '现在需要完成什么？',
  'task.create.body': '补充说明',
  'task.create.bodyPlaceholder': '重新开始这项任务时需要的上下文',
  'task.create.doneWhen': '完成条件',
  'task.create.doneWhenPlaceholder': '出现什么可观察结果就算完成？',
  'task.create.saveInbox': '加入收件箱',
  'task.create.saveCurrent': '保存并标记为当前',
  'task.create.saveShortcut': '⌘↵ / Ctrl↵ 加入收件箱',
  'sheet.title': '安放“{title}”',
  'sheet.choose': '接下来怎么办？',
  'route.commit': '现在推进',
  'route.commit.detail': '承担一个具体下一步和关闭条件。',
  'route.wait': '等待回收',
  'route.wait.detail': '外部结果仍需要你检查或验收。',
  'route.park': '以后再看',
  'route.park.detail': '保留记忆，解除当前承诺。',
  'route.settle': '结束或已有去处',
  'route.settle.detail': '完成、停止、转移，或变成稳定机制。',
  'field.commitment': '承诺',
  'field.commitment.placeholder': '这次具体要验证或交付什么？',
  'field.nextAction': '下一步',
  'field.nextAction.placeholder': '重新打开时可以直接执行的动作',
  'field.closeCondition': '关闭条件',
  'field.closeCondition.placeholder': '出现什么结果或证据就可以停止？',
  'field.waitingFor': '等待什么',
  'field.waitingFor.placeholder': '人、结果、证据或购买试用',
  'field.reviewAt': '回收时间',
  'field.wakeTrigger': '唤醒条件',
  'field.wakeTrigger.placeholder': '一个日期或具体情境',
  'field.wakeTrigger.help': '日期到达后会自动浮现；情境只保留供搜索，Next 不会自动识别。',
  'field.exitKind': '结果',
  'field.exitKind.placeholder': '选择结果',
  'field.exitVia': '方式',
  'field.exitVia.placeholder': '选择方式',
  'field.reason': '理由',
  'field.reason.placeholder': '为什么现在停止是合理的？',
  'field.target': '去向',
  'field.target.placeholder': '项目、人员、产品、链接、规则或自动化',
  'field.result': '结果',
  'field.result.placeholder': '可选的结果或证据链接',
  'field.project': '项目',
  'field.priority': '优先级',
  'field.due': '截止日期 · 可选',
  'field.contexts': 'GTD 情境 · 可选',
  'field.contexts.placeholder': '@电脑、@电话（逗号分隔）',
  'settings.title': '下一步设置',
  'settings.description': '这些设置只作用于「下一步」插件，以及今后新建的卡片。',
  'settings.wipLimit': '进行中上限',
  'settings.wipLimit.help': '进行中数量达到此值后，持续显示醒目警告。',
  'settings.defaultPriority': '默认优先级',
  'settings.defaultPriority.help': '为新建 Idea 和任务预填优先级。',
  'settings.defaultDueDays': '默认截止天数',
  'settings.defaultDueDays.help': '从创建当天起计算；填 0 表示新卡片默认没有截止日期。',
  'settings.defaultContext': '默认 GTD 情境',
  'settings.defaultContext.help': '可选，为新卡片预填执行情境，例如 @电脑 或 @电话。',
  'settings.validation': '请输入整数：进行中上限至少为 1，默认截止天数不能小于 0。',
  'settings.save': '保存设置',
  'settings.saving': '正在保存…',
  'settings.saveError': '无法保存这些设置；你的修改仍保留在页面中。',
  'field.project.placeholder': '选择已有项目，或输入项目名称',
  'field.project.selected': '已选项目',
  'field.project.existing': '已有项目',
  'field.project.add': '添加',
  'field.project.help': '可多选；也可以创建一个新的项目 Tag。',
  'field.project.target': '升级到哪个项目？',
  'field.project.target.placeholder': '选择一个项目',
  'project.suggestion': '建议 · {project}',
  'project.suggestion.detail': '本地匹配：{terms}。点击确认后再安放。',
  'field.article': '完整文章',
  'field.article.placeholder': '文章路径或公开链接',
  'preset.commit.verify': '验证“{title}”是否值得继续',
  'preset.commit.prototype': '为“{title}”做一个可用原型',
  'preset.commit.plan': '把“{title}”写成可评审方案',
  'preset.commit.deliver': '交付“{title}”的最小可用结果',
  'preset.next.evidence': '收集三个关键证据',
  'preset.next.experiment': '做一个最小实验',
  'preset.next.draft': '写出第一版',
  'preset.next.user': '找一位真实使用者确认',
  'preset.close.decision': '得到明确继续或停止结论',
  'preset.close.prototype': '完成一个可用原型',
  'preset.close.used': '有人实际使用并给出反馈',
  'preset.close.metric': '达到预设验证指标',
  'preset.wait.person': '关于“{title}”的他人回复',
  'preset.wait.agent': '关于“{title}”的 Agent 结果',
  'preset.wait.review': '关于“{title}”的评审或验收反馈',
  'preset.wait.evidence': '关于“{title}”的关键证据',
  'preset.date.tomorrow': '明天',
  'preset.date.days3': '3 天后',
  'preset.date.week1': '1 周后',
  'preset.date.weeks2': '2 周后',
  'preset.date.month1': '1 个月后',
  'preset.wake.week': '下周',
  'preset.wake.month': '下个月',
  'preset.wake.related': '相关项目启动时',
  'preset.wake.repeat': '再次遇到同类问题时',
  'preset.wake.evidence': '获得关键证据时',
  'preset.reason.value': '价值不足',
  'preset.reason.timing': '时机不对',
  'preset.reason.disproved': '核心假设已被否定',
  'preset.reason.better': '已有更好的方案',
  'preset.result.accepted': '已完成并验收',
  'preset.result.source': '原文即结果',
  'preset.result.delivered': '已交付',
  'preset.result.recorded': '已有证据记录',
  'exit.done': '完成',
  'exit.stopped': '停止',
  'exit.transferred': '转到别处',
  'exit.compressed': '变成机制',
  'via.none': '直接完成',
  'via.delegateDone': '委托并已验收',
  'via.article': '整理并发布为完整文章',
  'via.delegateTransferred': '责任已移交',
  'via.drop': '放弃',
  'via.disproved': '证伪',
  'via.ignore': '忽略',
  'via.merge': '合并',
  'via.project': '升级为项目',
  'via.buy': '购买已有方案',
  'via.publish': '公开素材供他人接力',
  'via.principle': '沉淀为原则',
  'via.automate': '自动化',
  'relink.title': '重新关联原文',
  'relink.helpExact': '这些文件的创建时间相同，请确认正确原文。Next 不会重命名或修改它。',
  'relink.helpManual': '没有找到相同创建时间。这些只是尚未被认领的 idea，请自行核对路径与时间。',
  'relink.created': '创建时间',
  'relink.createdUnknown': '未知',
  'relink.noCandidates': '没有找到尚未被认领的 idea 文件。',
  'error.required': '请补全必填内容。',
  'error.ideaRequired': '请先写下 Idea。',
  'error.taskRequired': '请先写下任务。',
  'error.doneWhenRequired': '标记为当前之前，请填写完成条件。',
  'error.createTask': 'Next 无法创建这个任务。',
  'error.createRefresh': '任务已保存，但 Next 暂时无法刷新收件箱。',
  'error.createRefreshCurrent': '任务已保存，但收件箱刷新失败，尚未标记为当前。',
  'error.createCurrent': '任务已保存在收件箱，但无法标记为当前。',
  'error.create': 'Next 无法创建这个 Idea。',
  'error.load': 'Next 无法载入你的事项。',
  'error.save': 'Next 无法保存这次安放。',
  'error.open': '无法打开原文。',
  'status.capture': '收件箱',
  'status.wip': '进行中',
  'status.waiting': '等待',
  'status.dormant': '稍后',
  'outcome.done': '已完成',
  'outcome.stopped': '已停止',
  'outcome.transferred': '已转移',
  'outcome.compressed': '已压缩',
  'reminder.open': '管理提醒',
  'reminder.title': '“{title}”的提醒',
  'reminder.status.automatic': '自动提醒',
  'reminder.status.paused': '暂停至 {time}',
  'reminder.status.muted': '提醒已关闭',
  'reminder.status.legacy': '独立关闭记录生效',
  'reminder.status.error': '提醒状态无法读取',
  'reminder.status.closed': '不再提醒',
  'reminder.saved': '提醒设置已保存',
  'reminder.saveError': '无法保存提醒设置，当前编辑仍保留',
  'reminder.refreshWarning': '提醒设置已保存，暂时无法刷新状态',
  'reminder.loading': '读取提醒状态…',
  'reminder.pauseHour': '暂停 1 小时',
  'reminder.pauseTomorrow': '暂停至明早 9 点',
  'reminder.resume': '恢复自动提醒',
  'reminder.mute': '关闭提醒',
  'reminder.more': '更多…',
  'reminder.policy': '提醒方式',
  'reminder.pauseUntil': '暂停至（可选）',
  'reminder.timeZone': '本机时区：{zone}',
  'reminder.due': '截止日期',
  'reminder.noDue': '未设置截止日期',
  'reminder.state': '当前提醒状态',
  'reminder.help': '关闭提醒不会完成任务。',
  'reminder.resumeHelp': '恢复后按现有提醒规则筛选，不会立即推送。',
  'reminder.syncHelp': '设置在下次推送同步时生效，当前屏幕可能仍显示此前的消息。',
  'reminder.legacyHelp': '独立关闭记录仍生效，不能在此恢复自动提醒。',
  'reminder.errorHelp': '现有提醒记录无法读取，不会覆盖原记录。',
  'reminder.unsupportedHelp': '请先修复该任务，再更改提醒。',
  'reminder.closedHelp': '该任务已结束，不再提醒。重新打开任务后才可更改提醒。',
  'reminder.save': '保存提醒设置',
  'reminder.validation.invalid': '请输入有效的本地日期和时间。',
  'reminder.validation.past': '暂停结束时间必须晚于现在。',
  'reminder.validation.ambiguous': '该本地时间因时钟调整出现两次，请选择其他时间。',
  'reminder.validation.nonexistent': '该本地时间因时钟调整不存在，请选择其他时间。',
  'status.closed': '已结束',
  'status.unsupported': '无法识别',
}

const ja: Catalog = {
  "kickoff.bodyPreserved": "本文は手動で編集されているため、再描画していません。",
  "kickoff.sourceFallback": "手順を解析できませんでした。タスクファイルのみ読み取ります。",
  "kickoff.source.taskOnly": "タスクファイル",
  "kickoff.failedNotice": "開始に失敗しました",
  "kickoff.source.task": "タスクファイルと参照先",
  "kickoff.source.marks": "注釈ノート（あなたの判断）",
  "kickoff.source.done-tasks": "同じプロジェクトの完了タスクと完了ノート",
  "kickoff.source.diary": "日記と決定の記録",
  "kickoff.failure.ineligible": "このタスクは対象のレーンにありません",
  "kickoff.failure.already-running": "このタスクはすでに実行中です",
  "kickoff.failure.capacity": "エージェントの同時実行上限に達しました",
  "kickoff.failure.io-error": "開始用ファイルを読み取りまたは保存できませんでした",
  "kickoff.failure.conflict": "競合する結果が見つかりました",
  "kickoff.picker.by": "{name} で実行",
  "kickoff.picker.title": "エージェントを選ぶ",
  "kickoff.picker.unknown": "状態不明",
  "kickoff.picker.broken": "エージェントを利用できません",
  "kickoff.picker.notInstalled": "未インストール",
  "kickoff.picker.model": "モデル {model}",
  "kickoff.picker.empty": "エージェント未インストール",
  "kickoff.action": "最初の一歩を手伝う",
  "kickoff.accessible": "最初の一歩を手伝う：{title}",
  "kickoff.starting": "起動中…",
  "kickoff.view": "結果を見る",
  "kickoff.stale": "古い結果",
  "kickoff.failed": "開始に失敗 · 再試行",
  "kickoff.steps": "ステップ {steps} · {last}",
  "kickoff.duration": "所要時間 {time}",
  "kickoff.choose": "別のエージェントを選ぶ",
  "kickoff.progress": "開始内容を作成中",
  "kickoff.continues": "ウィンドウを閉じても実行は継続します。",
  "kickoff.limit": "実行は最大10分です。途中停止はまだできません。",
  "kickoff.retry": "再試行",
  "kickoff.oldResult": "以前の結果を見る",
  "kickoff.raw": "元の出力（先頭2 KiB）",
  "kickoff.market": "プラグインマーケットでエージェントをインストールまたは有効にしてください。",
  "kickoff.consentTitle": "開始用の手順を追加しますか？",
  "kickoff.consentBody": "このVaultに skills/task-kickoff/SKILL.md と .notemd/agent-tasks/next-task-kickoff/ を追加します。エージェントはこのVaultの読み取りのみ可能で、ファイルを書き込めません。",
  "kickoff.consentStart": "追加して開始",
  "kickoff.dataSources": "読み取り対象（このVault内、読み取り専用）",
  "kickoff.sourceDisabled": "無効",
  "kickoff.unverifiedProvider": "読み取り専用の開始に対応する Agent プラグインへ更新してください",
  "kickoff.result": "最初の一歩",
  "kickoff.generated": "生成日時 {time}",
  "kickoff.staleBanner": "この結果はタスクの以前のバージョンに基づいています。",
  "kickoff.regenerate": "再生成",
  "kickoff.summary": "要約",
  "kickoff.questions": "回答してください",
  "kickoff.decides": "決めること：{field}",
  "kickoff.recommended": "おすすめ",
  "kickoff.other": "その他",
  "kickoff.context": "既知の背景",
  "kickoff.inference": "推測",
  "kickoff.unverified": "出典なし",
  "kickoff.suggestions": "提案",
  "kickoff.blockers": "障害になりそうな点",
  "kickoff.waiting": "待っている相手",
  "kickoff.gaps": "見つからなかったこと",
  "kickoff.place": "この回答で「今進める」に配置",
  "kickoff.save": "回答のみ保存",
  "kickoff.saved": "回答を保存しました",
  "kickoff.saveError": "回答を保存できませんでした。入力は保持されています。",
  "kickoff.readyNotice": "結果ができました",
  "kickoff.source": "出典を開く：{title}",
  "kickoff.field.commitment": "取り組むこと",
  "kickoff.field.next_action": "次の行動",
  "kickoff.field.close_condition": "完了条件",
  "kickoff.field.owner": "担当者",
  "kickoff.field.scope": "範囲",
  "kickoff.field.other": "その他",
  "kickoff.failure.agent-missing": "利用できるエージェントプラグインがありません",
  "kickoff.failure.start-error": "エージェントを起動できませんでした",
  "kickoff.failure.timeout": "10分以内に完了しませんでした",
  "kickoff.failure.error": "エージェントでエラーが発生しました",
  "kickoff.failure.cancelled": "実行がキャンセルされました",
  "kickoff.failure.skipped": "エージェントが実行をスキップしました",
  "kickoff.failure.lost": "結果を残さず実行が中断しました",
  "kickoff.failure.missing-result": "エージェントは完了しましたが、結果が大きすぎるか保存されませんでした",
  "kickoff.failure.invalid-output": "エージェントの出力が指定形式と一致しません",
  "kickoff.failure.task-changed": "実行中にタスクが削除されたか識別情報が変わりました",
  "kickoff.failure.provider-unavailable": "このエージェントはまだ利用できません",
  "kickoff.failure.consent-required": "最初に手順の追加を確認してください",
  "kickoff.failure.result-changed": "結果が変更されました。再度開いてから回答を保存してください。",
  "kickoff.failure.unsupported": "このホストは開始機能をサポートしていません",
  "kickoff.failure.busy": "このタスクはすでに実行中です",
  "kickoff.failure.save-error": "結果を保存できませんでした",
  "hook.environment.title": "スクリプトの環境変数",
  "hook.environment.help": "1 行に KEY=value を入力してください。DESK_DISPLAY_URL と DESK_DISPLAY_TOKEN のみ対応しています。保存すると保存済みの変数をすべて置き換えます。",
  "hook.environment.configured": "保存済みの変数：{keys}",
  "hook.environment.none": "環境変数の上書きは未設定です",
  "hook.environment.save": "環境変数を保存",
  "hook.environment.clear": "保存済みの変数を削除",
  "hook.environment.local": "この端末の現在の Vault に即時保存します。NEXT からの実行時のみこの値が優先され、既存の env ファイルは変更しません。定期ジョブには適用されません。保存・削除してもスクリプトは実行されず、保存済みの値は再表示されません。",
  "hook.environment.saved": "環境変数はこの端末にのみ保存されました。接続はまだテストしていません。入力欄をクリアしました。",
  "hook.environment.cleared": "環境変数の上書きを削除しました。元の設定を使用します。",
  "hook.environment.error": "環境変数を保存できませんでした。KEY=value の形式と対応する変数名を確認して再試行してください。",
  "hook.environment.unavailable": "ここで環境変数を設定するには note.md を更新してください。",
  "hook.settings.title": "Cube 同期スクリプト",
  "hook.settings.help": "タスクの状態、通知設定、期限の保存後、この Vault の skills フォルダーにある Python スクリプトを直接実行します。AI モデルやトークンは使用しません。",
  "hook.settings.none": "スクリプト未選択",
  "hook.settings.select": "Python スクリプトを選択…",
  "hook.settings.clear": "無効にする",
  "hook.settings.local": "選択はこの端末と Vault に即時反映されます。Python 3 と依存ライブラリが必要です。Cube 認証情報は端末に保存します。",
  "hook.settings.unavailable": "このホストはスクリプト実行に対応していません。対応する note.md に更新してください。",
  "hook.settings.error": "スクリプト設定を変更できませんでした。",
  "hook.status.running": "「{title}」を保存済み · Cube と同期中…",
  "hook.status.synced": "「{title}」を保存済み · スクリプトの実行が完了しました。変更件数は未報告です。",
  "hook.status.noChanges": "「{title}」を保存済み · スクリプトの報告：確認が完了し、今回は変更不要です。",
  "hook.status.changes": "「{title}」を保存済み · スクリプトの報告：追加 {created} 件、更新 {updated} 件、取り下げ {deleted} 件。端末での表示を確認したものではありません。",
  "hook.status.pending": "「{title}」を保存済み · Cube 同期待ち。スクリプト、Python の依存関係、接続を確認してください。",
  "hook.status.pendingReason": "「{title}」を保存済み · Cube 同期待ち。{reason}",
  "hook.error.missingConfig": "Cube 設定がありません。NEXT の設定または ~/.config/desk-display/env に DESK_DISPLAY_URL と DESK_DISPLAY_TOKEN を設定してください。",
  "hook.error.connection": "Cube に接続できません。サーバーアドレスとネットワークを確認してください。",
  "hook.error.busy": "別の同期が実行中です。しばらくしてから再試行してください。",
  "hook.error.serverVersion": "Cube サーバーは安全な作成に未対応です。Cube サービスを更新してください。",
  "hook.retry": "同期を再試行",
  "hook.dismiss": "同期表示を閉じる",
  'app.title': '次の一歩',
  'app.value': 'アイデアとタスクに、明確な次の一歩か安心できる置き場所を。',
  'filter.items': '種類とプロジェクトの絞り込み',
  'common.loading': '読み込み中…',
  'common.refresh': '更新',
  'common.open': '開く',
  'common.close': '閉じる',
  'common.cancel': 'キャンセル',
  'common.save': '配置を確定',
  'common.optional': '任意',
  'common.error': '問題が発生しました',
  'empty.wip': '現在引き受けている項目はありません。',
  'empty.waiting': '確認待ちの項目はありません。',
  'empty.capture': '最近、判断が必要な項目はありません。',
  'empty.dormant': '再表示が必要な項目はありません。',
  'empty.closed': '終了した項目は、表示または検索するまで隠れます。',
  'empty.search': '一致する配置済み項目はありません。',
  'section.wip': '進行中',
  'section.waiting': '待機中',
  'section.capture': '受信箱',
  'section.resurfaced': '再び表示',
  'section.placed': '配置済み',
  'section.repair': '確認が必要',
  'count.wip': '{count}/{limit}',
  'count.waiting': '{count}',
  'action.placeOne': '項目を置く',
  'action.newTask': '新規タスク',
  'action.newIdea': '新規 Idea',
  'action.settings': '設定',
  'action.hideCapture': '項目を隠す',
  'action.findPlaced': '配置済みを表示',
  'action.hidePlaced': '配置済みを隠す',
  'action.place': '置く',
  'action.placeMore': '詳細…',
  'completionNote.savedPending': 'メモは Task の元ファイルに保存されましたが、完了状態はまだ確認できていません。再試行してもメモは重複しません。',
  'completionNote.failed': '保存はまだ確認できていません。内容は保持されています。同じメモで再試行してください。',
  'action.completeWithNote': '完了してメモを残す',
  'field.completionNote': 'ひとことメモ',
  'field.completionNote.placeholder': '完了した内容を入力してください。複数行の貼り付けもできます。',
  'action.transfer': '他の人に引き継ぐ',
  'action.reopen': '再検討',
  'action.relink': '再リンク',
  'action.openSource': '原文を開く',
  'badge.proofed': '検証済み',
  'badge.task': 'タスク',
  'badge.agent': 'Agent が追加',
  'badge.orphan': '原文が見つかりません',
  'badge.unsupported': '修復が必要',
  'badge.dueNone': '期限なし',
  'badge.due': '期限 {date}',
  'badge.overdue': '期限超過 {date}',
  'badge.contextMissing': 'コンテキスト未整理',
  'metadata.label': '優先度、期限、コンテキスト',
  'metadata.edit.title': '「{title}」の計画メタデータを編集',
  'metadata.edit.help': 'これらの値はカードのソースファイルに直接保存されます。',
  'metadata.edit.save': 'メタデータを保存',
  'metadata.edit.saveError': 'メタデータを保存できませんでした。編集中の内容は保持されています。',
  'metadata.edit.refreshWarning': 'メタデータは保存されましたが、Next はまだボードを更新できません。',
  'priority.P0': 'P0 · 緊急',
  'priority.P1': 'P1 · 高',
  'priority.P2': 'P2 · 通常',
  'priority.P3': 'P3 · 低',
  'warning.wip': 'WIP 上限に達しました：{count} 件が進行中です（上限 {limit}）。少なくとも一件を完了、待機、または後回しにしてください。進行中の件数が上限未満になるまで、この警告は表示され続けます。',
  'warning.waiting': '確認待ちが五つを超えています。すべてに確認責任が残っているか確かめてください。',
  'warning.readOnly': 'イベント文書を修復するまで Next は読み取り専用です。',
  'search.placeholder': 'タイトル、次の行動、移動先を検索',
  'sort.label': '並べ替え',
  'sort.priority': '優先度を優先',
  'sort.due': '期限を優先',
  'sort.created': '追加の新しい順',
  'board.dragHelp': 'カードをドラッグすると状態が変わります。詳細は「置く」メニューの「詳細…」から入力できます。',
  'create.title': '新規 Idea',
  'create.destination': '{path} に保存',
  'create.field': 'Idea',
  'create.placeholder': '消える前に思いつきを書き留める…',
  'create.save': 'Idea を作成',
  'create.saveShortcut': '⌘↵ / Ctrl↵ で保存',
  'task.create.title': '新規タスク',
  'task.create.destination': '{path} に保存',
  'task.create.field': 'タスク',
  'task.create.placeholder': '何を完了する必要がありますか？',
  'task.create.body': '補足',
  'task.create.bodyPlaceholder': 'このタスクを再開するために必要な情報',
  'task.create.doneWhen': '完了条件',
  'task.create.doneWhenPlaceholder': 'どんな確認可能な結果で完了としますか？',
  'task.create.saveInbox': '受信箱に追加',
  'task.create.saveCurrent': '保存して進行中にする',
  'task.create.saveShortcut': '⌘↵ / Ctrl↵ で受信箱に追加',
  'sheet.title': '「{title}」の置き場所',
  'sheet.choose': '次はどうしますか？',
  'route.commit': '今進める',
  'route.commit.detail': '具体的な次の行動と終了条件を引き受けます。',
  'route.wait': '確認を待つ',
  'route.wait.detail': '外部の結果をまだ確認する必要があります。',
  'route.park': 'あとで見る',
  'route.park.detail': '記憶を残し、今の約束から外します。',
  'route.settle': '終える、または移す',
  'route.settle.detail': '完了、中止、移管、仕組み化を選びます。',
  'field.commitment': '約束',
  'field.commitment.placeholder': '何を検証、または届けますか？',
  'field.nextAction': '次の行動',
  'field.nextAction.placeholder': '考え直さず始められる具体的な一歩',
  'field.closeCondition': '終了条件',
  'field.closeCondition.placeholder': 'どんな結果や証拠があれば止められますか？',
  'field.waitingFor': '待っているもの',
  'field.waitingFor.placeholder': '人、結果、証拠、購入した製品の試用',
  'field.reviewAt': '確認日',
  'field.wakeTrigger': '再開条件',
  'field.wakeTrigger.placeholder': '日付、または具体的な状況',
  'field.wakeTrigger.help': '日付は自動で再表示されます。状況は検索用に残りますが、Next は自動検出しません。',
  'field.exitKind': '結果',
  'field.exitKind.placeholder': '結果を選択',
  'field.exitVia': '方法',
  'field.exitVia.placeholder': '方法を選択',
  'field.reason': '理由',
  'field.reason.placeholder': '今やめるのが適切なのはなぜですか？',
  'field.target': '移動先',
  'field.target.placeholder': 'プロジェクト、人、製品、リンク、原則、自動化',
  'field.result': '成果',
  'field.result.placeholder': '任意の成果または証拠へのリンク',
  'field.project': 'プロジェクト',
  'field.priority': '優先度',
  'field.due': '期限 · 任意',
  'field.contexts': 'GTD コンテキスト · 任意',
  'field.contexts.placeholder': '@computer, @phone（カンマ区切り）',
  'settings.title': '次の一歩の設定',
  'settings.description': 'これらの設定は「次の一歩」と、今後作成するカードだけに適用されます。',
  'settings.wipLimit': '進行中の上限',
  'settings.wipLimit.help': '進行中がこの件数に達すると、目立つ警告を常に表示します。',
  'settings.defaultPriority': '既定の優先度',
  'settings.defaultPriority.help': '新しいアイデアとタスクの優先度を事前入力します。',
  'settings.defaultDueDays': '既定の期限日数',
  'settings.defaultDueDays.help': '作成日からの日数です。0 にすると期限を設定しません。',
  'settings.defaultContext': '既定の GTD コンテキスト',
  'settings.defaultContext.help': '任意。@パソコンや @電話など、新しいカードに事前入力します。',
  'settings.validation': '整数を入力してください。進行中の上限は 1 以上、期限日数は 0 以上です。',
  'settings.save': '設定を保存',
  'settings.saving': '保存中…',
  'settings.saveError': '設定を保存できませんでした。編集内容はこのページに残っています。',
  'field.project.placeholder': '既存のプロジェクトを選択するか入力',
  'field.project.selected': '選択済みのプロジェクト',
  'field.project.existing': '既存のプロジェクト',
  'field.project.add': '追加',
  'field.project.help': '複数選択、または新しいプロジェクトタグを作成できます。',
  'field.project.target': 'どのプロジェクトに昇格しますか？',
  'field.project.target.placeholder': 'プロジェクトを選択',
  'project.suggestion': '候補 · {project}',
  'project.suggestion.detail': 'ローカル一致：{terms}。クリックして確認後に配置します。',
  'field.article': '公開済み記事',
  'field.article.placeholder': '記事のパスまたは公開 URL',
  'preset.commit.verify': '「{title}」を続ける価値があるか検証する',
  'preset.commit.prototype': '「{title}」の使える試作を作る',
  'preset.commit.plan': '「{title}」をレビュー可能な案にする',
  'preset.commit.deliver': '「{title}」の最小限の成果を届ける',
  'preset.next.evidence': '重要な証拠を三つ集める',
  'preset.next.experiment': '最小限の実験を一つ行う',
  'preset.next.draft': '初版を書く',
  'preset.next.user': '実際の利用者一人に確認する',
  'preset.close.decision': '続行か中止かを明確に決める',
  'preset.close.prototype': '使える試作を完成する',
  'preset.close.used': '一人が実際に使い、感想を返す',
  'preset.close.metric': '決めた検証指標を満たす',
  'preset.wait.person': '「{title}」についての相手からの返事',
  'preset.wait.agent': '「{title}」についての Agent の結果',
  'preset.wait.review': '「{title}」についてのレビューまたは検収結果',
  'preset.wait.evidence': '「{title}」についての重要な証拠',
  'preset.date.tomorrow': '明日',
  'preset.date.days3': '3日後',
  'preset.date.week1': '1週間後',
  'preset.date.weeks2': '2週間後',
  'preset.date.month1': '1か月後',
  'preset.wake.week': '来週',
  'preset.wake.month': '来月',
  'preset.wake.related': '関連プロジェクトが始まった時',
  'preset.wake.repeat': '同じ問題が再び起きた時',
  'preset.wake.evidence': '重要な証拠が得られた時',
  'preset.reason.value': '価値が十分ではない',
  'preset.reason.timing': '今は時期が違う',
  'preset.reason.disproved': '中心となる仮説が否定された',
  'preset.reason.better': 'より良い解決策がすでにある',
  'preset.result.accepted': '完了して検収済み',
  'preset.result.source': '原文が成果',
  'preset.result.delivered': '納品済み',
  'preset.result.recorded': '証拠を記録済み',
  'exit.done': '完了',
  'exit.stopped': '中止',
  'exit.transferred': '別の場所へ移動',
  'exit.compressed': '仕組みに変換',
  'via.none': '直接完了',
  'via.delegateDone': '委託して検収済み',
  'via.article': '完全な記事にまとめて公開',
  'via.delegateTransferred': '責任を移管',
  'via.drop': '取り下げ',
  'via.disproved': '反証',
  'via.ignore': '無視',
  'via.merge': '統合',
  'via.project': 'プロジェクトへ移動',
  'via.buy': '既存製品を購入',
  'via.publish': '引き継ぎ用の素材を公開',
  'via.principle': '原則に変換',
  'via.automate': '自動化',
  'relink.title': '原文を再リンク',
  'relink.helpExact': '作成時刻が同じファイルです。正しい原文か確認してください。Next は名前も内容も変更しません。',
  'relink.helpManual': '同じ作成時刻の候補がありません。未使用の idea ファイルなので、パスと時刻を自分で確認してください。',
  'relink.created': '作成時刻',
  'relink.createdUnknown': '不明',
  'relink.noCandidates': '未使用の idea ファイルがありません。',
  'error.required': '必須項目を入力してください。',
  'error.ideaRequired': '保存する前に Idea を入力してください。',
  'error.taskRequired': '保存する前にタスクを入力してください。',
  'error.doneWhenRequired': '進行中にする前に完了条件を入力してください。',
  'error.createTask': 'Next はこのタスクを作成できませんでした。',
  'error.createRefresh': 'タスクは保存されましたが、Next は受信箱を更新できませんでした。',
  'error.createRefreshCurrent': 'タスクは保存されましたが、受信箱の更新に失敗したため進行中にはなっていません。',
  'error.createCurrent': 'タスクは受信箱に保存されましたが、進行中にできませんでした。',
  'error.create': 'Next はこの Idea を作成できませんでした。',
  'error.load': 'Next は項目を読み込めませんでした。',
  'error.save': 'Next はこの判断を保存できませんでした。',
  'error.open': '原文を開けませんでした。',
  'status.capture': '受信箱',
  'status.wip': '進行中',
  'status.waiting': '待機中',
  'status.dormant': 'いつか',
  'outcome.done': '完了',
  'outcome.stopped': '中止',
  'outcome.transferred': '引き継ぎ済み',
  'outcome.compressed': '要点に集約済み',
  'reminder.open': 'リマインダーを管理',
  'reminder.title': '「{title}」のリマインダー',
  'reminder.status.automatic': '自動リマインダー',
  'reminder.status.paused': '{time} まで一時停止',
  'reminder.status.muted': 'リマインダーはオフ',
  'reminder.status.legacy': '別の停止記録が有効',
  'reminder.status.error': 'リマインダーの状態を取得できません',
  'reminder.status.closed': '今後のリマインダーなし',
  'reminder.saved': 'リマインダー設定を保存しました',
  'reminder.saveError': 'リマインダー設定を保存できません。編集内容は保持されています。',
  'reminder.refreshWarning': '設定を保存しましたが、状態を更新できませんでした。',
  'reminder.loading': 'リマインダーの状態を読み込み中…',
  'reminder.pauseHour': '1 時間一時停止',
  'reminder.pauseTomorrow': '明日 9 時まで一時停止',
  'reminder.resume': '自動リマインダーを再開',
  'reminder.mute': 'リマインダーをオフ',
  'reminder.more': '詳細…',
  'reminder.policy': 'リマインダー',
  'reminder.pauseUntil': '一時停止の終了日時（任意）',
  'reminder.timeZone': 'この端末のタイムゾーン：{zone}',
  'reminder.due': '期限',
  'reminder.noDue': '期限未設定',
  'reminder.state': '現在のリマインダー状態',
  'reminder.help': 'リマインダーをオフにしてもタスクは完了しません。',
  'reminder.resumeHelp': '再開後も既存の通知ルールが適用され、すぐには送信されません。',
  'reminder.syncHelp': '変更は次回の通知同期で反映されます。画面には以前のメッセージが残っている場合があります。',
  'reminder.legacyHelp': '別の停止記録が有効なため、ここでは自動リマインダーを再開できません。',
  'reminder.errorHelp': '既存のリマインダー記録を読み込めないため、上書きしません。',
  'reminder.unsupportedHelp': 'リマインダーを変更する前にタスクを修復してください。',
  'reminder.closedHelp': 'このタスクは終了しているため通知されません。変更するにはタスクを再開してください。',
  'reminder.save': 'リマインダー設定を保存',
  'reminder.validation.invalid': '有効な現地日時を入力してください。',
  'reminder.validation.past': '一時停止の終了日時は現在より後にしてください。',
  'reminder.validation.ambiguous': '時計の変更により、この現地時刻は 2 回存在します。別の時刻を選んでください。',
  'reminder.validation.nonexistent': '時計の変更により、この現地時刻は存在しません。別の時刻を選んでください。',
  'status.closed': '終了',
  'status.unsupported': '未対応',
}

const de: Catalog = {
  "kickoff.bodyPreserved": "Der Text wurde manuell bearbeitet und nicht erneut erzeugt.",
  "kickoff.sourceFallback": "Das Verfahren konnte nicht gelesen werden. Nur die Aufgabendatei wird gelesen.",
  "kickoff.source.taskOnly": "Aufgabendatei",
  "kickoff.failedNotice": "Einstieg fehlgeschlagen",
  "kickoff.source.task": "Aufgabendatei und ihre Quellen",
  "kickoff.source.marks": "Anmerkungen (Ihre Einschätzungen)",
  "kickoff.source.done-tasks": "Abgeschlossene Aufgaben und Abschlussnotizen desselben Projekts",
  "kickoff.source.diary": "Tagebuch und Entscheidungsprotokolle",
  "kickoff.failure.ineligible": "Diese Aufgabe befindet sich nicht mehr in einer zulässigen Spalte",
  "kickoff.failure.already-running": "Für diese Aufgabe läuft bereits ein Einstieg",
  "kickoff.failure.capacity": "Dieser Agent hat sein Ausführungslimit erreicht",
  "kickoff.failure.io-error": "Einstiegsdateien konnten nicht gelesen oder gespeichert werden",
  "kickoff.failure.conflict": "Widersprüchliche Einstiegsergebnisse gefunden",
  "kickoff.picker.by": "mit {name}",
  "kickoff.picker.title": "Agent wählen",
  "kickoff.picker.unknown": "Status nicht verfügbar",
  "kickoff.picker.broken": "Agent nicht verfügbar",
  "kickoff.picker.notInstalled": "Nicht installiert",
  "kickoff.picker.model": "Modell {model}",
  "kickoff.picker.empty": "Keine Agents installiert",
  "kickoff.action": "Beim Einstieg helfen",
  "kickoff.accessible": "Beim Einstieg helfen: {title}",
  "kickoff.starting": "Wird gestartet…",
  "kickoff.view": "Einstieg ansehen",
  "kickoff.stale": "Veraltet",
  "kickoff.failed": "Einstieg fehlgeschlagen · Erneut versuchen",
  "kickoff.steps": "Schritt {steps} · {last}",
  "kickoff.duration": "Dauer {time}",
  "kickoff.choose": "Anderen Agent wählen",
  "kickoff.progress": "Einstieg wird vorbereitet",
  "kickoff.continues": "Das Schließen dieses Fensters beendet den Lauf nicht.",
  "kickoff.limit": "Läufe dauern höchstens 10 Minuten. Ein Abbruch wird noch nicht unterstützt.",
  "kickoff.retry": "Erneut versuchen",
  "kickoff.oldResult": "Vorherigen Einstieg ansehen",
  "kickoff.raw": "Rohausgabe (erste 2 KiB)",
  "kickoff.market": "Installieren oder aktivieren Sie ein Agent-Plugin im Plugin-Marktplatz.",
  "kickoff.consentTitle": "Einstiegsverfahren hinzufügen?",
  "kickoff.consentBody": "Fügt skills/task-kickoff/SKILL.md und .notemd/agent-tasks/next-task-kickoff/ zu diesem Vault hinzu. Der Agent darf diesen Vault nur lesen und keine Dateien schreiben.",
  "kickoff.consentStart": "Hinzufügen und starten",
  "kickoff.dataSources": "Liest (nur dieser Vault, schreibgeschützt)",
  "kickoff.sourceDisabled": "Nicht aktiviert",
  "kickoff.unverifiedProvider": "Agent-Plugin für schreibgeschützten Start aktualisieren",
  "kickoff.result": "Einstieg",
  "kickoff.generated": "Erstellt {time}",
  "kickoff.staleBanner": "Dieser Einstieg basiert auf einer älteren Version der Aufgabe.",
  "kickoff.regenerate": "Neu erstellen",
  "kickoff.summary": "Zusammenfassung",
  "kickoff.questions": "Ihre Antworten",
  "kickoff.decides": "Bestimmt: {field}",
  "kickoff.recommended": "Empfohlen",
  "kickoff.other": "Andere Antwort",
  "kickoff.context": "Bekannter Kontext",
  "kickoff.inference": "Schlussfolgerung",
  "kickoff.unverified": "Quelle fehlt",
  "kickoff.suggestions": "Vorschläge",
  "kickoff.blockers": "Mögliche Hindernisse",
  "kickoff.waiting": "Warten auf",
  "kickoff.gaps": "Nicht gefunden",
  "kickoff.place": "Mit diesen Antworten in Jetzt einordnen",
  "kickoff.save": "Nur Antworten speichern",
  "kickoff.saved": "Antworten gespeichert",
  "kickoff.saveError": "Antworten konnten nicht gespeichert werden. Ihre Eingaben bleiben erhalten.",
  "kickoff.readyNotice": "Einstieg ist bereit",
  "kickoff.source": "Quelle öffnen: {title}",
  "kickoff.field.commitment": "Vorhaben",
  "kickoff.field.next_action": "Nächster Schritt",
  "kickoff.field.close_condition": "Abschlussbedingung",
  "kickoff.field.owner": "Verantwortlich",
  "kickoff.field.scope": "Umfang",
  "kickoff.field.other": "Sonstiges",
  "kickoff.failure.agent-missing": "Kein Agent-Plugin verfügbar",
  "kickoff.failure.start-error": "Agent konnte nicht gestartet werden",
  "kickoff.failure.timeout": "Der Lauf wurde nach 10 Minuten nicht abgeschlossen",
  "kickoff.failure.error": "Der Agent hat einen Fehler gemeldet",
  "kickoff.failure.cancelled": "Der Lauf wurde abgebrochen",
  "kickoff.failure.skipped": "Der Agent hat den Lauf übersprungen",
  "kickoff.failure.lost": "Der Lauf wurde ohne Ergebnis unterbrochen",
  "kickoff.failure.missing-result": "Der Agent ist fertig, aber das Ergebnis war zu groß oder wurde nicht gespeichert",
  "kickoff.failure.invalid-output": "Die Agent-Ausgabe entspricht nicht dem erwarteten Format",
  "kickoff.failure.task-changed": "Die Aufgabe wurde während des Laufs gelöscht oder ihre Identität wurde geändert",
  "kickoff.failure.provider-unavailable": "Dieser Agent ist für Einstiege noch nicht verfügbar",
  "kickoff.failure.consent-required": "Bestätigen Sie zuerst das Hinzufügen des Verfahrens",
  "kickoff.failure.result-changed": "Das Ergebnis wurde geändert. Öffnen Sie es vor dem Speichern erneut.",
  "kickoff.failure.unsupported": "Dieser Host unterstützt Einstiege nicht",
  "kickoff.failure.busy": "Für diese Aufgabe läuft bereits ein Einstieg",
  "kickoff.failure.save-error": "Das Ergebnis konnte nicht gespeichert werden",
  "hook.environment.title": "Umgebungsvariablen für das Skript",
  "hook.environment.help": "Eine Zeile pro KEY=value. Unterstützt werden nur DESK_DISPLAY_URL und DESK_DISPLAY_TOKEN. Speichern ersetzt alle gespeicherten Variablen.",
  "hook.environment.configured": "Gespeicherte Variablen: {keys}",
  "hook.environment.none": "Keine Umgebungsvariablen gespeichert",
  "hook.environment.save": "Umgebungsvariablen speichern",
  "hook.environment.clear": "Gespeicherte Variablen löschen",
  "hook.environment.local": "Gilt sofort auf diesem Gerät für diesen Vault. Nur bei Skriptaufrufen aus NEXT haben diese Werte Vorrang. Die bestehende env-Datei und geplante Jobs bleiben unverändert. Speichern oder Löschen führt das Skript nicht aus. Gespeicherte Werte werden nicht erneut angezeigt.",
  "hook.environment.saved": "Umgebungsvariablen nur auf diesem Gerät gespeichert. Die Verbindung wurde noch nicht getestet. Das Eingabefeld wurde geleert.",
  "hook.environment.cleared": "Umgebungsvariablen gelöscht. Das Skript verwendet wieder seine ursprüngliche Konfiguration.",
  "hook.environment.error": "Umgebungsvariablen konnten nicht gespeichert werden. Prüfen Sie KEY=value und die unterstützten Variablennamen.",
  "hook.environment.unavailable": "Aktualisieren Sie note.md, um hier Umgebungsvariablen einzurichten.",
  "hook.settings.title": "Cube-Synchronisierungsskript",
  "hook.settings.help": "Nach dem Speichern von Aufgabenstatus, Erinnerung oder Frist wird ein Python-Skript im skills-Ordner dieses Vaults direkt ausgeführt. Ohne KI-Modell oder Tokenverbrauch.",
  "hook.settings.none": "Kein Skript ausgewählt",
  "hook.settings.select": "Python-Skript auswählen…",
  "hook.settings.clear": "Deaktivieren",
  "hook.settings.local": "Die Auswahl gilt sofort für dieses Gerät und diesen Vault. Python 3 und die Skriptabhängigkeiten sind erforderlich. Cube-Zugangsdaten bleiben lokal.",
  "hook.settings.unavailable": "Dieser Host unterstützt keine Skriptausführung. Aktualisieren Sie note.md auf eine unterstützte Version.",
  "hook.settings.error": "Die Skriptkonfiguration konnte nicht geändert werden.",
  "hook.status.running": "„{title}“ gespeichert · Cube wird synchronisiert…",
  "hook.status.synced": "„{title}“ gespeichert · Skript beendet; keine Änderungszahlen gemeldet.",
  "hook.status.noChanges": "„{title}“ gespeichert · Skript meldet: Prüfung abgeschlossen, diesmal keine Änderungen erforderlich.",
  "hook.status.changes": "„{title}“ gespeichert · Skript meldet: {created} erstellt, {updated} aktualisiert, {deleted} entfernt. Dies bestätigt nicht die Anzeige auf dem Gerät.",
  "hook.status.pending": "„{title}“ gespeichert · Cube-Synchronisierung ausstehend. Prüfen Sie Skript, Python-Abhängigkeiten und Verbindung.",
  "hook.status.pendingReason": "„{title}“ gespeichert · Cube-Synchronisierung ausstehend. {reason}",
  "hook.error.missingConfig": "Cube-Konfiguration fehlt. Tragen Sie DESK_DISPLAY_URL und DESK_DISPLAY_TOKEN in den NEXT-Einstellungen oder in ~/.config/desk-display/env ein.",
  "hook.error.connection": "Cube ist nicht erreichbar. Prüfen Sie Serveradresse und Netzwerk.",
  "hook.error.busy": "Eine andere Synchronisierung läuft. Versuchen Sie es gleich erneut.",
  "hook.error.serverVersion": "Der Cube-Server unterstützt noch keine sichere Erstellung. Aktualisieren Sie den Cube-Dienst.",
  "hook.retry": "Erneut synchronisieren",
  "hook.dismiss": "Synchronisierungsstatus schließen",
  'app.title': 'Nächster Schritt',
  'app.value': 'Gib Ideen und Aufgaben einen klaren nächsten Schritt – oder einen ruhigen Ort.',
  'filter.items': 'Typ- und Projektfilter',
  'common.loading': 'Wird geladen…',
  'common.refresh': 'Aktualisieren',
  'common.open': 'Öffnen',
  'common.close': 'Schließen',
  'common.cancel': 'Abbrechen',
  'common.save': 'Ablage bestätigen',
  'common.optional': 'Optional',
  'common.error': 'Ein Fehler ist aufgetreten',
  'empty.wip': 'Kein Eintrag ist derzeit verbindlich aktiv.',
  'empty.waiting': 'Nichts wartet auf eine Prüfung.',
  'empty.capture': 'Kein neuer Eintrag braucht eine Entscheidung.',
  'empty.dormant': 'Kein Eintrag muss wieder in den Blick kommen.',
  'empty.closed': 'Geschlossene Einträge bleiben verborgen, bis du sie anzeigst oder suchst.',
  'empty.search': 'Kein passender abgelegter Eintrag.',
  'section.wip': 'In Arbeit',
  'section.waiting': 'Warten',
  'section.capture': 'Eingang',
  'section.resurfaced': 'Wieder im Blick',
  'section.placed': 'Abgelegte Einträge',
  'section.repair': 'Prüfung nötig',
  'count.wip': '{count}/{limit}',
  'count.waiting': '{count}',
  'action.placeOne': 'Einen Eintrag ablegen',
  'action.newTask': 'Neue Aufgabe',
  'action.newIdea': 'Neue Idee',
  'action.settings': 'Einstellungen',
  'action.hideCapture': 'Einträge ausblenden',
  'action.findPlaced': 'Abgelegte Einträge anzeigen',
  'action.hidePlaced': 'Abgelegte Einträge ausblenden',
  'action.place': 'Ablegen',
  'action.placeMore': 'Mehr…',
  'completionNote.savedPending': 'Die Notiz wurde in der Task-Quelldatei gespeichert, der Abschluss ist jedoch noch nicht bestätigt. Erneut versuchen; die Notiz wird nicht doppelt hinzugefügt.',
  'completionNote.failed': 'Das Speichern ist noch nicht bestätigt. Der Inhalt bleibt erhalten. Dieselbe Notiz erneut versuchen.',
  'action.completeWithNote': 'Abschließen und Notiz hinzufügen',
  'field.completionNote': 'Kurze Notiz',
  'field.completionNote.placeholder': 'Was wurde erledigt? Mehrzeiliger Text kann eingefügt werden.',
  'action.transfer': 'An andere übergeben',
  'action.reopen': 'Neu prüfen',
  'action.relink': 'Neu verknüpfen',
  'action.openSource': 'Quelle öffnen',
  'badge.proofed': 'Geprüft',
  'badge.task': 'Aufgabe',
  'badge.agent': 'Von Agent hinzugefügt',
  'badge.orphan': 'Quelle fehlt',
  'badge.unsupported': 'Reparatur nötig',
  'badge.dueNone': 'Kein Fälligkeitsdatum',
  'badge.due': 'Fällig {date}',
  'badge.overdue': 'Überfällig {date}',
  'badge.contextMissing': 'Kontext ungeklärt',
  'metadata.label': 'Priorität, Fälligkeit und Kontexte',
  'metadata.edit.title': 'Planungsdaten für „{title}“ bearbeiten',
  'metadata.edit.help': 'Diese Werte werden direkt in der Quelldatei der Karte gespeichert.',
  'metadata.edit.save': 'Metadaten speichern',
  'metadata.edit.saveError': 'Die Metadaten konnten nicht gespeichert werden. Ihre Änderungen bleiben erhalten.',
  'metadata.edit.refreshWarning': 'Die Metadaten wurden gespeichert, aber Next konnte das Board noch nicht aktualisieren.',
  'priority.P0': 'P0 · Dringend',
  'priority.P1': 'P1 · Hoch',
  'priority.P2': 'P2 · Normal',
  'priority.P3': 'P3 · Niedrig',
  'warning.wip': 'WIP-Limit erreicht: {count} Einträge sind in Bearbeitung (Limit {limit}). Schließe mindestens einen ab, stelle ihn auf Warten oder verschiebe ihn auf Später. Diese Warnung bleibt sichtbar, bis die Anzahl unter dem Limit liegt.',
  'warning.waiting': 'Mehr als fünf Punkte warten. Prüfe, ob für jeden noch echte Abnahmeverantwortung besteht.',
  'warning.readOnly': 'Next bleibt schreibgeschützt, bis das Ereignisdokument repariert ist.',
  'search.placeholder': 'Titel, nächsten Schritt oder Ziel suchen',
  'sort.label': 'Sortierung',
  'sort.priority': 'Priorität zuerst',
  'sort.due': 'Fälligkeit zuerst',
  'sort.created': 'Neueste zuerst',
  'board.dragHelp': 'Ziehe eine Karte, um ihren Status zu ändern. Details kannst du unter „Ablegen → Mehr…“ ergänzen.',
  'create.title': 'Neue Idee',
  'create.destination': 'Speichern unter {path}',
  'create.field': 'Idee',
  'create.placeholder': 'Halte den Gedanken fest, bevor er verschwindet…',
  'create.save': 'Idee erstellen',
  'create.saveShortcut': '⌘↵ / Ctrl↵ zum Speichern',
  'task.create.title': 'Neue Aufgabe',
  'task.create.destination': 'Speichern unter {path}',
  'task.create.field': 'Aufgabe',
  'task.create.placeholder': 'Was muss erledigt werden?',
  'task.create.body': 'Kontext',
  'task.create.bodyPlaceholder': 'Informationen, die du zum Fortsetzen brauchst',
  'task.create.doneWhen': 'Erledigt, wenn',
  'task.create.doneWhenPlaceholder': 'Welches beobachtbare Ergebnis bedeutet fertig?',
  'task.create.saveInbox': 'Zum Eingang hinzufügen',
  'task.create.saveCurrent': 'Speichern und als aktuell markieren',
  'task.create.saveShortcut': '⌘↵ / Ctrl↵ fügt zum Eingang hinzu',
  'sheet.title': '„{title}“ ablegen',
  'sheet.choose': 'Was geschieht als Nächstes?',
  'route.commit': 'Jetzt weiterführen',
  'route.commit.detail': 'Verantwortung für einen konkreten nächsten Schritt übernehmen.',
  'route.wait': 'Auf Prüfung warten',
  'route.wait.detail': 'Ein externes Ergebnis muss noch abgenommen werden.',
  'route.park': 'Später ansehen',
  'route.park.detail': 'Die Erinnerung behalten, ohne aktuelle Verpflichtung.',
  'route.settle': 'Beenden oder weitergeben',
  'route.settle.detail': 'Abschließen, stoppen, übertragen oder in ein System überführen.',
  'field.commitment': 'Verpflichtung',
  'field.commitment.placeholder': 'Was wirst du prüfen oder liefern?',
  'field.nextAction': 'Nächster Schritt',
  'field.nextAction.placeholder': 'Ein Schritt, der ohne erneutes Nachdenken beginnt',
  'field.closeCondition': 'Abschlussbedingung',
  'field.closeCondition.placeholder': 'Welches Ergebnis oder Indiz erlaubt den Abschluss?',
  'field.waitingFor': 'Warten auf',
  'field.waitingFor.placeholder': 'Person, Ergebnis, Nachweis oder Produkttest',
  'field.reviewAt': 'Prüfen am',
  'field.wakeTrigger': 'Auslöser',
  'field.wakeTrigger.placeholder': 'Ein Datum oder eine konkrete Situation',
  'field.wakeTrigger.help': 'Daten erscheinen automatisch wieder. Situationen bleiben suchbar; Next erkennt sie nicht automatisch.',
  'field.exitKind': 'Ergebnis',
  'field.exitKind.placeholder': 'Ergebnis wählen',
  'field.exitVia': 'Art',
  'field.exitVia.placeholder': 'Art wählen',
  'field.reason': 'Grund',
  'field.reason.placeholder': 'Warum ist das Beenden jetzt richtig?',
  'field.target': 'Ziel',
  'field.target.placeholder': 'Projekt, Person, Produkt, Link, Regel oder Automatisierung',
  'field.result': 'Resultat',
  'field.result.placeholder': 'Optionales Resultat oder Link zum Nachweis',
  'field.project': 'Projekt',
  'field.priority': 'Priorität',
  'field.due': 'Fälligkeitsdatum · Optional',
  'field.contexts': 'GTD-Kontext · Optional',
  'field.contexts.placeholder': '@computer, @phone (kommagetrennt)',
  'settings.title': 'Einstellungen für Nächster Schritt',
  'settings.description': 'Diese Einstellungen gelten nur für Nächster Schritt und künftig erstellte Karten.',
  'settings.wipLimit': 'Limit für laufende Arbeit',
  'settings.wipLimit.help': 'Zeigt dauerhaft eine deutliche Warnung, sobald In Bearbeitung dieses Limit erreicht.',
  'settings.defaultPriority': 'Standardpriorität',
  'settings.defaultPriority.help': 'Füllt die Priorität für neue Ideen und Aufgaben vorab aus.',
  'settings.defaultDueDays': 'Standardfälligkeit',
  'settings.defaultDueDays.help': 'Tage nach der Erstellung; 0 lässt neue Karten ohne Fälligkeitsdatum.',
  'settings.defaultContext': 'Standard-GTD-Kontext',
  'settings.defaultContext.help': 'Optionaler Kontext für neue Karten, zum Beispiel @Computer oder @Telefon.',
  'settings.validation': 'Ganze Zahlen eingeben: Das Limit muss mindestens 1 sein, die Fälligkeitstage mindestens 0.',
  'settings.save': 'Einstellungen speichern',
  'settings.saving': 'Wird gespeichert…',
  'settings.saveError': 'Die Einstellungen konnten nicht gespeichert werden. Ihre Eingaben bleiben erhalten.',
  'field.project.placeholder': 'Projekt auswählen oder eingeben',
  'field.project.selected': 'Ausgewählte Projekte',
  'field.project.existing': 'Vorhandene Projekte',
  'field.project.add': 'Hinzufügen',
  'field.project.help': 'Mehrfachauswahl oder ein neues Projekt-Tag erstellen.',
  'field.project.target': 'In welches Projekt übernehmen?',
  'field.project.target.placeholder': 'Ein Projekt auswählen',
  'project.suggestion': 'Vorschlag · {project}',
  'project.suggestion.detail': 'Lokaler Treffer: {terms}. Vor dem Ablegen bestätigen.',
  'field.article': 'Veröffentlichter Artikel',
  'field.article.placeholder': 'Artikelpfad oder öffentliche URL',
  'preset.commit.verify': 'Prüfen, ob „{title}“ weiterverfolgt werden soll',
  'preset.commit.prototype': 'Einen brauchbaren Prototyp für „{title}“ bauen',
  'preset.commit.plan': '„{title}“ als prüfbaren Plan ausarbeiten',
  'preset.commit.deliver': 'Das kleinste brauchbare Ergebnis für „{title}“ liefern',
  'preset.next.evidence': 'Drei wichtige Belege sammeln',
  'preset.next.experiment': 'Ein minimales Experiment durchführen',
  'preset.next.draft': 'Die erste Version schreiben',
  'preset.next.user': 'Eine echte Nutzerin oder einen Nutzer fragen',
  'preset.close.decision': 'Klar über Fortsetzen oder Stoppen entscheiden',
  'preset.close.prototype': 'Einen brauchbaren Prototyp fertigstellen',
  'preset.close.used': 'Eine Person nutzt es und gibt Rückmeldung',
  'preset.close.metric': 'Das gewählte Prüfkriterium erreichen',
  'preset.wait.person': 'Antwort einer Person zu „{title}“',
  'preset.wait.agent': 'Ergebnis eines Agents zu „{title}“',
  'preset.wait.review': 'Prüf- oder Abnahmefeedback zu „{title}“',
  'preset.wait.evidence': 'Wichtiger Beleg zu „{title}“',
  'preset.date.tomorrow': 'Morgen',
  'preset.date.days3': 'In 3 Tagen',
  'preset.date.week1': 'In 1 Woche',
  'preset.date.weeks2': 'In 2 Wochen',
  'preset.date.month1': 'In 1 Monat',
  'preset.wake.week': 'Nächste Woche',
  'preset.wake.month': 'Nächsten Monat',
  'preset.wake.related': 'Wenn ein verwandtes Projekt beginnt',
  'preset.wake.repeat': 'Wenn dasselbe Problem erneut auftritt',
  'preset.wake.evidence': 'Wenn ein wichtiger Beleg vorliegt',
  'preset.reason.value': 'Nicht wertvoll genug',
  'preset.reason.timing': 'Der Zeitpunkt ist falsch',
  'preset.reason.disproved': 'Die Kernannahme wurde widerlegt',
  'preset.reason.better': 'Es gibt bereits eine bessere Lösung',
  'preset.result.accepted': 'Fertig und abgenommen',
  'preset.result.source': 'Die Quellnotiz ist das Ergebnis',
  'preset.result.delivered': 'Geliefert',
  'preset.result.recorded': 'Nachweis wurde festgehalten',
  'exit.done': 'Erledigt',
  'exit.stopped': 'Gestoppt',
  'exit.transferred': 'Weitergegeben',
  'exit.compressed': 'In ein System überführt',
  'via.none': 'Direkt abgeschlossen',
  'via.delegateDone': 'Delegiert und abgenommen',
  'via.article': 'Als vollständigen Artikel ausgearbeitet und veröffentlicht',
  'via.delegateTransferred': 'Verantwortung übertragen',
  'via.drop': 'Verworfen',
  'via.disproved': 'Widerlegt',
  'via.ignore': 'Ignoriert',
  'via.merge': 'Zusammengeführt',
  'via.project': 'In ein Projekt übertragen',
  'via.buy': 'Bestehende Lösung gekauft',
  'via.publish': 'Material zur Weiterarbeit veröffentlicht',
  'via.principle': 'In einen Grundsatz überführt',
  'via.automate': 'Automatisiert',
  'relink.title': 'Quelle neu verknüpfen',
  'relink.helpExact': 'Diese Dateien haben denselben Erstellungszeitpunkt. Bestätige die richtige Quelle; Next ändert sie nicht.',
  'relink.helpManual': 'Kein gleicher Erstellungszeitpunkt gefunden. Prüfe Pfad und Zeitpunkt dieser unbelegten Ideen selbst.',
  'relink.created': 'Erstellt',
  'relink.createdUnknown': 'unbekannt',
  'relink.noCandidates': 'Keine unbelegten Ideendateien gefunden.',
  'error.required': 'Fülle die erforderlichen Felder aus.',
  'error.ideaRequired': 'Schreibe die Idee vor dem Speichern auf.',
  'error.taskRequired': 'Benenne die Aufgabe vor dem Speichern.',
  'error.doneWhenRequired': 'Ergänze ein Abschlusskriterium, bevor du sie als aktuell markierst.',
  'error.createTask': 'Next konnte diese Aufgabe nicht erstellen.',
  'error.createRefresh': 'Die Aufgabe wurde gespeichert, aber Next konnte den Eingang nicht aktualisieren.',
  'error.createRefreshCurrent': 'Die Aufgabe wurde gespeichert, aber wegen der fehlgeschlagenen Aktualisierung nicht als aktuell markiert.',
  'error.createCurrent': 'Die Aufgabe liegt sicher im Eingang, konnte aber nicht als aktuell markiert werden.',
  'error.create': 'Next konnte diese Idee nicht erstellen.',
  'error.load': 'Next konnte deine Einträge nicht laden.',
  'error.save': 'Next konnte diese Entscheidung nicht speichern.',
  'error.open': 'Die Quelldatei konnte nicht geöffnet werden.',
  'status.capture': 'Eingang',
  'status.wip': 'In Arbeit',
  'status.waiting': 'Warten',
  'status.dormant': 'Irgendwann',
  'outcome.done': 'Erledigt',
  'outcome.stopped': 'Gestoppt',
  'outcome.transferred': 'Übergeben',
  'outcome.compressed': 'Verdichtet',
  'reminder.open': 'Erinnerungen verwalten',
  'reminder.title': 'Erinnerungen für „{title}“',
  'reminder.status.automatic': 'Automatische Erinnerungen',
  'reminder.status.paused': 'Pausiert bis {time}',
  'reminder.status.muted': 'Erinnerungen ausgeschaltet',
  'reminder.status.legacy': 'Separater Abschlussvermerk aktiv',
  'reminder.status.error': 'Erinnerungsstatus nicht verfügbar',
  'reminder.status.closed': 'Keine weiteren Erinnerungen',
  'reminder.saved': 'Erinnerungseinstellungen gespeichert',
  'reminder.saveError': 'Erinnerungseinstellungen konnten nicht gespeichert werden. Ihre Eingaben bleiben erhalten.',
  'reminder.refreshWarning': 'Erinnerungseinstellungen gespeichert; der Status konnte noch nicht aktualisiert werden.',
  'reminder.loading': 'Erinnerungsstatus wird geladen…',
  'reminder.pauseHour': '1 Stunde pausieren',
  'reminder.pauseTomorrow': 'Bis morgen um 9 Uhr pausieren',
  'reminder.resume': 'Automatische Erinnerungen fortsetzen',
  'reminder.mute': 'Erinnerungen ausschalten',
  'reminder.more': 'Mehr…',
  'reminder.policy': 'Erinnerungen',
  'reminder.pauseUntil': 'Pausieren bis (optional)',
  'reminder.timeZone': 'Lokale Zeitzone: {zone}',
  'reminder.due': 'Fälligkeitsdatum',
  'reminder.noDue': 'Kein Fälligkeitsdatum festgelegt',
  'reminder.state': 'Aktueller Erinnerungsstatus',
  'reminder.help': 'Das Ausschalten von Erinnerungen schließt die Aufgabe nicht ab.',
  'reminder.resumeHelp': 'Nach dem Fortsetzen gelten die bisherigen Regeln; es wird nicht sofort gesendet.',
  'reminder.syncHelp': 'Änderungen werden bei der nächsten Erinnerungssynchronisierung wirksam; die Anzeige kann noch eine frühere Nachricht enthalten.',
  'reminder.legacyHelp': 'Ein separater Abschlussvermerk gilt weiterhin. Automatische Erinnerungen können hier nicht wiederhergestellt werden.',
  'reminder.errorHelp': 'Der vorhandene Erinnerungsdatensatz konnte nicht gelesen werden und wird nicht überschrieben.',
  'reminder.unsupportedHelp': 'Reparieren Sie diese Aufgabe, bevor Sie ihre Erinnerungen ändern.',
  'reminder.closedHelp': 'Diese Aufgabe ist geschlossen und erhält keine Erinnerungen mehr. Öffnen Sie die Aufgabe erneut, um Erinnerungen zu ändern.',
  'reminder.save': 'Erinnerungseinstellungen speichern',
  'reminder.validation.invalid': 'Geben Sie ein gültiges lokales Datum mit Uhrzeit ein.',
  'reminder.validation.past': 'Das Ende der Pause muss in der Zukunft liegen.',
  'reminder.validation.ambiguous': 'Diese Ortszeit kommt wegen der Zeitumstellung zweimal vor. Wählen Sie eine andere Zeit.',
  'reminder.validation.nonexistent': 'Diese Ortszeit existiert wegen der Zeitumstellung nicht. Wählen Sie eine andere Zeit.',
  'status.closed': 'Geschlossen',
  'status.unsupported': 'Nicht unterstützt',
}

export const CATALOGS: Record<Locale, Catalog> = { en, zh, ja, de }
export const LOCALES: Locale[] = ['en', 'zh', 'ja', 'de']

let active: Locale = 'en'

function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh' || value === 'ja' || value === 'de'
}

export function setLocale(code: string | undefined): void {
  const base = code?.split('-')[0]
  active = isLocale(base) ? base : 'en'
}

export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  const template = CATALOGS[active]?.[key] ?? en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}
