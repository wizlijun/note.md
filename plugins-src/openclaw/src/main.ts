import { mount } from 'svelte'
import App from './App.svelte'
import { setLocale } from './lib/strings'

// Seed i18n from the host-injected locale before the app mounts.
setLocale(window.notemd?.locale)

const target = document.getElementById('openclaw-app')
if (!target) throw new Error('openclaw-app root missing')
mount(App, { target })
