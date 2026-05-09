import { platform as tauriPlatform } from '@tauri-apps/plugin-os'

export type Platform = 'macos' | 'ios' | 'unknown'
export type FormFactor = 'desktop' | 'tablet' | 'phone'

let cached: Platform | null = null

export async function platform(): Promise<Platform> {
  if (cached) return cached
  const p = await tauriPlatform()
  cached = p === 'macos' || p === 'ios' ? (p as Platform) : 'unknown'
  return cached
}

export const isIOS = async () => (await platform()) === 'ios'
export const isMacOS = async () => (await platform()) === 'macos'

/** test-only escape hatch */
export function _resetCacheForTests() {
  cached = null
}

/** Reactive form-factor signal. Initialized by `initFormFactor()` in main.ts. */
export const formFactor = $state<{ value: FormFactor }>({ value: 'desktop' })

export async function initFormFactor(): Promise<void> {
  const p = await platform()
  const compute = () => {
    if (p !== 'ios') return 'desktop' as FormFactor
    return window.innerWidth < 768 ? 'phone' : 'tablet'
  }
  formFactor.value = compute()
  if (p === 'ios') {
    window.addEventListener('resize', () => {
      formFactor.value = compute()
    })
  }
}
