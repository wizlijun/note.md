/// <reference lib="webworker" />
import { adaptMeetingSnapshot } from './meetings'
import type { MeetingSnapshotInput } from './meetings'
import type { DateRange } from './types'

self.onmessage = (event: MessageEvent<{ input: MeetingSnapshotInput; range: DateRange }>) => {
  void adaptMeetingSnapshot(event.data.input, event.data.range).then(
    result => self.postMessage({ result }),
    error => self.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  )
}
