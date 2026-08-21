<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api'
  import * as Dialog from '$lib/components/ui/dialog'

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

<Dialog.Root open onOpenChange={o => { if (!o) onclose() }}>
  <Dialog.Content class="max-w-lg w-full">
    <Dialog.Header>
      <Dialog.Title>Mailbox — {name}</Dialog.Title>
    </Dialog.Header>

    <div class="flex flex-col gap-2 max-h-[70vh] overflow-y-auto">
      {#if entries.length === 0}
        <div class="text-muted-foreground text-sm">No mailbox entries.</div>
      {/if}
      {#each entries as e (e.id)}
        <div class="bg-muted rounded px-3 py-2 text-xs">
          <div class="flex gap-2">
            <span class="text-muted-foreground">{e.msg_type}</span>
            <span class="text-muted-foreground">{e.status}</span>
          </div>
          <div class="text-muted-foreground truncate">{e.payload}</div>
        </div>
      {/each}
      {#if error}
        <div class="text-destructive text-xs">{error}</div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
