import {Plugin,type SelectionBookmark} from 'prosemirror-state'
import {Decoration,DecorationSet,type EditorView} from 'prosemirror-view'
import {createSessionTableView,type SessionTablePainter} from '@moraya/core/plugins/session-table-view'
import type {FileController} from './file-controller'

/** The same pointer producer and upstream TableView adapter serve both hosts. */
export function createFileResize(controller:()=>FileController,richInput?:{composing():boolean;observe(listener:()=>void):()=>void}){
 const writable=()=>controller().writable()&&!richInput?.composing()
 const painters=new Set<SessionTablePainter>()
 type Gesture={pointerId:number;target:HTMLElement;tableId:string;generation:number;columns:number;column:number;beforeWidths:readonly(number|null)[];startWidth:number;startX:number;afterWidth:number;bookmark:SelectionBookmark;painter:SessionTablePainter}
 let gesture:Gesture|null=null,view:EditorView|null=null,refreshing=false
 const repaint=()=>{const c=controller();for(const p of painters){const pos=p.getPos();p.paint(pos===undefined?null:c.readTable(pos)?.widths??null)}}
 function finish(){const saved=gesture;gesture=null;if(saved){try{saved.target.releasePointerCapture(saved.pointerId)}catch{/* Capture may already be lost. */}}view?.dom.classList.remove('resize-cursor');return saved}
 function cancel(){finish();repaint()}
 const nodeView=createSessionTableView({
  readWidths:(position,node)=>position===undefined?null:(controller().readTable(position)?.columns===node.firstChild?.childCount?controller().readTable(position)!.widths:null),
  register:p=>{painters.add(p);return ()=>{if(gesture?.painter===p)cancel();painters.delete(p)}},
 })
 const plugin=new Plugin({
  props:{
   decorations(state){
    if(!writable())return null
    const widgets:Decoration[]=[]
    state.doc.descendants((node,pos)=>{
     if(node.type.name!=='table'||!controller().readTable(pos))return true
     let rowPos=pos+1
     node.forEach(row=>{let cellPos=rowPos+1;row.forEach(cell=>{
      widgets.push(Decoration.widget(cellPos+cell.nodeSize-1,()=>{const span=document.createElement('span');span.className='column-resize-handle';span.contentEditable='false';span.setAttribute('aria-hidden','true');return span},{side:-1,key:`file-width:${cellPos}`}))
      cellPos+=cell.nodeSize
     });rowPos+=row.nodeSize})
     return false
    })
    return DecorationSet.create(state.doc,widgets)
   },
   handleDOMEvents:{
    pointerdown(editor,event){
     const c=controller(),target=event.target
     if(gesture||!writable()||!event.isPrimary||event.button!==0||!(target instanceof HTMLElement)||!target.classList.contains('column-resize-handle'))return false
     const cell=target.closest('td,th');if(!cell)return false
     const position=editor.posAtDOM(cell,0),resolved=editor.state.doc.resolve(position)
     let depth=resolved.depth;while(depth>0&&resolved.node(depth).type.name!=='table')depth--
     if(!depth)return false
     const table=c.readTable(resolved.before(depth)),column=resolved.index(depth+1),painter=[...painters].find(p=>p.getPos()===table?.position),width=cell.getBoundingClientRect().width
     if(!table||!painter||column>=table.columns||!Number.isFinite(width)||width<=0)return false
     gesture={pointerId:event.pointerId,target,tableId:table.id,generation:c.snapshot().generation,columns:table.columns,column,beforeWidths:table.widths,startWidth:width,startX:event.clientX,afterWidth:width,bookmark:editor.state.selection.getBookmark(),painter}
     try{target.setPointerCapture(event.pointerId)}catch{gesture=null;return false}
     editor.dom.classList.add('resize-cursor');event.preventDefault();return true
    },
    pointermove(_editor,event){
     const g=gesture;if(!g||event.pointerId!==g.pointerId)return false
     const width=Math.max(25,g.startWidth+event.clientX-g.startX);if(!Number.isFinite(width))return true
     g.afterWidth=width;const widths=[...g.beforeWidths];widths[g.column]=width;g.painter.paint(widths);event.preventDefault();return true
    },
    pointerup(editor,event){
     if(!gesture||event.pointerId!==gesture.pointerId)return false
     const g=finish()!,c=controller(),table=[...c.readLayout()].find(([id])=>id===g.tableId)?.[1]
     if(!writable()||c.snapshot().generation!==g.generation||table?.columns!==g.columns||g.afterWidth===g.startWidth){repaint();return true}
     const widths=[...g.beforeWidths];widths[g.column]=g.afterWidth
     if(c.commitWidth({generation:g.generation,tableId:g.tableId,beforeWidths:g.beforeWidths,afterWidths:widths})){
      const selection=g.bookmark.resolve(c.state.doc);if(!selection.eq(c.state.selection))c.dispatch(c.state.tr.setSelection(selection))
     }
     repaint();event.preventDefault();return true
    },
    pointercancel(_editor,event){if(gesture?.pointerId!==event.pointerId)return false;cancel();return true},
    lostpointercapture(_editor,event){if(gesture?.pointerId!==event.pointerId)return false;cancel();return true},
    keydown(_editor,event){if(event.key!=='Escape'||!gesture)return false;cancel();event.preventDefault();return true},
    blur(){if(gesture)cancel();return false},
   },
  },
  view(editor){
   view=editor
   let wasWritable=writable()
   const refresh=()=>{
    const c=controller();if(gesture&&(!writable()||!c.view||c.snapshot().generation!==gesture.generation))cancel()
    repaint()
    const available=writable()
    if(available!==wasWritable&&!refreshing){wasWritable=available;refreshing=true;try{editor.updateState(c.state)}finally{refreshing=false}}
   }
   const dispose=controller().observeView(refresh),disposeRich=richInput?.observe(refresh),blur=()=>{if(gesture)cancel()}
   const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture){cancel();event.preventDefault()}}
   window.addEventListener('blur',blur);window.addEventListener('keydown',escape)
   return {update(){repaint()},destroy(){cancel();dispose();disposeRich?.();window.removeEventListener('blur',blur);window.removeEventListener('keydown',escape);view=null}}
  },
 })
 return {plugin,nodeView}
}
