document.addEventListener('click', function (event) {
  if (!event.isTrusted) return
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null
  if (!target) return
  event.preventDefault()
  parent.postMessage({ type: 'notemd.assistant-mail.preview-link', url: target.href }, '*')
}, true)
