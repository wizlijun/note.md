import { Plugin } from 'prosemirror-state'
import { AddMarkStep, RemoveMarkStep, type Step } from 'prosemirror-transform'
import type { Transaction } from 'prosemirror-state'

export interface ObserverDelta {
  markOps: number
  sizeDelta: number
}

/** Number of add/remove-mark steps in a transaction's step list. */
export function countMarkSteps(steps: readonly Step[]): number {
  let n = 0
  for (const s of steps) {
    if (s instanceof AddMarkStep || s instanceof RemoveMarkStep) n++
  }
  return n
}

/**
 * A passive ProseMirror plugin. On every applied transaction that changed the
 * document it calls `onDelta` with the mark-op count and the net change in doc
 * size (content length in PM units, a good proxy for characters). Never mutates
 * state; returns no decorations.
 */
export function analyticsObserverPlugin(onDelta: (d: ObserverDelta) => void): Plugin {
  return new Plugin({
    appendTransaction(transactions: readonly Transaction[], oldState, newState) {
      if (!transactions.some((t) => t.docChanged)) return null
      let markOps = 0
      for (const t of transactions) markOps += countMarkSteps(t.steps)
      const sizeDelta = newState.doc.content.size - oldState.doc.content.size
      onDelta({ markOps, sizeDelta })
      return null
    },
  })
}
