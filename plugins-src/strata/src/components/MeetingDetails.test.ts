// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import fixture from '../../../knowledge-browser/fixtures/minimal-valid.json'
import MeetingDetails from './MeetingDetails.svelte'
import { adaptMeetingSnapshot } from '../lib/meetings'

let component: ReturnType<typeof mount> | undefined
afterEach(async () => { if (component) await unmount(component); component = undefined; document.body.innerHTML = ''; vi.unstubAllGlobals() })
it('retains limitations and saved evidence while opening only the chosen source ID', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const data = structuredClone(fixture); data.sources[0].title = '<img src=x onerror=alert(1)>'
  const content = JSON.stringify(data), contentHash = createHash('sha256').update(content).digest('hex')
  const result = await adaptMeetingSnapshot({ schema: 'notemd.strata/meetings/v1', vaultKey: 'v', datasetKey: 'meetings', snapshotId: 's', diagnostics: [],
    documents: [{ path: 'ssot/meetings/example/knowledge.json', contentHash, content, date: '2026-09-15', dateInferred: false }] }, { from: '2026-09-01', to: '2026-09-30' })
  const metadata = result.nodes.find(node => node.meeting.localId === 'q1')!.meeting, onopen = vi.fn()
  component = mount(MeetingDetails, { target: document.body, props: { metadata, onopen } }); await tick()
  expect(document.body.textContent).toContain('当前原文尚未核对')
  expect(document.body.textContent).toContain('规则有效期未说明')
  expect(document.body.textContent).toContain('候选（数据未声明审核状态）')
  expect(document.querySelector('img')).toBeNull(); expect(document.querySelector('a')).toBeNull()
  const buttons = [...document.querySelectorAll('button')]
  buttons.find(button => button.textContent === '打开来源')!.click()
  expect(onopen).toHaveBeenLastCalledWith('s1')
  buttons.find(button => button.textContent === '打开知识文件')!.click()
  expect(onopen).toHaveBeenLastCalledWith()
})
