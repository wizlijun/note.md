import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import DailyNotesApp from './daily-notes-app.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('daily-notes-app')
if (!target) throw new Error('daily-notes-app root missing')
mount(DailyNotesApp, { target })
