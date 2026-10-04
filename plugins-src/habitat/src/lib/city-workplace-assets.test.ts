import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createWorkplaceAssets, workplaceStudios } from './city-workplace-assets'

describe('single-address workplace studios', () => {
  it('provides three complete finite centered models with one colored part each and shared material', () => {
    const assets = createWorkplaceAssets(), materials = new Set<THREE.Material>(), counts: number[] = []
    expect(assets.map(a => a.id)).toEqual([...workplaceStudios])
    for (const asset of assets) {
      expect(asset.parts).toHaveLength(1)
      const { geometry, material } = asset.parts[0]
      const position = geometry.getAttribute('position'), normals = geometry.getAttribute('normal'), color = geometry.getAttribute('color')
      const triangles = position.count / 3; counts.push(triangles); materials.add(material)
      expect(triangles).toBeGreaterThan(1000); expect(triangles).toBeLessThan(16000)
      expect(normals.count).toBe(position.count); expect(color.count).toBe(position.count)
      for (const attribute of [position, normals, color]) for (const value of attribute.array) expect(Number.isFinite(value)).toBe(true)
      expect(material.vertexColors).toBe(true); expect(material.userData.sharedCityAsset).toBe(true); expect(geometry.userData.sharedCityAsset).toBe(true)
      const bounds = geometry.boundingBox!
      expect(bounds.min.y).toBeCloseTo(0, 6)
      expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 6)
      expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0, 6)
      expect(bounds.getSize(new THREE.Vector3()).distanceTo(asset.size)).toBeLessThan(.00001)
      expect(asset.size.y / Math.max(asset.size.x, asset.size.z)).toBeGreaterThan(.6)
      const mesh = new THREE.Mesh(geometry, material), ray = new THREE.Raycaster()
      expect(asset.entrance).toBeDefined()
      expect(asset.entrance!.z).toBeCloseTo(bounds.max.z, 5)
      expect(Math.abs(asset.entrance!.x)).toBeLessThan(.05)
      ray.set(new THREE.Vector3(asset.entrance!.x, .2, asset.entrance!.z - .025), new THREE.Vector3(0, -1, 0))
      expect(ray.intersectObject(mesh)[0].point.y).toBeCloseTo(.05, 5)
      for (const [x, z] of [[0, 10], [0, -10], [10, 0], [-10, 0]]) {
        ray.set(new THREE.Vector3(x, .65, z), new THREE.Vector3(-x, 0, -z).normalize())
        expect(ray.intersectObject(mesh).length).toBeGreaterThan(0)
      }
      ray.set(new THREE.Vector3(0, .35, 10), new THREE.Vector3(0, 0, -1))
      expect(ray.intersectObject(mesh)[0].point.z).toBeGreaterThan(asset.size.z * .20)
    }
    expect(materials.size).toBe(1); expect(new Set(counts).size).toBe(3)
    for (const asset of assets) asset.parts[0].geometry.dispose()
    for (const material of materials) material.dispose()
  })
  it('recreates identical geometry and colors without random or external inputs', () => {
    const a = createWorkplaceAssets(), b = createWorkplaceAssets()
    for (let i = 0; i < a.length; i++) for (const key of ['position', 'normal', 'color']) expect(a[i].parts[0].geometry.getAttribute(key).array).toEqual(b[i].parts[0].geometry.getAttribute(key).array)
    for (const list of [a, b]) { for (const asset of list) asset.parts[0].geometry.dispose(); list[0].parts[0].material.dispose() }
  })
})
