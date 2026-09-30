/// <reference lib="webworker" />
import { buildAtlas } from './atlas'
import { TerrainEngine } from './terrain'
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './types-terrain'

let engine: TerrainEngine | undefined
const worker = self as unknown as DedicatedWorkerGlobalScope
worker.onmessage = (event: MessageEvent<TerrainWorkerRequest>) => {
  const request = event.data
  try {
    if (request.action === 'build') {
      if (!request.nodes || !request.epoch) throw new Error('地形布局缺少完整输入')
      engine = new TerrainEngine(buildAtlas(request.nodes, request.epoch, request.previousAtlas))
    }
    if (!engine) throw new Error('请先构建知识地形布局')
    const result = engine.render(request.selection, request.options)
    // The client already owns the stable atlas after build; dates only transfer geometry.
    const { layout, ...geometry } = result
    const response: TerrainWorkerResponse = { id: request.id, result: request.action === 'build' ? { ...geometry, layout } : geometry }
    worker.postMessage(response, [result.field.buffer, result.masses.buffer])
  } catch (error) {
    worker.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies TerrainWorkerResponse)
  }
}
