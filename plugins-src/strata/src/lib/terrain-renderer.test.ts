// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { createTerrain3D } from './terrain-renderer'
import type { TerrainRenderOptions } from './terrain-renderer'
import { elevation } from './contour-path'

const rendered = vi.hoisted(() => ({ scene: null as import('three').Scene | null, camera: null as import('three').PerspectiveCamera | null }))
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>()
  return { ...actual, WebGLRenderer: class {
    shadowMap = { enabled: false, type: 0, autoUpdate: false, needsUpdate: false }
    capabilities = { getMaxAnisotropy: () => 1 }
    renderLists = { dispose() {} }
    getContext() { return { isContextLost: () => false } }
    setPixelRatio() {}
    setSize() {}
    render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) { rendered.scene = scene; rendered.camera = camera }
    dispose() {}
  } }
})

let renderer: ReturnType<typeof createTerrain3D> | undefined
let width = 900, height = 600
beforeEach(() => {
  rendered.scene = null; rendered.camera = null; width = 900; height = 600
  const noop = () => {}
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: noop, fillRect: noop, scale: noop, beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop } as unknown as CanvasRenderingContext2D)
  const canvas = document.createElement('canvas')
  vi.spyOn(canvas, 'getBoundingClientRect').mockImplementation(() => ({ width, height } as DOMRect))
  renderer = createTerrain3D(canvas, () => '')
})
afterEach(() => { renderer?.dispose(); renderer = undefined; vi.restoreAllMocks() })

function options(base: number, span = .048, zoom = 1, verticalScale = 1): TerrainRenderOptions {
  return { field: Float32Array.from([0, .15, .05, .2], relief => .012 * Math.expm1((base + relief) / .24)),
    grid: { width: 2, height: 2, bounds: { width: span, height: span } }, contours: [], levels: [], verticalScale, contourOpacity: 0, detail: 1,
    view: { yaw: -.25, pitch: 1.05, distance: 13, targetX: .5, targetY: .5, zoom } }
}
function cameraDistance(targetY: number) { return rendered.camera!.position.distanceTo(new THREE.Vector3(0, targetY, 0)) }
const visibleMeshes = () => rendered.scene!.children.filter(child => child instanceof THREE.Mesh && child.visible)

it('frames a high-altitude cropped surface exactly like the same relief at a lower altitude', () => {
  const low = options(.1), original = [...low.field]
  renderer!.render(low)
  const lowPoints = [{ x: .15, y: .25 }, { x: .85, y: .75 }].map(point => renderer!.project(point))
  expect(lowPoints.every(point => point.visible)).toBe(true)
  expect(Math.abs(lowPoints[1].x - lowPoints[0].x)).toBeGreaterThan(width * .4)
  expect(cameraDistance(.2)).toBeCloseTo(.672, 5)
  expect(visibleMeshes()).toHaveLength(1)
  const lowCameraY = rendered.camera!.position.y
  const high = options(1.6)
  renderer!.render(high)
  const highPoints = [{ x: .15, y: .25 }, { x: .85, y: .75 }].map(point => renderer!.project(point))
  highPoints.forEach((point, i) => {
    expect(point.visible).toBe(true)
    expect(point.x).toBeCloseTo(lowPoints[i].x, 2)
    expect(point.y).toBeCloseTo(lowPoints[i].y, 2)
  })
  expect(rendered.camera!.position.y - lowCameraY).toBeCloseTo(1.5, 5)
  expect(cameraDistance(1.7)).toBeCloseTo(.672, 5)
  expect(renderer!.heightAt(.5, .5)).toBeCloseTo(high.field.reduce((a, b) => a + b) / 4, 5)
  expect([...low.field]).toEqual(original)
})

it('fits local relief using zoom, portrait aspect and the actual vertical scale', () => {
  renderer!.render(options(1.6, .048, 2))
  expect(cameraDistance(1.7)).toBeCloseTo(.336, 5)
  renderer!.render(options(1.6, .048, 1, 1.8))
  expect(cameraDistance(1.7 * 1.8)).toBeCloseTo(2.8 * .2 * 1.8, 5)
  width = 300; height = 900
  renderer!.render(options(1.6))
  expect(cameraDistance(1.7)).toBeCloseTo(.672 * .85 / (width / height), 5)
})

it('restores the unchanged overview framing and base when returning from a focused tile', () => {
  renderer!.render(options(1.6))
  expect(visibleMeshes()).toHaveLength(1)
  const overview = options(1.6, 1, 3)
  renderer!.render(overview)
  const originalTarget = Math.min(.8, elevation(renderer!.heightAt(.5, .5)) * overview.verticalScale * .5) + .12
  expect(cameraDistance(originalTarget)).toBeCloseTo(overview.view.distance, 8)
  expect(visibleMeshes()).toHaveLength(4)
})
