<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Provider } from '$lib/api'
  import { X, Plus, Trash2, Check } from '@lucide/svelte'

  let { onclose }: { onclose: () => void } = $props()

  let providers: Record<string, Provider> = $state({})
  let error = $state('')

  let pid = $state('')
  let apiType = $state('openai-compatible')
  let baseUrl = $state('')
  let apiKey = $state('')
  let modelsText = $state('')

  const list = $derived(Object.values(providers))

  async function refresh() {
    try {
      const r = await api.listProviders()
      providers = r.providers
    } catch (e) {
      error = String(e)
    }
  }

  async function register() {
    if (!pid.trim() || !baseUrl.trim()) return
    error = ''
    try {
      await api.registerProvider({
        provider_id: pid.trim(),
        api_type: apiType,
        base_url: baseUrl.trim(),
        api_key: apiKey,
        models: modelsText
          .split(',')
          .map(s => s.trim())
          .filter(Boolean),
      })
      pid = ''
      baseUrl = ''
      apiKey = ''
      modelsText = ''
      await refresh()
    } catch (e) {
      error = String(e)
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteProvider(id)
      await refresh()
    } catch (e) {
      error = String(e)
    }
  }

  onMount(refresh)
</script>

<!-- backdrop -->
<button
  class="fixed inset-0 bg-black/50 z-10"
  aria-label="Close"
  onclick={onclose}
></button>

<div class="fixed inset-0 z-20 flex items-center justify-center p-4 pointer-events-none">
  <div class="pointer-events-auto w-full max-w-lg bg-panel rounded-lg border border-border shadow-xl">
    <header class="flex items-center justify-between px-4 py-3 border-b border-border">
      <h2 class="text-sm font-semibold">Providers</h2>
      <button class="text-muted hover:text-fg" onclick={onclose}>
        <X class="size-4" />
      </button>
    </header>

    <div class="p-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
      {#if list.length === 0}
        <div class="text-muted text-sm">No providers registered.</div>
      {/if}

      {#each list as p (p.provider_id)}
        <div class="flex items-center gap-2 bg-panel2 rounded px-3 py-2">
          <Check class="size-4 text-green-400 shrink-0" />
          <div class="flex-1 min-w-0">
            <div class="text-sm font-medium">{p.provider_id}</div>
            <div class="text-xs text-muted truncate">
              {p.api_type} · {p.base_url}
            </div>
          </div>
          <button
            class="text-muted hover:text-red-400 p-1"
            onclick={() => remove(p.provider_id)}
            title="Delete"
          >
            <Trash2 class="size-4" />
          </button>
        </div>
      {/each}

      <div class="border-t border-border pt-3 flex flex-col gap-2">
        <div class="text-xs text-muted font-medium uppercase">Register new</div>
        <input bind:value={pid} placeholder="provider_id" />
        <select bind:value={apiType}>
          <option value="openai-compatible">openai-compatible</option>
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="deepseek">deepseek</option>
          <option value="google">google</option>
        </select>
        <input bind:value={baseUrl} placeholder="base_url (https://…)" />
        <input
          bind:value={apiKey}
          type="password"
          placeholder="api_key (optional)"
        />
        <input bind:value={modelsText} placeholder="models (comma-separated)" />
        <button
          class="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          disabled={!pid.trim() || !baseUrl.trim()}
          onclick={register}
        >
          <span class="inline-flex items-center gap-1">
            <Plus class="size-4" /> Add provider
          </span>
        </button>
      </div>

      {#if error}
        <div class="text-red-400 text-xs">{error}</div>
      {/if}
    </div>
  </div>
</div>
