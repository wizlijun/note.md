const EMPTY_GRID = (): string[][] => [['', '', ''], ['', '', ''], ['', '', '']]

export function parseCsv(text: string): string[][] {
  if (!text.trim()) return EMPTY_GRID()
  const rows: string[][] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    rows.push(parseLine(line))
  }
  return rows.length ? rows : EMPTY_GRID()
}

function parseLine(line: string): string[] {
  const cells: string[] = []
  let i = 0
  while (i <= line.length) {
    if (i === line.length) { cells.push(''); break }
    if (line[i] === '"') {
      let cell = ''
      i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2 }
        else if (line[i] === '"') { i++; break }
        else { cell += line[i++] }
      }
      cells.push(cell)
      if (line[i] === ',') i++
      else break
    } else {
      const end = line.indexOf(',', i)
      if (end === -1) { cells.push(line.slice(i)); break }
      cells.push(line.slice(i, end))
      i = end + 1
    }
  }
  return cells
}

export function serializeCsv(rows: string[][]): string {
  return rows.map(row => row.map(escapeCell).join(',')).join('\n')
}

function escapeCell(cell: string): string {
  if (cell.includes(',') || cell.includes('"') || cell.includes('\n')) {
    return '"' + cell.replace(/"/g, '""') + '"'
  }
  return cell
}
