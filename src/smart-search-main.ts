import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import SmartSearchApp from './SmartSearchApp.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('smart-search-app')
if (!target) throw new Error('smart-search-app root missing')
mount(SmartSearchApp, { target })
