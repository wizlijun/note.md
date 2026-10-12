import { mount } from 'svelte'
import '../../../src/styles/ui-foundation.css'
import App from './App.svelte'

const target = document.getElementById('agency-app')
if (!target) throw new Error('agency-app root missing')
mount(App, { target })
