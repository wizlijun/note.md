<script lang="ts">
  import { bridge } from './lib/bridge'
  const pluginId = (() => { try { return bridge().pluginId } catch { return 'dev' } })()
</script>
<main><h1>Decision Log</h1><p>{pluginId}</p></main>
