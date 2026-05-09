export type SkinId = 'default' | 'shuyuan'

export const SKINS: { id: SkinId; label: string; description: string }[] = [
  {
    id: 'default',
    label: 'Default',
    description: 'GitHub-style sans-serif. Neutral and minimal.',
  },
  {
    id: 'shuyuan',
    label: '书苑（中文优化）',
    description: '思源宋体正文 + 思源黑体标题，仿现代中文书籍排版，含首行缩进与楷体引文。',
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
