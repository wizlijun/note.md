import { applySourceTextTransaction, createSourceSession, type SourceSession } from '@moraya/core'
import { Slice, type Node as PmNode } from 'prosemirror-model'
import { EditorState, Plugin, PluginKey, type Transaction } from 'prosemirror-state'
import { withoutBlockIdentity } from './identity'

const capabilityError = () => new Error('EDITOR_KIT_V2_SOURCE_FIDELITY: this experimental mode supports only mapped paragraph text replacements')
export { capabilityError as sourceFidelityError }

function contentDoc(doc: PmNode): PmNode {
  return doc.copy(withoutBlockIdentity(new Slice(doc.content, 0, 0)).content)
}

/** Prepared results are transaction-local; only Plugin.state.apply commits one. */
export function createSourceFidelity(source: string, doc: PmNode) {
  const initial = createSourceSession(source, doc.type.schema)
  if (!initial.ok || !initial.session.doc.eq(contentDoc(doc))) throw capabilityError()
  const key = new PluginKey<SourceSession>('notemd-source-fidelity')
  type Prepared = { base: SourceSession; next: SourceSession; doc: PmNode; steps: string }
  const prepared = new WeakMap<Transaction, Prepared>()
  const stepsKey = (tr: Transaction) => JSON.stringify(tr.steps.map(step => step.toJSON()))
  const plugin = new Plugin<SourceSession>({
    key,
    state: {
      init: () => initial.session,
      apply(tr, base) {
        if (!tr.docChanged) return base
        const candidate = prepared.get(tr)
        if (!candidate || candidate.base !== base || candidate.base.revision !== base.revision
          || candidate.doc !== tr.doc || candidate.steps !== stepsKey(tr)) throw capabilityError()
        return candidate.next
      },
    },
  })
  return {
    plugin,
    source(state: EditorState) { return key.getState(state)!.source },
    prepare(tr: Transaction, state: EditorState): boolean {
      if (tr.storedMarksSet) return false
      if (!tr.docChanged) return true
      const base = key.getState(state)!
      if (!contentDoc(tr.before).eq(base.doc)) return false
      // Keep original step order and coordinates. Block/identity/mark steps are
      // rejected by the core slice contract, never serialized as a fallback.
      const replay = EditorState.create({ doc: base.doc }).tr
      try { for (const step of tr.steps) replay.step(step) } catch { return false }
      if (!replay.doc.eq(contentDoc(tr.doc))) return false
      const result = applySourceTextTransaction(base, replay)
      if (!result.ok) return false
      prepared.set(tr, { base, next: result.session, doc: tr.doc, steps: stepsKey(tr) })
      return true
    },
  }
}
