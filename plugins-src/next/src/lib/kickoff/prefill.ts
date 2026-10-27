import type { KickoffPayload } from './payload'
import type { KickoffAnswer } from './document'

export type CommitFields = 'commitment' | 'next_action' | 'close_condition'

export type InitialCommit = Partial<Record<CommitFields, string>>

export type ExtraOptions = Partial<Record<CommitFields, string[]>>

export function commitPrefill(payload: KickoffPayload, answers: KickoffAnswer[]): {
  initialCommit: InitialCommit
  extraOptions: ExtraOptions
} {
  const initialCommit: InitialCommit = {}, extraOptions: ExtraOptions = {}
  for(const field of ['commitment', 'next_action', 'close_condition'] as const) {
    const questions = payload.questions.filter(q => q.decides === field)
    for(const q of questions) {
      const answer = answers.find(a => a.question_id === q.id)
      if(!answer)
        continue
      const value = answer.option_id === null ? answer.answer.trim() : q.options.find(o => o.id === answer.option_id)?.label.trim()
      // Saved selected answers may also contain an explicit free-text override.
      const selected = q.options.find(o => o.id === answer.option_id)
      const free = answer.answer.trim() && answer.answer.trim() !== selected?.label.trim() ? answer.answer.trim() : undefined
      if(free || value) {
        initialCommit[field] = free || value
        break
      }
    }
    const suggestion = payload.suggestions[field]?.trim()
    if(!initialCommit[field] && suggestion)
      initialCommit[field] = suggestion
    const options = questions.flatMap(q => q.options.filter(o => o.id !== answers.find(a => a.question_id === q.id)?.option_id).map(o => o.label.trim()))
    if(suggestion)
      options.push(suggestion)
    extraOptions[field] = [...new Set(options.filter(Boolean))].slice(0, 4)
  }
  return {
    initialCommit,
    extraOptions
  }
}
