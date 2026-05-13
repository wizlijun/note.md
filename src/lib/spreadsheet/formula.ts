export function evaluateGrid(grid: string[][]): string[][] {
  return grid.map((row, ri) =>
    row.map((cell, ci) => evaluateCell(cell, grid, ri, ci))
  )
}

function evaluateCell(cell: string, grid: string[][], _row: number, _col: number): string {
  if (!cell.startsWith('=')) return cell
  try {
    const expr = resolveRefs(cell.slice(1), grid)
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expr})`)()
    if (result === null || result === undefined || (typeof result === 'number' && isNaN(result))) {
      return '#ERR'
    }
    if (typeof result === 'number') {
      return String(parseFloat(result.toFixed(10)))
    }
    return String(result)
  } catch {
    return '#ERR'
  }
}

function resolveRefs(expr: string, grid: string[][]): string {
  let out = expr
  out = out.replace(/\bSUM\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) => {
    const vals = rangeVals(s, e, grid)
    return String(vals.reduce((a, b) => a + b, 0))
  })
  out = out.replace(/\bAVG\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) => {
    const vals = rangeVals(s, e, grid)
    return vals.length ? String(vals.reduce((a, b) => a + b, 0) / vals.length) : '0'
  })
  out = out.replace(/\bCOUNT\(([A-Z]+\d+):([A-Z]+\d+)\)/gi, (_, s, e) =>
    String(rangeVals(s, e, grid).length)
  )
  out = out.replace(/\b([A-Z]+)(\d+)\b/gi, (_, col, row) => {
    const ci = colIdx(col)
    const ri = parseInt(row) - 1
    const val = grid[ri]?.[ci] ?? ''
    if (val.startsWith('=')) return '0'
    const n = parseFloat(val)
    return isNaN(n) ? '0' : String(n)
  })
  return out
}

function colIdx(col: string): number {
  return col.toUpperCase().charCodeAt(0) - 65
}

function parseRef(ref: string): [number, number] {
  const m = ref.match(/^([A-Z]+)(\d+)$/i)!
  return [parseInt(m[2]) - 1, colIdx(m[1])]
}

function rangeVals(start: string, end: string, grid: string[][]): number[] {
  const [sr, sc] = parseRef(start)
  const [er, ec] = parseRef(end)
  const vals: number[] = []
  for (let r = sr; r <= er; r++) {
    for (let c = sc; c <= ec; c++) {
      const v = grid[r]?.[c] ?? ''
      const n = parseFloat(v)
      if (!isNaN(n)) vals.push(n)
    }
  }
  return vals
}
