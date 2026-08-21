<script lang="ts">
  import type { Session } from '$lib/api'
  import { MessageSquareOff } from '@lucide/svelte'

  let {
    sessions,
    activeId,
    onselect,
  }: {
    sessions: Session[]
    activeId: string | null
    onselect: (id: string) => void
  } = $props()

  const sorted = $derived(
    [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  )
</script>

<div class="flex flex-col">
  {#if sorted.length === 0}
    <div class="p-6 text-center text-muted text-sm flex flex-col items-center gap-2">
      <MessageSquareOff class="size-6" />
      No sessions yet
    </div>
  {:else}
    {#each sorted as s (s.id)}
      <button
        class="text-left px-3 py-2 border-b border-border/60 hover:bg-panel2 transition-colors {activeId === s.id ? 'bg-panel2' : ''}"
        onclick={() => onselect(s.id)}
      >
        <div class="text-sm truncate font-medium">
          {s.name || `${s.org}/${s.repo}`}
        </div>
        <div class="text-xs text-muted truncate">{s.org}/{s.repo} · #{s.branch} · {s.model || 'default'}</div>
      </button>
    {/each}
  {/if}
</div>
