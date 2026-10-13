import type {Plugin} from 'prosemirror-state'
import {history} from 'prosemirror-history'
import {defaultSchema} from '@moraya/core/schema'
import {withBlockIdentitySchema} from './identity'
import type {ObserverDelta,FilePolicy} from './file-contract'
import {createFileController} from './file-controller'
export function testIds(){let n=0;return {blockId:()=>`b${++n}`,lineage:()=>`s${++n}`,tableId:()=>`t${++n}`}}
export function open(raw:string,plugins:Plugin[]=[],onDelta?:(d:ObserverDelta)=>void,policy?:FilePolicy){
 return createFileController({raw,authority:'snapshot-1',schema:withBlockIdentitySchema(defaultSchema),ids:testIds(),plugins:[...plugins,history()],onDelta,policy})
}
