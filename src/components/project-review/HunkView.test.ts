// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render} from '@testing-library/svelte'
import {propose} from '../../lib/share-merge'
import {t} from '../../lib/i18n/store.svelte'
import HunkView from './HunkView.svelte'
afterEach(cleanup)
it('guest conflict directly commits three choices without risk confirmation or concatenation',async()=>{
 const hunk=propose({path:'a.md',base:'甲。',ours:'乙。',theirs:'丙。\u202e'}).hunks[0],onDecide=vi.fn()
 const v=render(HunkView,{hunk,mode:'guest',onDecide})
 expect(v.getAllByRole('button')).toHaveLength(3)
 await fireEvent.click(v.getByRole('button',{name:t('guest.myVersion')}));expect(onDecide).toHaveBeenCalledWith(hunk.id,{kind:'conflict',choice:'theirs'})
 expect(v.container.textContent).not.toContain('接受风险');expect(v.container.textContent).not.toContain('原件后接建议')
})
it('guest diff labels both heading and accessible description',()=>{
 const hunk=propose({path:'a.md',base:'甲。',ours:'乙。',theirs:'甲。'}).hunks[0]
 const v=render(HunkView,{hunk,mode:'guest',onDecide:vi.fn()})
 expect(v.getByLabelText(`${t('guest.publisherVersion')}到${t('guest.myVersion')}的完整差异`)).toBeTruthy()
})
