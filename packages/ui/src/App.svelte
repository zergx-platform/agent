<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Session } from '$lib/api'
  import SessionList from '$lib/SessionList.svelte'
  import ChatPane from '$lib/ChatPane.svelte'
  import ProviderManager from '$lib/ProviderManager.svelte'
  import PresetManager from '$lib/PresetManager.svelte'
  import { Settings, Wrench } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'

  let sessions: Session[] = $state([])
  let activeName: string | null = $state(null)
  let showProviders = $state(false)
  let showPresets = $state(false)
  let name = $state('')
  let creating = $state(false)
  let error = $state('')

  function refresh() {
    void api.listSessions().match(
      rows => {
        sessions = rows
      },
      e => {
        error = e
      },
    )
  }

  function createSession() {
    if (name.trim() === '') return
    creating = true
    error = ''
    void api
      .createSession({ name: name.trim() })
      .match(
        r => {
          activeName = r.session_name
          creating = false
          name = ''
          refresh()
        },
        e => {
          error = e
          creating = false
        },
      )
  }

  onMount(refresh)

  const active = $derived(
    sessions.find(s => s.name === activeName) ?? null,
  )
</script>

<div class="flex h-full">
  <aside class="w-72 shrink-0 border-r border-bg flex flex-col bg-panel">
    <div class="p-3 border-b border-border">
      <div class="flex items-center justify-between">
        <h1 class="text-sm font-semibold">rucoder-agent</h1>
        <div class="flex gap-1">
          <button
            class="text-muted hover:text-fg p-1 rounded"
            onclick={() => (showPresets = true)}
            title="Presets"
          >
            <Wrench class="size-4" />
          </button>
          <button
            class="text-muted hover:text-fg p-1 rounded"
            onclick={() => (showProviders = true)}
            title="Providers"
          >
            <Settings class="size-4" />
          </button>
        </div>
      </div>

      <div class="mt-3 flex flex-col gap-2">
        <Input bind:value={name} placeholder="name" />
        <Button
          class="w-full"
          disabled={creating}
          onclick={createSession}
        >
          {creating ? 'Creating…' : 'New session'}
        </Button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      <SessionList {sessions} {activeName} onselect={n => (activeName = n)} />
    </div>
  </aside>

  <main class="flex-1 min-w-0">
    {#if active}
      <ChatPane {active} onrefresh={refresh} />
    {:else}
      <div class="h-full flex items-center justify-center text-muted text-sm">
        Select or create a session to start chatting
      </div>
    {/if}
  </main>

  {#if showProviders}
    <ProviderManager onclose={() => (showProviders = false)} />
  {/if}

  {#if showPresets}
    <PresetManager onclose={() => (showPresets = false)} />
  {/if}
</div>

{#if error}
  <div
    class="fixed bottom-4 right-4 bg-red-900/80 text-fg text-sm px-3 py-2 rounded"
    onclick={() => (error = '')}
  >
    {error}
  </div>
{/if}
