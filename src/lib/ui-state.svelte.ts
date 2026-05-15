/**
 * App-level UI state shared between App.svelte and command modules.
 * Hoisted so commands.ts can dispatch 'preferences' without prop-drilling.
 */
export const uiState = $state<{ showSettings: boolean }>({ showSettings: false })

export function openSettings() { uiState.showSettings = true }
export function closeSettings() { uiState.showSettings = false }
