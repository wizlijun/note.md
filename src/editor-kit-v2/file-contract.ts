import type {CreateEditorOptions, SourceSession} from '@moraya/core'
import type {RootIdRow, TableImage} from '@moraya/core/source-history'
import type {DecorationHost, EditorCommand, StructuralCommand} from './contract'
export type {ObserverDelta} from '../lib/insights/observer'

export type FileAdapters = Pick<CreateEditorOptions,
 'mediaResolver'|'rendererRegistry'|'linkOpener'|'platform'|'spreadsheetViewFactory'|'frontmatterViewFactory'>
export type FileRender = Pick<CreateEditorOptions,'enableMath'|'enableMermaid'|'enableImageSelection'>
export type FilePolicy = Readonly<{acceptRawChange(before:string,after:string):boolean}>
export type FileSlashCommand = 'h1'|'h2'|'h3'|'quote'|'code'|'mermaid'|'math'|'table'|'spreadsheet'|'bullet'|'ordered'|'task'|'hr'|'highlight'|'wikilink'
export type FileBinding = RootIdRow
export type FileIds = {blockId():string;lineage():string;tableId():string}
export type FileState = Readonly<{
 session:SourceSession;bindings:readonly FileBinding[];sourceHash:string;sourceLineage:string
 layout:ReadonlyMap<string,TableImage>;authority:string;generation:number
}>
export type FileSnapshot = Readonly<{
 raw:string;sourceRevision:number;generation:number;authority:string
 sourceLineage:string;sourceHash:string;bindings:readonly FileBinding[]
}>
export type FileRecovery = Readonly<{v:1;sourceHash:string;sourceRevision:number;bindings:readonly FileBinding[]}>
export type FileInput = Readonly<{documentId:string;authority:string;raw:string;recovery?:FileRecovery}>
export type FileFailure = {ok:false;reason:string}
export type FileResult = {ok:true;changed:boolean;snapshot:FileSnapshot}|FileFailure
export interface FileEditorOwner {
 snapshot():FileSnapshot
 replaceSource(input:{expectedGeneration:number;value:string}):FileResult
 execute(command:EditorCommand|StructuralCommand):boolean
 canExecute(command:EditorCommand|StructuralCommand):boolean
 executeSlash(command:FileSlashCommand):boolean
 canExecuteSlash(command:FileSlashCommand):boolean
 undo():boolean;redo():boolean;canUndo():boolean;canRedo():boolean
 restoreContent(raw:string):FileResult
 installBaseline(input:FileInput,options?:{policy:FilePolicy|null}):FileResult
 setReadOnly(value:boolean):void
 flush():Promise<FileSnapshot>
 observe(listener:(value:FileSnapshot)=>void):()=>void
 close():Promise<void>
}
export interface MountFileEditorOptions {
 file:FileInput;readOnly?:boolean;placeholder?:string;ids?:FileIds
 onChange?:(value:FileSnapshot)=>void
 adapters?:FileAdapters;render?:FileRender;policy?:FilePolicy
}
export type MountedFileEditor = {
 owner:FileEditorOwner;setMode(mode:'rich'|'source'):Promise<boolean>
 focus():void;destroyView():void;decorations:DecorationHost
 annotations:{insert(seed?:string):boolean;editAt(position:number):boolean}
}
