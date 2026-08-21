<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Session } from '$lib/api'

  let { active, onrefresh }: { active: Session; onrefresh: () => void } = $props()

  let models: string[] = $state([])
  let presets: { id: string }[] = $state([])
  let model = $state(active.model || '')
  let preset = $state(active.preset || '')
  let saving = $state(false)
  let error = $state('')

  function load() {
    void api.listModels().match(
      m => {
        models = m
      },
      e => {
        error = e
      },
    )
    void api.listPresets().match(
      p => {
        presets = p
      },
      () => {},
    )
  }

  function save() {
    saving = true
    error = ''
    void api
      .updateSettings(active.name, {
        model: model || undefined,
        preset: preset || undefined,
      })
      .match(
        () => {
          saving = false
          onrefresh()
        },
        e => {
          error = e
          saving = false
        },
      )
  }

  onMount(load)
</script>

<div class="bg-panel2 rounded p-3 flex flex-col gap-2 text-sm">
  <div class="text-xs font-medium uppercase text-muted">Session settings</div>
  <div class="flex items-center gap-2">
    <label class="w-16 text-muted text-xs">model</label>
    <select class="flex-1" bind:value={model}>
      <option value="">default</option>
      {#each models as m (m)}
        <option value={m}>{m}</option>
      {/each}
    </select>
  </div>
  <div class="flex items-center gap-2">
    <label class="w-16 text-muted text-xs">preset</label>
    <select class="flex-1" bind:value={preset}>
      <option value="">default</option>
      {#each presets as p (p.id)}
        <option value={p.id}>{p.id}</option>
      {/each}
    </select>
  </div>
  <button
    class="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
    disabled={saving}
    onclick={save}
  >
    {saving ? 'Saving…' : 'Save'}
  </button>
  {#if error}
    <div class="text-red-400 text-xs">{error}</div>
  {/if}
</div>
