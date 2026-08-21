<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Session } from '$lib/api'
  import SessionList from '$lib/SessionList.svelte'
  import ChatPane from '$lib/ChatPane.svelte'
  import ProviderManager from '$lib/ProviderManager.svelte'
  import { Settings } from '@lucide/svelte'

  let sessions: Session[] = $state([])
  let activeId: string | null = $state(null)
  let showProviders = $state(false)
  let org = $state('')
  let repo = $state('')
  let branch = $state('main')
  let creating = $state(false)
  let error = $state('')

  async function refresh() {
    try {
      sessions = await api.listSessions()
    } catch (e) {
      error = String(e)
    }
  }

  async function createSession() {
    if (!org.trim() || !repo.trim() || !branch.trim()) return
    creating = true
    error = ''
    try {
      const r = await api.createSession({
        org: org.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
      })
      activeId = r.session_id
      await refresh()
    } catch (e) {
      error = String(e)
    } finally {
      creating = false
    }
  }

  onMount(refresh)

  const active = $derived(
    sessions.find(s => s.id === activeId) ?? null,
  )
</script>

<div class="flex h-full">
  <aside class="w-72 shrink-0 border-r border-bg flex flex-col bg-panel">
    <div class="p-3 border-b border-border">
      <div class="flex items-center justify-between">
        <h1 class="text-sm font-semibold">rucoder-agent</h1>
        <button
          class="text-muted hover:text-fg p-1 rounded"
          onclick={() => (showProviders = true)}
          title="Providers"
        >
          <Settings class="size-4" />
        </button>
      </div>

      <div class="mt-3 flex flex-col gap-2">
        <input bind:value={org} placeholder="org" />
        <input bind:value={repo} placeholder="repo" />
        <input bind:value={branch} placeholder="branch" />
        <button
          class="bg-accent text-accent-fg rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          disabled={creating}
          onclick={createSession}
        >
          {creating ? 'Creating…' : 'New session'}
        </button>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      <SessionList {sessions} {activeId} onselect={id => (activeId = id)} />
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
</div>

{#if error}
  <div
    class="fixed bottom-4 right-4 bg-red-900/80 text-fg text-sm px-3 py-2 rounded"
    onclick={() => (error = '')}
  >
    {error}
  </div>
{/if}
