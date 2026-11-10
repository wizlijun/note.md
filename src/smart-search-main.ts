import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import SmartLookupApp from './SmartLookupApp.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('smart-search-app')
if (!target) throw new Error('smart-search-app root missing')
mount(SmartLookupApp, { target })
