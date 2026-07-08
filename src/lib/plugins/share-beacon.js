;(function () {
  // Self-contained reading-time beacon for shared M↓ pages. Mirrors the pure
  // reference in ./beacon-timing.ts (its runtime twin — no bundler). Never let
  // anything here throw into the host page.
  try {
    var slug = location.pathname.replace(/^\//, '')
    if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,50}(?:-[a-zA-Z0-9]{2,4})?$/.test(slug)) return
    var HIT = '/a/hit'
    var IDLE = 30000, CAP = 1800000, BEAT = 15000

    var vid
    try {
      vid = localStorage.getItem('mdi_vid')
      if (!vid) {
        vid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2)
        localStorage.setItem('mdi_vid', vid)
      }
    } catch (e) { vid = 's' + Math.random().toString(36).slice(2) }
    var sid = String(Date.now()) + Math.random().toString(36).slice(2)

    var visible = document.visibilityState === 'visible'
    var lastAct = Date.now(), cursor = Date.now(), total = 0

    function take(now) {
      if (now <= cursor) { cursor = Math.max(cursor, now); return 0 }
      var idleAt = lastAct + IDLE, end = now
      if (!visible) end = cursor
      else if (now > idleAt) end = Math.max(cursor, idleAt)
      var gross = Math.max(0, end - cursor)
      cursor = now
      var room = Math.max(0, CAP - total), c = Math.min(gross, room)
      total += c
      return c
    }

    function send(delta, useBeacon) {
      if (delta <= 0) return
      var payload = JSON.stringify({ slug: slug, visitor_id: vid, session_id: sid, delta_ms: delta, ts: Date.now() })
      if (useBeacon && navigator.sendBeacon) {
        try { navigator.sendBeacon(HIT, new Blob([payload], { type: 'application/json' })); return } catch (e) {}
      }
      try { fetch(HIT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }) } catch (e) {}
    }

    function activity() {
      var now = Date.now()
      if (now - lastAct >= IDLE) cursor = now
      lastAct = now
    }
    ;['scroll', 'keydown', 'pointerdown', 'touchstart', 'mousemove'].forEach(function (e) {
      window.addEventListener(e, activity, { passive: true })
    })

    document.addEventListener('visibilitychange', function () {
      var now = Date.now()
      if (document.visibilityState === 'hidden') { send(take(now), true); visible = false; cursor = now }
      else { visible = true; cursor = now; lastAct = now }
    })
    window.addEventListener('pagehide', function () { send(take(Date.now()), true) })
    setInterval(function () { if (visible) send(take(Date.now()), false) }, BEAT)
  } catch (e) { /* never break the page */ }
})()
