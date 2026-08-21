<script lang="ts">
  import type { Session } from '$lib/api'
  import { MessageSquareOff } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'

  let {
    sessions,
    activeName,
    onselect,
  }: {
    sessions: Session[]
    activeName: string | null
    onselect: (name: string) => void
  } = $props()

  const sorted = $derived(
    [...sessions].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
  )
</script>

<div class="flex flex-col">
  {#if sorted.length === 0}
    <div class="p-6 text-center text-muted-foreground text-sm flex flex-col items-center gap-2">
      <MessageSquareOff class="size-6" />
      No sessions yet
    </div>
  {:else}
    {#each sorted as s (s.name)}
      <Button
        variant="ghost"
        class="w-full justify-start rounded-none text-left px-3 h-auto py-2 border-b border-border/60 {activeName === s.name ? 'bg-muted' : ''}"
        onclick={() => onselect(s.name)}
      >
        <span class="flex flex-col items-start">
          <span class="text-sm truncate font-medium">
            {s.name}
          </span>
          <span class="text-xs text-muted-foreground truncate">{s.model || 'default'}</span>
        </span>
      </Button>
    {/each}
  {/if}
</div>
