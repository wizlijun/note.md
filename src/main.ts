import { mount } from 'svelte'
import App from './App.svelte'
import { initFormFactor } from './lib/platform.svelte'

// fire-and-forget; UI starts as 'desktop' and reactively updates after Tauri resolves
initFormFactor().catch((e) => console.warn('[main] initFormFactor:', e))

const target = document.getElementById('app')
if (!target) throw new Error('Root element #app not found')

mount(App, { target })
