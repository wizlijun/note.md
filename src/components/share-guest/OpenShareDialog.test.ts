// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
const mocks=vi.hoisted(()=>({command:vi.fn(),saveToken:vi.fn(),open:vi.fn(),remember:vi.fn(),active:vi.fn(),visible:vi.fn()}))
vi.mock('../../lib/share-guest/host',()=>({guestCommand:mocks.command,saveGuestToken:mocks.saveToken}))
vi.mock('../../lib/share-guest/state.svelte',()=>({rememberGuest:mocks.remember}))
vi.mock('../../lib/tabs.svelte',()=>({openFile:mocks.open}))
vi.mock('../../lib/side-panel/registry.svelte',()=>({setActiveView:mocks.active,setSideVisible:mocks.visible}))
import Dialog from './OpenShareDialog.svelte'
const button=(text:string)=>Array.from(document.querySelectorAll('button')).find(el=>el.textContent===text)!
beforeEach(()=>{vi.clearAllMocks();document.body.innerHTML=''})
it('confirmation displays only the parsed host, cancel makes zero native/network/token calls',async()=>{
  const close=vi.fn(), component=mount(Dialog,{target:document.body,props:{link:{origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test',token:'SECRET'},onClose:close}})
  await tick(); expect(document.body.textContent).toContain('host');expect(document.body.textContent).not.toContain('SECRET')
  button('Cancel').click();expect(close).toHaveBeenCalledOnce();expect(mocks.command).not.toHaveBeenCalled();expect(mocks.saveToken).not.toHaveBeenCalled()
  await unmount(component)
})
it('confirm downloads the exact public origin and opens the normal file route without a fabricated token',async()=>{
  mocks.command.mockResolvedValue({root:'/vault/received/host/pid',entry:'a.md',origin:'https://host',project_id:'pid'})
  const close=vi.fn(), component=mount(Dialog,{target:document.body,props:{link:{origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test'},onClose:close}})
  await tick();button('Download').click();await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce())
  expect(mocks.command).toHaveBeenCalledWith('open',{origin:'https://host',slug:'2026-10-14-test',shareUrl:'https://host/2026-10-14-test'})
  expect(mocks.saveToken).not.toHaveBeenCalled();expect(mocks.open).toHaveBeenCalledWith('/vault/received/host/pid/a.md')
  await unmount(component)
})
