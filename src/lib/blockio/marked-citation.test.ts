import { describe, it, expect } from 'vitest'
import { Marked } from 'marked'
import { blockCitationExtension } from './marked-citation'

describe('blockCitationExtension', () => {
  it('renders a citation as a clickable pill', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('see ((doc.md#b-7f3a9c)) here') as string
    expect(html).toContain('class="block-citation"')
    expect(html).toContain('data-blockid="b-7f3a9c"')
    expect(html).toContain('data-pageuri="doc.md"')
  })

  it('handles same-document citation', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('jump ((#b-aaaaaa))') as string
    expect(html).toContain('data-pageuri=""')
    expect(html).toContain('data-blockid="b-aaaaaa"')
  })

  it('does not match malformed citations', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('not ((doc.md#wrong)) cited') as string
    expect(html).not.toContain('class="block-citation"')
    expect(html).toContain('((doc.md#wrong))')
  })

  it('escapes pageuri to prevent XSS', () => {
    const m = new Marked({ extensions: [blockCitationExtension] })
    const html = m.parse('((evil"<script>x</script>#b-aaaaaa))') as string
    // The whole match shouldn't have raw < or >
    expect(html).not.toContain('<script>')
  })
})
