// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {cleanup,fireEvent,render} from '@testing-library/svelte'
import {propose} from '../../lib/share-merge'
import { t } from '../../lib/i18n/store.svelte'
import ConflictEditor from './ConflictEditor.svelte'
afterEach(cleanup)
it('guest exposes exactly three real decisions with human edited source',async()=>{
 const hunk=propose({path:'a.md',base:'甲。',ours:'乙。',theirs:'丙。'}).hunks[0],onDecide=vi.fn()
 const v=render(ConflictEditor,{hunk,mode:'guest',onDecide} as any)
 expect(v.getAllByRole('button')).toHaveLength(3)
 for(const [name,choice] of [[t('guest.publisherVersion'),'ours'],[t('guest.myVersion'),'theirs']]) {await fireEvent.click(v.getByRole('button',{name}));expect(onDecide).toHaveBeenLastCalledWith(hunk.id,{kind:'conflict',choice})}
 await fireEvent.input(v.getByRole('textbox'),{target:{value:'人工'}})
 await fireEvent.click(v.getByRole('button',{name:t('guest.useEdited')}))
 expect(onDecide).toHaveBeenLastCalledWith(hunk.id,{kind:'conflict',choice:'edited',text:'人工',source:'human'})
})
