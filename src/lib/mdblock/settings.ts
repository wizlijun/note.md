import { settings } from '../settings.svelte'

export function isMdblockEnabled(): boolean {
  return settings.mdblock.enabled
}

export function isHoverEnabled(): boolean {
  return settings.mdblock.enabled && settings.mdblock.hover.enabled
}
