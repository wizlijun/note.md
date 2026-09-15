/**
 * Format strict JSON by changing only whitespace between tokens.
 *
 * JSON.parse is used only as a validity gate. The formatter deliberately does
 * not stringify the parsed value, so large number spellings, duplicate keys,
 * escape sequences, key order, and string contents remain byte-for-byte intact.
 */
export function formatJsonSource(input: string): string | null {
  const MAX_SOURCE_CHARS = 32 * 1024 * 1024
  const MAX_OUTPUT_CHARS = 64 * 1024 * 1024
  const MAX_DEPTH = 128
  if (input.length > MAX_SOURCE_CHARS) return null
  const bom = input.startsWith('\uFEFF') ? '\uFEFF' : ''
  const source = bom ? input.slice(1) : input
  try {
    JSON.parse(source)
  } catch {
    return null
  }

  const indent = (depth: number) => '  '.repeat(depth)
  const nextToken = (from: number): string | undefined => {
    for (let index = from; index < source.length; index++) {
      if (!/\s/.test(source[index])) return source[index]
    }
    return undefined
  }

  let output = bom
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
    } else if (/\s/.test(char)) {
      continue
    } else if (char === '{' || char === '[') {
      output += char
      depth++
      if (depth > MAX_DEPTH) return null
      const closing = char === '{' ? '}' : ']'
      if (nextToken(index + 1) !== closing) output += `\n${indent(depth)}`
    } else if (char === '}' || char === ']') {
      depth--
      const opening = char === '}' ? '{' : '['
      let previous = index - 1
      while (previous >= 0 && /\s/.test(source[previous])) previous--
      if (source[previous] !== opening) output += `\n${indent(depth)}`
      output += char
    } else if (char === ',') {
      output += `,\n${indent(depth)}`
    } else if (char === ':') {
      output += ': '
    } else {
      output += char
    }
    if (output.length > MAX_OUTPUT_CHARS) return null
  }

  return `${output}\n`
}
