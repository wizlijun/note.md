import type { ExplosionConfig, PresetId } from './types'

export type PresetParams = Omit<ExplosionConfig, 'imageList'> & { frameCount: number }

/**
 * 四个预设的参数,逐字来自 ~/git/obsidian-power-mode/src/presets/explosion/。
 * 素材路径不在这里:见 `presetConfig`。
 */
export const PRESET_PARAMS: Record<PresetId, PresetParams> = {
  particle: {
    maxExplosions: 3, size: 10, frequency: 1, explosionOrder: 'random',
    gifMode: 'continue', duration: 400, offset: 0.25, backgroundMode: 'mask', frameCount: 8,
  },
  lightning: {
    maxExplosions: 15, size: 15, frequency: 2, explosionOrder: 'sequential',
    gifMode: 'restart', duration: 1000, offset: 0.2, backgroundMode: 'image', frameCount: 3,
    customStyle: { mixBlendMode: 'color-dodge' },
  },
  coin: {
    maxExplosions: 5, size: 8, frequency: 4, explosionOrder: 'random',
    gifMode: 'restart', duration: 1500, offset: 0.66, backgroundMode: 'image', frameCount: 1,
  },
  confetti: {
    maxExplosions: 5, size: 26, frequency: 3, explosionOrder: 'random',
    gifMode: 'restart', duration: 1200, offset: 0.32, backgroundMode: 'image', frameCount: 1,
  },
}

// Image bytes belong to the installed Power Mode plugin, never the host bundle.
export { assetBase } from './assets'
import { assetBase } from './assets'

/** 预设参数 + 素材路径 = 可直接喂给 exploder 的配置。 */
export function presetConfig(id: PresetId, base: string | null = assetBase()): ExplosionConfig {
  const { frameCount, ...rest } = PRESET_PARAMS[id]
  return {
    ...rest,
    imageList: base ? Array.from({ length: frameCount }, (_, i) => `${base}${id}/${i + 1}.gif`) : [],
  }
}
