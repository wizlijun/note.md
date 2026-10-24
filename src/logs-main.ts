import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import LogsApp from './logs-app.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('logs-app')
if (!target) throw new Error('logs-app root missing')
mount(LogsApp, { target })
