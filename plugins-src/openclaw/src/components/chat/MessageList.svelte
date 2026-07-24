<!-- src/components/chat/MessageList.svelte -->
<script lang="ts">
  import { t } from '../../lib/strings'
  import { state } from '../../lib/openclaw/client.svelte'
  import MessageBubble from './MessageBubble.svelte'

  const messages = $derived(state.currentSessionId ? (state.messagesBySession[state.currentSessionId] ?? []) : [])
</script>

<div class="list">
  {#each messages as m (m.id)}
    <MessageBubble message={m} />
  {/each}
  {#if messages.length === 0}
    <p class="empty">{t('chat.noMessages')}</p>
  {/if}
</div>

<style>
  .list { display: flex; flex-direction: column; padding: 0.75rem; overflow-y: auto; flex: 1; }
  .empty { color: #777; text-align: center; margin-top: 2rem; }
</style>
