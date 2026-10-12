// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/svelte'
import GitTargetBar from './GitTargetBar.svelte'
afterEach(cleanup)
it('uses three persistent pressed buttons and disables Git for non-Git or annotation-only', async () => {
  const onSelect = vi.fn()
  const view = render(GitTargetBar, { props: { target: 'branch', git: true, hasEdits: true, onSelect } })
  expect(view.getByRole('button', { name: 'B · 创建分支' }).getAttribute('aria-pressed')).toBe('true')
  await fireEvent.click(view.getByRole('button', { name: 'C · 导出补丁' }))
  expect(onSelect).toHaveBeenCalledWith('patch')
  await view.rerender({ target: 'worktree', git: false, hasEdits: true, onSelect })
  expect((view.getByRole('button', { name: 'B · 创建分支' }) as HTMLButtonElement).disabled).toBe(true)
  await view.rerender({ target: 'worktree', git: true, hasEdits: false, onSelect })
  expect((view.getByRole('button', { name: 'C · 导出补丁' }) as HTMLButtonElement).disabled).toBe(true)
})
