import { mount } from 'svelte'
import App from './App.svelte'

const entry = document.body.dataset.entry === 'viewer' ? 'viewer' : 'browser'
mount(App, { target: document.getElementById('app')!, props: { entry } })
