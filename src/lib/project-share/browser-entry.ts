import { projectShareBrowser } from './browser'
import { scanOwnerAnnotations } from '../share-merge/critic'

export function start(parser: any, zipper?: any): Promise<void> {
  return projectShareBrowser(parser, zipper, scanOwnerAnnotations)
}
