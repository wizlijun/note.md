import type { ContourMultiPolygon } from 'd3-contour'

/** D3 coordinates are cell centres, in grid units. Keep rings and holes intact. */
export function traceContour(context: CanvasRenderingContext2D | Path2D, contour: ContourMultiPolygon): void {
  for (const polygon of contour.coordinates) for (const ring of polygon) {
    if (!ring.length) continue
    context.moveTo(ring[0][0], ring[0][1])
    for (let i = 1; i < ring.length; i++) context.lineTo(ring[i][0], ring[i][1])
    context.closePath()
  }
}

export const elevation = (height: number): number => .24 * Math.log1p(Math.max(0, height) / .012)
