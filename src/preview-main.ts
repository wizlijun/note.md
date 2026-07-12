import { mount } from 'svelte'
import PreviewApp from './preview-app.svelte'

const target = document.getElementById('preview-app')
if (!target) throw new Error('preview-app root missing')
mount(PreviewApp, { target })
