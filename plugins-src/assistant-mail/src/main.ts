import { mount } from 'svelte'
import App from './App.svelte'

const target = document.getElementById('assistant-mail-app')
if (!target) throw new Error('assistant-mail-app root missing')
mount(App, { target })
