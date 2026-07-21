import { mount } from 'svelte'
import LogsApp from './logs-app.svelte'

const target = document.getElementById('logs-app')
if (!target) throw new Error('logs-app root missing')
mount(LogsApp, { target })
