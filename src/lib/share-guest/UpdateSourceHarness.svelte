<script lang="ts">
  import SourceView from '../../components/SourceView.svelte'
  import { isReadOnlyTab, setContent, type Tab } from '../tabs.svelte'
  import type { FileMountSession } from '../../editor-kit-v2/file-main'
  let {tab,session}:{tab:Tab;session?:FileMountSession}=$props()
</script>
<SourceView value={tab.currentContent} oninput={event=>setContent(tab.id,(event.target as HTMLTextAreaElement).value)} tabId={tab.id} filePath={tab.filePath}
  readOnly={isReadOnlyTab(tab)} attachFileSource={session ? (textarea,options)=>session!.attachSource(textarea,options) : undefined} />
