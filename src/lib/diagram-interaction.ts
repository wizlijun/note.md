import type { CreateEditorOptions } from '@moraya/core'
import { i18n, t, type Locale } from './i18n/runtime.svelte'

type DiagramOptions = Exclude<CreateEditorOptions['diagramInteraction'], boolean | undefined>
const localized = new Map<Locale, DiagramOptions>()

/** Stable capability identity keeps core's lazy NodeView cache scoped correctly. */
export function desktopDiagramInteraction(): DiagramOptions {
  let options = localized.get(i18n.locale)
  if (!options) {
    options = { labels: {
      zoomIn: t('diagram.zoomIn'), zoomOut: t('diagram.zoomOut'),
      reset: t('diagram.reset'), fit: t('diagram.fit'),
      panLeft: t('diagram.panLeft'), panRight: t('diagram.panRight'),
      panUp: t('diagram.panUp'), panDown: t('diagram.panDown'),
      region: t('diagram.region'), hint: t('diagram.hint'),
      preview: t('diagram.preview'), edit: t('diagram.edit'), copy: t('diagram.copy'),
    } }
    localized.set(i18n.locale, options)
  }
  return options
}
