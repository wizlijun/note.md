export interface ProjectedLot {
  node: { id: string; nodeType: string; evidence?: string[] }
  x: number
  z: number
  zone?: string
  style?: string
}

/** Smooth, stable visual projection: the square spiral remains untouched in the snapshot. */
export function visualPoint(x: number, z: number) {
  return { x: x + 3.1 * Math.sin(z / 17) + 1.4 * Math.sin((x + z) / 29), z: z + 2.8 * Math.sin(x / 19) + 1.1 * Math.sin((x - z) / 25) }
}
