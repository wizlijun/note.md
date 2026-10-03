import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createRusticAssets, rusticHuts, rusticCabins } from './city-rustic-assets'

describe('complete offline rustic buildings', () => {
  it('builds four finite, centered houses with bounded details and shared materials', () => {
    const assets = createRusticAssets(), materials = new Set<THREE.Material>()
    expect(assets.map(a => a.id)).toEqual([...rusticHuts, ...rusticCabins])
    for (const model of assets) {
      const bounds = new THREE.Box3(), triangles = model.parts.reduce((n, p) => n + p.geometry.getAttribute('position').count / 3, 0)
      expect(triangles).toBeGreaterThan(1000)
      expect(triangles).toBeLessThan(16000)
      expect(model.parts.length).toBeLessThan(25)
      for (const { geometry, material } of model.parts) {
        materials.add(material); bounds.union(geometry.boundingBox!)
        expect(geometry.userData.sharedCityAsset).toBe(true)
        for (const value of geometry.getAttribute('position').array) expect(Number.isFinite(value)).toBe(true)
        expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count)
      }
      expect(bounds.min.y).toBeCloseTo(0, 6)
      expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 6)
      expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0, 6)
      expect(bounds.getSize(new THREE.Vector3()).distanceTo(model.size)).toBeLessThan(.00001)
      expect(model.size.y / Math.max(model.size.x, model.size.z)).toBeGreaterThan(.7)
    }
    for (const model of assets) for (const part of model.parts) part.geometry.dispose()
    for (const material of materials) material.dispose()
  })
})
