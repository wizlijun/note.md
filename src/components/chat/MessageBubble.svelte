<!-- src/components/chat/MessageBubble.svelte -->
<script lang="ts">
  import type { Message } from '../../lib/openclaw/protocol'

  let { message }: { message: Message } = $props()
</script>

<div class="bubble" class:user={message.role === 'user'} class:agent={message.role === 'agent'}>
  <div class="role">{message.role}</div>
  <div class="text">{message.text}{#if message.streaming}<span class="cursor">▍</span>{/if}</div>
</div>

<style>
  .bubble { padding: 0.5rem 0.75rem; margin: 0.25rem 0; border-radius: 8px; }
  .bubble.user { background: #2563eb; color: white; align-self: flex-end; max-width: 80%; margin-left: auto; }
  .bubble.agent { background: #f3f4f6; color: #111; max-width: 80%; }
  .role { font-size: 0.7rem; opacity: 0.6; text-transform: uppercase; }
  .text { white-space: pre-wrap; word-break: break-word; }
  .cursor { animation: blink 1s steps(1) infinite; opacity: 0.5; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
