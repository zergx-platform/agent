<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from '$lib/api'
  import { X, Plus, Trash2 } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'

  let { onclose }: { onclose: () => void } = $props()

  let presets: { id: string; system_prompt: string; tools: string; max_turns: number }[] =
    $state([])
  let error = $state('')

  let id = $state('')
  let systemPrompt = $state('')
  let toolsText = $state('')
  let maxTurns = $state(30)

  function refresh() {
    void api.listPresets().match(
      r => {
        presets = r
      },
      e => {
        error = e
      },
    )
  }

  function save() {
    if (id.trim() === '') return
    void api
      .upsertPreset({
        id: id.trim(),
        system_prompt: systemPrompt,
        tools: toolsText
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
        max_turns: maxTurns,
      })
      .match(
        () => {
          id = ''
          systemPrompt = ''
          toolsText = ''
          maxTurns = 30
          refresh()
        },
        e => {
          error = e
        },
      )
  }

  function remove(pid: string) {
    void api.deletePreset(pid).match(
      () => refresh(),
      e => {
        error = e
      },
    )
  }

  onMount(refresh)
</script>

<button class="fixed inset-0 bg-black/50 z-10" aria-label="Close" onclick={onclose}></button>

<div class="fixed inset-0 z-20 flex items-center justify-center p-4 pointer-events-none">
  <div class="pointer-events-auto w-full max-w-lg bg-panel rounded-lg border border-border shadow-xl">
    <header class="flex items-center justify-between px-4 py-3 border-b border-border">
      <h2 class="text-sm font-semibold">Presets</h2>
      <button class="text-muted hover:text-fg" onclick={onclose}>
        <X class="size-4" />
      </button>
    </header>

    <div class="p-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
      {#each presets as p (p.id)}
        <div class="flex items-center gap-2 bg-panel2 rounded px-3 py-2">
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">{p.id}</div>
            <div class="text-xs text-muted truncate">{p.system_prompt.slice(0, 80)}</div>
            <div class="text-xs text-muted">max_turns: {p.max_turns}</div>
          </div>
          <button
            class="text-muted hover:text-red-400 p-1"
            onclick={() => remove(p.id)}
            title="Delete"
          >
            <Trash2 class="size-4" />
          </button>
        </div>
      {/each}

      <div class="border-t border-border pt-3 flex flex-col gap-2">
        <div class="text-xs text-muted font-medium uppercase">New / edit preset</div>
        <Input bind:value={id} placeholder="id" />
        <Textarea
          rows={3}
          bind:value={systemPrompt}
          placeholder="system prompt"
        />
        <Input bind:value={toolsText} placeholder="tools (comma-separated)" />
        <Input
          type="number"
          bind:value={maxTurns}
          placeholder="max_turns"
        />
        <Button
          disabled={id.trim() === ''}
          onclick={save}
        >
          <Plus class="size-4" /> Save preset
        </Button>
      </div>

      {#if error}
        <div class="text-red-400 text-xs">{error}</div>
      {/if}
    </div>
  </div>
</div>
