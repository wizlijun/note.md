import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import InsightsApp from './insights-app.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('insights-app')
if (!target) throw new Error('insights-app root missing')
mount(InsightsApp, { target })
