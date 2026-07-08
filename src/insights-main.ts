import { mount } from 'svelte'
import InsightsApp from './insights-app.svelte'

const target = document.getElementById('insights-app')
if (!target) throw new Error('insights-app root missing')
mount(InsightsApp, { target })
