<script lang="ts">
  import { ChevronDown, Terminal } from '@lucide/svelte'

  let {
    toolName,
    state,
    log,
  }: {
    toolName: string
    state: 'running' | 'done'
    log: string
  } = $props()

  let open = $state(true)

  function onToggle(e: Event) {
    open = (e.currentTarget as HTMLDetailsElement).open
  }
</script>

<details class="rounded-lg border bg-muted/40 px-3 py-2 text-xs" ontoggle={onToggle}>
  <summary class="flex cursor-pointer select-none items-center gap-2 text-muted-foreground">
    <Terminal class="size-3.5" />
    <span class="font-mono">{toolName}</span>
    {#if state === 'running'}
      <span class="text-muted-foreground animate-pulse">running…</span>
    {:else}
      <span>done</span>
    {/if}
    <ChevronDown class="size-3.5 ml-auto transition-transform {open ? 'rotate-180' : ''}" />
  </summary>
  <pre class="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap break-all font-mono text-foreground">{log}</pre>
</details>
