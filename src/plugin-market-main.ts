import { installBrowserContextMenuGuard } from './lib/context-menu/browser-default'
import { mount } from 'svelte'
import PluginMarketApp from './plugin-market-app.svelte'

installBrowserContextMenuGuard()

const target = document.getElementById('plugin-market-app')
if (!target) throw new Error('plugin-market-app root missing')
mount(PluginMarketApp, { target })
