import { mount } from 'svelte'
import ChatApp from './chat-app.svelte'

const target = document.getElementById('chat-app')
if (!target) throw new Error('chat-app root missing')
mount(ChatApp, { target })
