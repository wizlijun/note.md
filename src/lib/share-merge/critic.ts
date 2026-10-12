import { makeSelector } from './anchor'
import type { ExtractResult } from './types'

export interface OwnerAnnotation {
  start: number
  end: number
  raw: string
  quote: string
  comment: string
}

// Raw CriticMarkup ranges only; extraction and ownership matching live separately.
export function scanOwnerAnnotations(text: string): OwnerAnnotation[] {
  const groups: { start: number; end: number; open: string; valid: boolean }[] = []
  const stack: { start: number; open: string; valid: boolean }[] = []
  // Scan delimiters once so malformed repeated openers cannot cause regex
  // backtracking over the remaining document for every opener.
  for (const match of text.matchAll(/\{==|==\}|\{>>|<<\}/g)) {
    let slashes = 0
    for (let i = match.index - 1; i >= 0 && text[i] === '\\'; i--) slashes++
    if (slashes % 2) continue
    const marker = match[0]
    if (marker === '{==' || marker === '{>>') {
      if (stack.length) stack[stack.length - 1].valid = false
      stack.push({ start: match.index, open: marker, valid: true })
    } else if (stack.length) {
      const top = stack[stack.length - 1]
      if (marker !== (top.open === '{==' ? '==}' : '<<}')) { top.valid = false; continue }
      stack.pop()
      if (!stack.length) groups.push({ ...top, end: match.index + marker.length })
    }
  }
  const annotations: OwnerAnnotation[] = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]
    let comment = group
    let quote = ''
    if (group.open === '{==') {
      const next = groups[i + 1]
      if (!next || next.open !== '{>>' || next.start !== group.end) continue
      comment = next
      quote = text.slice(group.start + 3, group.end - 3)
      i++
    }
    if (!group.valid || !comment.valid) continue
    annotations.push({ start: group.start, end: comment.end, raw: text.slice(group.start, comment.end),
      quote, comment: text.slice(comment.start + 3, comment.end - 3) })
  }
  return annotations
}

export function extractGuestAnnotations(input: { base: string; draft: string }): ExtractResult {
  const owners = scanOwnerAnnotations(input.base)
  const remaining = new Map<string, number>()
  for (const owner of owners) remaining.set(owner.raw, (remaining.get(owner.raw) ?? 0) + 1)
  const pieces: string[] = []
  const guests: { start: number; end: number; comment: string }[] = []
  let cursor = 0
  let length = 0
  for (const annotation of scanOwnerAnnotations(input.draft)) {
    const before = input.draft.slice(cursor, annotation.start)
    pieces.push(before)
    length += before.length
    const count = remaining.get(annotation.raw) ?? 0
    if (count) {
      remaining.set(annotation.raw, count - 1)
      pieces.push(annotation.raw)
      length += annotation.raw.length
    } else {
      guests.push({ start: length, end: length + annotation.quote.length, comment: annotation.comment })
      pieces.push(annotation.quote)
      length += annotation.quote.length
    }
    cursor = annotation.end
  }
  pieces.push(input.draft.slice(cursor))
  const clean = pieces.join('')
  const ownerAnnotationsTouched: string[] = []
  for (const owner of owners) {
    const count = remaining.get(owner.raw) ?? 0
    if (count) {
      ownerAnnotationsTouched.push(owner.raw)
      remaining.set(owner.raw, count - 1)
    }
  }
  return { clean, annotations: guests.map(guest => ({
    selector: makeSelector(clean, guest.start, guest.end), comment: guest.comment, kind: 'comment',
  })), ownerAnnotationsTouched }
}
