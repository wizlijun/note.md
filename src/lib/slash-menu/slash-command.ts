import {setBlock,wrapBlock,wrapList,insertAtom,insertTable,insertTaskList} from '../context-menu/block-helpers'
import {TextSelection,type EditorState,type Transaction} from 'prosemirror-state'
import type {FileSlashCommand} from '../../editor-kit-v2/file-contract'
export interface SlashCommandTarget {readonly state:EditorState;dispatch(tr:Transaction):void;focus():void}
// ── schema-aware helpers ──────────────────────────────────────────────────────

function insertSpreadsheetSync(v: SlashCommandTarget) {
  const { schema } = v.state
  const spreadsheet = schema.nodes.spreadsheet
  if (!spreadsheet) return false
  const defaultCsv = '列A,列B,列C\n,,\n,,\n,,'
  v.dispatch(
    v.state.tr
      .replaceSelectionWith(spreadsheet.create({ source: defaultCsv }))
      .scrollIntoView()
  )
  v.focus()
  return true
}

/** Wrap the selection (empty at the slash position) in literal delimiters and
 *  put the caret between them, matching how these marks are typed by hand. */
function wrapLiteral(v: SlashCommandTarget, prefix: string, suffix: string) {
  const { from, to } = v.state.selection
  const text = v.state.doc.textBetween(from, to) || ''
  const tr = v.state.tr.insertText(`${prefix}${text}${suffix}`, from, to)
  const caret = text ? from + prefix.length + text.length + suffix.length : from + prefix.length
  tr.setSelection(TextSelection.create(tr.doc, caret))
  v.dispatch(tr)
  v.focus()
  return true
}

export function runSlashCommand(v:SlashCommandTarget,id:FileSlashCommand):boolean {
 switch(id){
  case 'h1':return setBlock(v,'heading',{level:1})
  case 'h2':return setBlock(v,'heading',{level:2})
  case 'h3':return setBlock(v,'heading',{level:3})
  case 'quote':return wrapBlock(v,'blockquote')
  case 'code':return setBlock(v,'code_block',{language:''})
  case 'mermaid':return setBlock(v,'code_block',{language:'mermaid'})
  case 'math':return insertAtom(v,'math_block',{value:''})
  case 'table':return insertTable(v)
  case 'spreadsheet':return insertSpreadsheetSync(v)
  case 'bullet':return wrapList(v,'bullet_list')
  case 'ordered':return wrapList(v,'ordered_list')
  case 'task':return insertTaskList(v)
  case 'hr':return insertAtom(v,'horizontal_rule')
  case 'highlight':return wrapLiteral(v,'^^','^^')
  case 'wikilink':return wrapLiteral(v,'[[',']]')
  default:return false
 }
}
