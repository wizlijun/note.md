<script lang="ts">
import GuestPanel from './GuestPanel.svelte'
import type { Tab } from '../../lib/tabs.svelte'
let {a,b}:{a:string;b:string}=$props()
let selected=$state(false)
const tab=$derived({id:selected?'b':'a',filePath:selected?b:a} as Tab)
</script>
<button onclick={()=>selected=false}>Go A</button><button onclick={()=>selected=true}>Go B</button>
<GuestPanel {tab}/>
