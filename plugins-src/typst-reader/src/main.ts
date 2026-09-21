import { mount } from 'svelte'
import App from './App.svelte'
import '../../../src/styles/ui-foundation.css'

mount(App, { target: document.getElementById('app')! })
