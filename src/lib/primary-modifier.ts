import { isApplePlatformSync } from './platform-sync'

/** The application modifier; Super remains available to the Linux desktop. */
export function hasPrimaryModifier(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatformSync() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
