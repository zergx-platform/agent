<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api'
  import { X } from '@lucide/svelte'

  let { name, onclose }: { name: string; onclose: () => void } = $props()

  let entries: unknown[] = $state([])
  let error = $state('')

  function load() {
    void api.listMailbox(name).match(
      r => {
        entries = r
      },
      e => {
        error = e
      },
    )
  }

  onMount(load)
</script>

<button class="fixed inset-0 bg-black/50 z-10" aria-label="Close" onclick={onclose}></button>

<div class="fixed inset-0 z-20 flex items-center justify-center p-4 pointer-events-none">
  <div class="pointer-events-auto w-full max-w-lg bg-panel rounded-lg border border-border shadow-xl">
    <header class="flex items-center justify-between px-4 py-3 border-b border-border">
      <h2 class="text-sm font-semibold">Mailbox — {name}</h2>
      <button class="text-muted hover:text-fg" onclick={onclose}>
        <X class="size-4" />
      </button>
    </header>

    <div class="p-4 flex flex-col gap-2 max-h-[70vh] overflow-y-auto">
      {#if entries.length === 0}
        <div class="text-muted text-sm">No mailbox entries.</div>
      {/if}
      {#each entries as e (e.id)}
        <div class="bg-panel2 rounded px-3 py-2 text-xs">
          <div class="flex gap-2">
            <span class="text-muted">{e.msg_type}</span>
            <span class="text-muted">{e.status}</span>
          </div>
          <div class="text-muted truncate">{e.payload}</div>
        </div>
      {/each}
      {#if error}
        <div class="text-red-400 text-xs">{error}</div>
      {/if}
    </div>
  </div>
</div>
