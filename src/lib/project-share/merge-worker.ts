import { anchor, propose, type AnchorResult, type MergeInput, type MergeProposal, type TextSelector } from '../share-merge'

export interface IndexedSelector { index: number; selector: TextSelector }
export interface LocatedAnnotation { index: number; result: AnchorResult }
export type MergeWorkerRequest =
  | { id: number; op: 'proposal'; input: MergeInput }
  | { id: number; op: 'anchors'; text: string; selectors: IndexedSelector[] }
  | { op: 'cancel'; requestId: number }
export type MergeWorkerReply = { id: number; proposal: MergeProposal } | { id: number; anchors: LocatedAnnotation[] } | { id: number; error: string }

const scope = self as unknown as { onmessage: (event: { data: MergeWorkerRequest }) => Promise<void>; postMessage(reply: MergeWorkerReply): void }
const cancelled = new Set<number>()
const running = new Set<number>()
scope.onmessage = async ({ data }) => {
  if (data.op === 'cancel') { if (running.has(data.requestId)) cancelled.add(data.requestId); return }
  const { id } = data
  running.add(id)
  try {
    if (data.op === 'proposal') scope.postMessage({ id, proposal: propose(data.input) })
    else {
      const anchors: LocatedAnnotation[] = []
      for (const { index, selector } of data.selectors) {
        if (cancelled.has(id)) return
        anchors.push({ index, result: anchor(data.text, selector) })
        // Give cancelled batches and newer messages a turn between costly anchors.
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
      if (!cancelled.has(id)) scope.postMessage({ id, anchors })
    }
  } catch (error) { if (!cancelled.has(id)) scope.postMessage({ id, error: String(error) }) }
  finally { running.delete(id); cancelled.delete(id) }
}
