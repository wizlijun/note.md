// Keep module initialization errors visible even before the editor UI mounts.
function failure(error: unknown) {
  const output = document.createElement('pre')
  output.style.cssText = 'position:fixed;inset:0;z-index:2147483647;overflow:auto;white-space:pre-wrap;color:#fff;background:#300;margin:0;padding:24px'
  output.textContent = `Sumi benchmark initialization failed\n${error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)}`
  document.body.append(output)
}
window.addEventListener('error', event => failure(event.error ?? event.message))
window.addEventListener('unhandledrejection', event => failure(event.reason))
void import('./main').catch(failure)
