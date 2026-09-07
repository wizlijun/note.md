// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import CanvasSelectionResizer from './CanvasSelectionResizer.svelte'

describe('CanvasSelectionResizer pointer ownership', () => {
  let component: ReturnType<typeof mount> | null = null

  afterEach(async () => {
    if (component) await unmount(component)
    component = null
    document.body.innerHTML = ''
  })

  function setup() {
    const callbacks = {
      onStart: vi.fn(), onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn(), onKeyboardResize: vi.fn(),
    }
    component = mount(CanvasSelectionResizer, {
      target: document.body,
      props: {
        bounds: { x: 10, y: 20, width: 300, height: 200 },
        viewport: { x: 0, y: 0, zoom: 1 },
        ...callbacks,
      },
    })
    const handle = document.querySelector('.resize-handle.br') as HTMLButtonElement
    const setCapture = vi.fn()
    const releaseCapture = vi.fn()
    Object.defineProperties(handle, {
      setPointerCapture: { configurable: true, value: setCapture },
      releasePointerCapture: { configurable: true, value: releaseCapture },
    })
    return { ...callbacks, handle, setCapture, releaseCapture }
  }

  function pointer(target: HTMLElement, type: string, pointerId = 1, isPrimary = true): PointerEvent {
    const event = new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId, pointerType: 'touch', isPrimary,
      button: 0, clientX: 350, clientY: 250,
    })
    target.dispatchEvent(event)
    return event
  }

  it('keeps a resize owned by its primary pointer and ignores other pointer endings', () => {
    const h = setup()
    pointer(h.handle, 'pointerdown', 2, false)
    expect(h.onStart).not.toHaveBeenCalled()

    pointer(h.handle, 'pointerdown')
    pointer(h.handle, 'pointerdown', 3)
    pointer(h.handle, 'pointermove', 3)
    pointer(h.handle, 'pointercancel', 3)
    expect(h.onStart).toHaveBeenCalledTimes(1)
    expect(h.onMove).not.toHaveBeenCalled()
    expect(h.onCancel).not.toHaveBeenCalled()
    expect(h.releaseCapture).not.toHaveBeenCalled()

    const move = pointer(h.handle, 'pointermove')
    const end = pointer(h.handle, 'pointerup')
    expect(h.onMove).toHaveBeenCalledWith(move)
    expect(h.onEnd).toHaveBeenCalledWith(end)
    expect(h.releaseCapture).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('cancels when pointer capture is lost and allows the next gesture to start', () => {
    const h = setup()
    pointer(h.handle, 'pointerdown')
    const loss = pointer(h.handle, 'lostpointercapture')
    pointer(h.handle, 'pointermove')
    pointer(h.handle, 'pointerup')
    expect(h.onCancel).toHaveBeenCalledExactlyOnceWith(loss)
    expect(h.onMove).not.toHaveBeenCalled()
    expect(h.onEnd).not.toHaveBeenCalled()

    pointer(h.handle, 'pointerdown', 2)
    pointer(h.handle, 'pointerup', 2)
    expect(h.onStart).toHaveBeenCalledTimes(2)
    expect(h.onEnd).toHaveBeenCalledTimes(1)
  })

  it('does not cancel a committed gesture when releasing capture dispatches a loss event', () => {
    const h = setup()
    h.releaseCapture.mockImplementation((pointerId: number) => {
      pointer(h.handle, 'lostpointercapture', pointerId)
    })
    pointer(h.handle, 'pointerdown')
    pointer(h.handle, 'pointerup')
    pointer(h.handle, 'pointerup')
    expect(h.onEnd).toHaveBeenCalledTimes(1)
    expect(h.onCancel).not.toHaveBeenCalled()
    expect(h.releaseCapture).toHaveBeenCalledTimes(1)
  })

  it('cancels and releases the active gesture when a tool switch removes the resizer', async () => {
    const h = setup()
    await tick()
    pointer(h.handle, 'pointerdown')
    const lastMove = pointer(h.handle, 'pointermove')
    await unmount(component!)
    component = null
    expect(h.onCancel).toHaveBeenCalledExactlyOnceWith(lastMove)
    expect(h.onEnd).not.toHaveBeenCalled()
    expect(h.releaseCapture).toHaveBeenCalledExactlyOnceWith(1)
  })
})
