export const activeTheme = $state<{ id: string }>({ id: 'default' })

export function setActiveTheme(id: string): void {
  activeTheme.id = id
}
