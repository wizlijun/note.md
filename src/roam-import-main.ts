import { mount } from 'svelte'
import RoamImportApp from './roam-import-app.svelte'

const target = document.getElementById('roam-import-app')
if (!target) throw new Error('roam-import-app root missing')
mount(RoamImportApp, { target })
