/// <reference lib="webworker" />
import { parseKnowledgeDataset } from './parser'

interface ParseRequest { id: number; source: string; uri: string }

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, source, uri } = event.data
  void parseKnowledgeDataset(source, uri).then(
    result => self.postMessage({ id, result }),
    error => self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
  )
}
