import { mount } from 'svelte'
import '../../../src/styles/ui-foundation.css'
import './styles.css'
import App from './App.svelte'

const target = document.getElementById('strata-app')
if (!target) throw new Error('strata-app root missing')
mount(App, { target })
