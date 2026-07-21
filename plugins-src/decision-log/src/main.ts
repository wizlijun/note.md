import { mount } from 'svelte'
import App from './App.svelte'

const target = document.getElementById('decision-log-app')
if (!target) throw new Error('decision-log-app root missing')
mount(App, { target })
