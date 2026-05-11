export type SkinId = 'default' | 'effie'

export const SKINS: { id: SkinId; label: string; description: string }[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'GitHub-style sans-serif. Neutral and minimal.',
  },
  {
    id: 'effie',
    label: 'Effie（薄荷青）',
    description: '薄荷纸色 + 青绿色标题 + 蓝紫粗体 + 暖橙斜体，仿 Effie 写作软件配色。深色模式下保持原色。',
  },
]

const KNOWN_IDS = new Set<string>(SKINS.map((s) => s.id))

export function isValidSkinId(id: string): id is SkinId {
  return KNOWN_IDS.has(id)
}

export const skin = $state<{ current: SkinId }>({ current: 'default' })

export function setSkin(id: SkinId): void {
  skin.current = id
}
