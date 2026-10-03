import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createRusticAssets, type RusticAssetId } from './city-rustic-assets'
export { rusticHuts, rusticCabins } from './city-rustic-assets'

// Original CC0 Kenney models; provenance and checksums live in public/models/manifest.json.
export const houses = ['suburban/building-type-a', 'suburban/building-type-b', 'suburban/building-type-d', 'suburban/building-type-f', 'suburban/building-type-h', 'suburban/building-type-j', 'suburban/building-type-l', 'suburban/building-type-n', 'suburban/building-type-r'] as const
export const commercial = ['commercial/building-a', 'commercial/building-c', 'commercial/building-f', 'commercial/building-k', 'commercial/building-n', 'commercial/building-skyscraper-a', 'commercial/building-skyscraper-d'] as const
export const trees = ['nature/tree_detailed', 'nature/tree_oak', 'nature/tree_pineRoundD', 'nature/tree_pineTallA_detailed'] as const
export const tents = ['survival/tent', 'nature/tent_detailedOpen'] as const
export const props = ['suburban/planter', 'suburban/fence-low', 'nature/rock_largeA', 'nature/rock_smallB', 'nature/campfire_logs', 'nature/plant_bushDetailed', 'nature/flower_yellowA', 'nature/log_stack', 'survival/resource-wood', 'survival/box', 'survival/structure'] as const
export const cityAssetGroups = { houses, commercial, trees, tents, props }
export type CityAssetId = typeof houses[number] | typeof commercial[number] | typeof trees[number] | typeof tents[number] | typeof props[number] | RusticAssetId
export interface CityAssetPlacement { x: number; y: number; z: number; rotation: number; scale: number | THREE.Vector3; id?: string }
interface AssetPart { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] }
interface AssetModel { size: THREE.Vector3; parts: AssetPart[] }
// The source nature pack uses cyan foliage. Keep source GLBs intact and apply the
// same named-material palette on every load for a warm, readable knowledge city.
const naturePalette: Record<string, string> = {
  leafsGreen: '#648447', leafsDark: '#365c46', grass: '#7f9954',
  woodBark: '#79543b', woodBarkDark: '#604332', woodInner: '#c5a270',
  wood: '#a5744c', woodDark: '#76543a', dirt: '#8f8d78',
}

/** Owns shared model resources. Scene rebuilds dispose instances, never these geometries/materials. */
export class CityAssets {
  private models = new Map<CityAssetId, AssetModel>()
  private geometries = new Set<THREE.BufferGeometry>()
  private materials = new Set<THREE.Material>()
  private textures = new Set<THREE.Texture>()
  private disposed = false

  static async load(): Promise<CityAssets> {
    const assets = new CityAssets()
    const loader = new GLTFLoader()
    for (const model of createRusticAssets()) {
      assets.models.set(model.id, model)
      for (const part of model.parts) {
        assets.geometries.add(part.geometry)
        assets.materials.add(part.material)
      }
    }
    // Relative to the plugin document, including plugin:// and embedded host UI routes.
    const results = await Promise.allSettled(Object.values(cityAssetGroups).flat().map(async id => {
      const gltf = await loader.loadAsync(new URL(`models/${id}.glb`, document.baseURI).href)
      // Survival Kit splits the tent frame and fabric into separate aligned assets.
      if (id === 'survival/tent') {
        const canvas = await loader.loadAsync(new URL('models/survival/tent-canvas.glb', document.baseURI).href)
        gltf.scene.add(canvas.scene)
      }
      gltf.scene.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(gltf.scene)
      const center = bounds.getCenter(new THREE.Vector3())
      const offset = new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z)
      const parts: AssetPart[] = []
      const originals = new Set<THREE.BufferGeometry>()
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        originals.add(object.geometry)
        const geometry = object.geometry.clone()
        geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(offset, object.matrixWorld))
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()
        geometry.userData.sharedCityAsset = true
        assets.geometries.add(geometry)
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          material.userData.sharedCityAsset = true
          if (material instanceof THREE.MeshStandardMaterial) {
            material.roughness = 1; material.metalness = 0
            if (id.startsWith('nature/') && naturePalette[material.name]) material.color.set(naturePalette[material.name])
          }
          assets.materials.add(material)
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) assets.textures.add(value)
        }
        parts.push({ geometry, material: object.material })
      })
      for (const geometry of originals) geometry.dispose()
      if (!parts.length) throw new Error(`城市模型没有可用网格：${id}`)
      assets.models.set(id, { size: bounds.getSize(new THREE.Vector3()), parts })
    }))
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) { assets.dispose(); throw new Error(`城市模型加载失败：${String(failed.reason)}`) }
    return assets
  }

  size(assetId: CityAssetId): THREE.Vector3 { return this.model(assetId).size.clone() }

  instantiate(assetId: CityAssetId, placements: readonly CityAssetPlacement[]): THREE.InstancedMesh[] {
    const model = this.model(assetId)
    if (!placements.length) return []
    const transform = new THREE.Object3D()
    return model.parts.map(part => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, placements.length)
      mesh.name = assetId
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.ids = placements.map(placement => placement.id ?? null)
      mesh.userData.cityAsset = assetId
      placements.forEach((placement, index) => {
        transform.position.set(placement.x, placement.y, placement.z)
        transform.rotation.set(0, placement.rotation, 0)
        if (typeof placement.scale === 'number') transform.scale.setScalar(placement.scale)
        else transform.scale.copy(placement.scale)
        transform.updateMatrix()
        mesh.setMatrixAt(index, transform.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      return mesh
    })
  }

  private model(assetId: CityAssetId): AssetModel {
    const model = this.models.get(assetId)
    if (this.disposed || !model) throw new Error(`城市模型不可用：${assetId}`)
    return model
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const geometry of this.geometries) geometry.dispose()
    for (const material of this.materials) material.dispose()
    for (const texture of this.textures) texture.dispose()
    this.models.clear(); this.geometries.clear(); this.materials.clear(); this.textures.clear()
  }
}
