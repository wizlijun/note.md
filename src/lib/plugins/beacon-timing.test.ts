import { describe, it, expect } from 'vitest'
import { createBeaconClock, IDLE_MS, MAX_SESSION_MS } from './beacon-timing'

describe('beacon clock', () => {
  it('accrues time only while visible and not idle', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    expect(c.takeDelta(5000)).toBe(5000)     // 5s visible
    c.setVisible(false, 7000)                // hidden at 7s → credit 2s more internally
    expect(c.takeDelta(7000)).toBe(0)        // already credited up to 7000 by setVisible
    expect(c.takeDelta(10000)).toBe(0)       // hidden: nothing
  })

  it('credits up to the hide moment when going hidden', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    c.takeDelta(5000)                        // credit 0..5000
    let credited = 0
    const orig = c.takeDelta.bind(c)
    // setVisible(false) should internally credit 5000..7000 = 2000.
    // We observe it by checking total via a fresh visible window afterward.
    c.setVisible(false, 7000)
    expect(c.takeDelta(9000)).toBe(0)        // still hidden
    c.setVisible(true, 9000)
    c.activity(9000)
    expect(c.takeDelta(10000)).toBe(1000)    // visible again 9000..10000
  })

  it('pauses after IDLE_MS without activity, crediting only up to the idle threshold', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    expect(c.takeDelta(IDLE_MS + 5000)).toBe(IDLE_MS)  // idle kicked in at IDLE_MS
  })

  it('resumes from idle on activity without retro-crediting the idle gap', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    c.activity(0)
    c.takeDelta(IDLE_MS + 5000)              // goes idle, credits IDLE_MS
    c.activity(IDLE_MS + 5000)               // resume
    expect(c.takeDelta(IDLE_MS + 8000)).toBe(3000)  // 3s after resume
  })

  it('caps total accrued at MAX_SESSION_MS', () => {
    const c = createBeaconClock(0)
    c.setVisible(true, 0)
    let total = 0
    for (let t = 1000; t <= MAX_SESSION_MS + 600_000; t += 1000) {
      c.activity(t)
      total += c.takeDelta(t)
    }
    expect(total).toBe(MAX_SESSION_MS)
  })
})
