import type { SpreadsheetViewFactory } from '@moraya/core'
import { mount, unmount } from 'svelte'
import MiniSpreadsheet from '../spreadsheet/MiniSpreadsheet.svelte'

export const spreadsheetFactory: SpreadsheetViewFactory = {
  create(container, source, onChange) {
    const app = mount(MiniSpreadsheet, {
      target: container,
      props: { csvSource: source, onChange },
    })
    return {
      destroy() {
        try { unmount(app) } catch { /* ignore */ }
      },
    }
  },
}
