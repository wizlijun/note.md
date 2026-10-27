import { expect, it } from 'vitest'
import { commitPrefill } from './prefill'
import type { KickoffPayload } from './payload'
import type { KickoffAnswer } from './document'
const option = (id: string, label: string) => ({
  id, label, recommended: false, why: '', source_ids: []
})
const payload = {
  questions: [{
      id: 'q1', decides: 'commitment', options: [option('a', 'A'), option('b', 'B'), option('c', 'C'), option('d', 'D')]
    }, {
      id: 'q2', decides: 'commitment', options: [option('a', 'A'), option('b', 'E'), option('c', 'F')]
    }], suggestions: {
    commitment: 'S', next_action: 'next', close_condition: ''
  }
} as unknown as KickoffPayload
const answer = (question_id: string, option_id: string | null, answer: string) => ({
  question_id, option_id, answer
}) as KickoffAnswer
it('chooses earliest answered question regardless of answer ordering', () => expect(commitPrefill(payload, [answer('q2', 'b', 'E'), answer('q1', 'a', 'A')]).initialCommit.commitment).toBe('A'))
it('prefers free text over option', () => expect(commitPrefill(payload, [answer('q1', 'a', 'my text')]).initialCommit.commitment).toBe('my text'))
it('falls back to suggestions then undefined defaults', () => expect(commitPrefill(payload, []).initialCommit).toEqual({
  commitment: 'S', next_action: 'next'
}))
it('skips empty answers', () => expect(commitPrefill(payload, [answer('q1', null, '  '), answer('q2', 'b', 'E')]).initialCommit.commitment).toBe('E'))
it('deduplicates unselected candidates and caps at four', () => expect(commitPrefill(payload, [answer('q1', 'a', 'A')]).extraOptions.commitment).toEqual(['B', 'C', 'D', 'A']))
it('includes suggestion as candidate', () => expect(commitPrefill({
  ...payload, questions: []
}, []).extraOptions.commitment).toEqual(['S']))
