import { describe, it, expect } from 'vitest'
import { initTiming, applyEvent, activeNow, sessionActionFor, IDLE_MS } from './timing'

describe('activeNow', () => {
  it('is true only when focused, tab active, and not idle', () => {
    expect(activeNow({ appFocused: true, tabActive: true, idle: false })).toBe(true)
    expect(activeNow({ appFocused: false, tabActive: true, idle: false })).toBe(false)
    expect(activeNow({ appFocused: true, tabActive: false, idle: false })).toBe(false)
    expect(activeNow({ appFocused: true, tabActive: true, idle: true })).toBe(false)
  })
})

describe('applyEvent', () => {
  it('accrues nothing until the session becomes active', () => {
    let s = initTiming(1000, 'read')
    const r = applyEvent(s, { type: 'focus' }, 1000)
    expect(r.accrued).toBeNull()
    expect(activeNow(r.state.presence)).toBe(false) // tab not active yet
  })

  it('accrues read ms from active-start to blur', () => {
    let s = initTiming(1000, 'read')
    s = applyEvent(s, { type: 'focus' }, 1000).state
    s = applyEvent(s, { type: 'tabActive' }, 1000).state // now active
    const r = applyEvent(s, { type: 'blur' }, 4000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 })
  })

  it('attributes time to the mode that was in effect while active', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    // Switch to edit mode at t=2000: flush the 2000ms of read first.
    const sw = applyEvent(s, { type: 'mode', mode: 'edit' }, 2000)
    expect(sw.accrued).toEqual({ mode: 'read', ms: 2000 })
    s = sw.state
    const r = applyEvent(s, { type: 'blur' }, 5000)
    expect(r.accrued).toEqual({ mode: 'edit', ms: 3000 })
  })

  it('goes idle on a tick past IDLE_MS with no activity, accruing up to the last activity', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state // active, lastActivity=0
    // Tick after IDLE_MS with no activity → pause. Accrue only up to lastActivity.
    const r = applyEvent(s, { type: 'tick' }, IDLE_MS + 5000)
    expect(r.state.presence.idle).toBe(true)
    expect(r.accrued).toEqual({ mode: 'read', ms: 0 }) // lastActivity was 0, active start was 0
  })

  it('resumes from idle on activity and accrues from the resume moment', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state
    s = applyEvent(s, { type: 'tick' }, IDLE_MS + 1000).state // idle now
    s = applyEvent(s, { type: 'activity' }, 20000).state       // resume at 20000
    const r = applyEvent(s, { type: 'blur' }, 23000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 })
  })

  it('checkpoints on tick while active, resetting the active-start to now', () => {
    let s = initTiming(0, 'read')
    s = applyEvent(s, { type: 'focus' }, 0).state
    s = applyEvent(s, { type: 'tabActive' }, 0).state
    s = applyEvent(s, { type: 'activity' }, 0).state
    const t = applyEvent(s, { type: 'tick' }, 5000) // still within IDLE_MS
    expect(t.accrued).toEqual({ mode: 'read', ms: 5000 })
    s = t.state
    const r = applyEvent(s, { type: 'blur' }, 8000)
    expect(r.accrued).toEqual({ mode: 'read', ms: 3000 }) // only since the checkpoint
  })
})

describe('sessionActionFor', () => {
  it('opens a session on inactive→active', () => {
    expect(sessionActionFor(false, true, null)).toEqual({ start: true, extend: null, close: false })
  })

  it('extends without opening/closing while staying active (e.g. mode switch)', () => {
    const a = sessionActionFor(true, true, { mode: 'edit', ms: 3000 })
    expect(a).toEqual({ start: false, extend: { mode: 'edit', ms: 3000 }, close: false })
  })

  it('credits the final stretch AND closes on active→inactive (blur / idle)', () => {
    const a = sessionActionFor(true, false, { mode: 'read', ms: 2000 })
    expect(a).toEqual({ start: false, extend: { mode: 'read', ms: 2000 }, close: true })
  })
})
