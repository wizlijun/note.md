import { mount } from 'svelte'
import { initFormFactor } from './lib/platform.svelte'

// fire-and-forget; UI starts as 'desktop' and reactively updates after Tauri resolves
initFormFactor().catch((e) => console.warn('[main] initFormFactor:', e))

declare global {
  interface Window {
    __M_CLI_MODE__?: boolean
  }
}

async function bootstrap(): Promise<void> {
  const target = document.getElementById('app')
  if (!target) throw new Error('Root element #app not found')
  if (window.__M_CLI_MODE__) {
    const { default: CliRunner } = await import('./lib/cli/CliRunner.svelte')
    mount(CliRunner, { target })
  } else {
    const { default: App } = await import('./App.svelte')
    mount(App, { target })
  }
}

bootstrap()
