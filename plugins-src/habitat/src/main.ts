import { mount } from 'svelte'
import '../../../src/styles/ui-foundation.css'
import './styles.css'
import App from './App.svelte'

const target = document.getElementById('habitat-app')
if (!target) throw new Error('habitat-app root missing')
mount(App, { target })
