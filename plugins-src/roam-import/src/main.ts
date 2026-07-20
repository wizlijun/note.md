import { mount } from 'svelte'
import App from './App.svelte'

const target = document.getElementById('roam-import-app')
if (!target) throw new Error('roam-import-app root missing')
mount(App, { target })
