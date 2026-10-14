import { t } from '../i18n/runtime.svelte'
import { getCommonSlashItems, filterSlashItems as filterCommon, type SlashItem } from './slash-items-common'
export type { SlashItem } from './slash-items-common'

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif']
const DOC_EXTS   = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
                    'zip', 'gz', 'tar', 'rar', '7z',
                    'mp3', 'wav', 'ogg', 'flac',
                    'mp4', 'mov', 'avi', 'mkv', 'webm',
                    'txt', 'csv', 'json', 'xml']

export function getSlashItems(): SlashItem[] {
  const items = getCommonSlashItems()
  items.splice(3, 0,
  {
    id: 'insert-image',
    label: t('slash.image.label'),
    keywords: ['image', 'photo', '图片', '图像', 'picture', 'insert'],
    icon: 'img',
    desc: t('slash.image.desc'),
    execute: async (v) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({
        multiple: false,
        filters: [{ name: t('slash.filter.images'), extensions: IMAGE_EXTS }],
      })
      if (typeof result !== 'string') return
      const { insertImageAtCursor } = await import('../attachment-insert')
      insertImageAtCursor(v, result)
    },
  },
  {
    id: 'insert-doc',
    label: t('slash.doc.label'),
    keywords: ['document', 'file', 'attach', '文档', '文件', '附件'],
    icon: 'doc',
    desc: t('slash.doc.desc'),
    execute: async (v) => {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const result = await open({
        multiple: false,
        filters: [{ name: t('slash.filter.docs'), extensions: DOC_EXTS }],
      })
      if (typeof result !== 'string') return
      const { insertAttachmentLink } = await import('../attachment-insert')
      insertAttachmentLink(v, result)
    },
  },
  )
  return items
}
export function filterSlashItems(query: string): SlashItem[] { return filterCommon(query, getSlashItems()) }
