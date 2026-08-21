<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Session } from '$lib/api'
  import { parseLoose } from '@rucoder-agent/schema'
  import { markdown } from '$lib/markdown'
  import { Send, Square, Settings2, Undo2, GitFork, Mailbox } from '@lucide/svelte'
  import SettingsPanel from '$lib/SettingsPanel.svelte'
  import MailboxPanel from '$lib/MailboxPanel.svelte'

  let { active, onrefresh }: { active: Session; onrefresh: () => void } = $props()

  type Msg = { id: string; role: string; content: string }
  let messages: Msg[] = $state([])
  let input = $state('')
  let streaming = $state(false)
  let assistantBuf = $state('')
  let error = $state('')
  let showSettings = $state(false)
  let showMailbox = $state(false)

  let es: EventSource | null = null

  function loadHistory() {
    void api.listMessages(active.name).match(
      rows => {
        messages = rows
          .filter(m => m.role !== 'system')
          .map(m => ({ id: m.id, role: m.role, content: m.content }))
      },
      e => {
        error = e
      },
    )
  }

  function startStream() {
    stopStream()
    es = new EventSource(api.sessionsStreamUrl(active.name))
    es.onmessage = ev => {
      parseLoose(ev.data).match(
        value => {
          const data = value as { event?: string; params?: Record<string, unknown> }
          const p = data.params ?? {}
          if (data.event === 'text-delta' && typeof p.text === 'string') {
            assistantBuf += p.text
          } else if (data.event === 'turn-complete') {
            flushAssistant()
            streaming = false
            onrefresh()
            stopStream()
          } else if (data.event === 'error') {
            error = typeof p.message === 'string' ? p.message : 'turn error'
            streaming = false
            stopStream()
          }
        },
        () => {},
      )
    }
    es.onerror = () => stopStream()
  }

  function stopStream() {
    if (es) {
      es.close()
      es = null
    }
  }

  function flushAssistant() {
    if (assistantBuf.trim() !== '') {
      messages = [
        ...messages,
        { id: `local-${Date.now()}`, role: 'assistant', content: assistantBuf },
      ]
      assistantBuf = ''
    }
  }

  function send() {
    const text = input.trim()
    if (text === '' || streaming) return
    messages = [...messages, { id: `local-${Date.now()}`, role: 'user', content: text }]
    input = ''
    assistantBuf = ''
    streaming = true
    error = ''
    void api.prompt(active.name, text).match(
      () => startStream(),
      e => {
        error = e
        streaming = false
      },
    )
  }

  function interrupt() {
    stopStream()
    streaming = false
    flushAssistant()
    void api.interrupt(active.name).match(
      () => loadHistory(),
      e => {
        error = e
      },
    )
  }

  function undo() {
    void api.undo(active.name).match(
      r => {
        if (r.undone) loadHistory()
      },
      e => {
        error = e
      },
    )
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  onMount(() => {
    loadHistory()
    return () => stopStream()
  })

  function scrollToBottom(el: HTMLElement) {
    el.scrollTop = el.scrollHeight
  }
</script>

<div class="h-full flex flex-col">
  <header class="shrink-0 px-4 py-2 border-b border-border flex items-center gap-2 text-sm">
    <span class="font-medium">{active.name}</span>
    <div class="flex-1"></div>
    <button
      class="text-muted hover:text-fg p-1"
      onclick={() => (showMailbox = true)}
      title="Mailbox"
    >
      <Mailbox class="size-4" />
    </button>
    <button
      class="text-muted hover:text-fg p-1"
      onclick={undo}
      title="Undo"
    >
      <Undo2 class="size-4" />
    </button>
    <button
      class="text-muted hover:text-fg p-1"
      onclick={() => (showSettings = true)}
      title="Settings"
    >
      <Settings2 class="size-4" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4" use:scrollToBottom={messages.length + (assistantBuf.length > 0 ? 1 : 0)}>
    {#each messages as m (m.id)}
      <div class="flex {m.role === 'user' ? 'justify-end' : 'justify-start'}">
        <div
          class="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap {m.role === 'user' ? 'bg-user' : 'bg-assistant'}"
        >
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          {#if m.role === 'assistant'}
            {@html markdown(m.content)}
          {:else}
            {m.content}
          {/if}
        </div>
      </div>
    {/each}

    {#if assistantBuf !== ''}
      <div class="flex justify-start">
        <div class="max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap bg-assistant">
          {@html markdown(assistantBuf)}
        </div>
      </div>
    {/if}

    {#if streaming && assistantBuf === ''}
      <div class="text-muted text-sm">Thinking…</div>
    {/if}
  </div>

  <footer class="shrink-0 p-3 border-t border-border">
    <div class="mb-2">
      <SettingsPanel {active} onrefresh={onrefresh} />
    </div>
    {#if error}
      <div class="text-red-400 text-xs mb-2">{error}</div>
    {/if}
    <div class="flex gap-2 items-end">
      <textarea
        rows={2}
        class="flex-1 resize-none"
        disabled={streaming}
        placeholder="Ask the agent…"
        bind:value={input}
        onkeydown={onKey}
      ></textarea>
      {#if streaming}
        <button
          class="bg-red-600 text-white rounded p-2"
          onclick={interrupt}
          title="Stop"
        >
          <Square class="size-4" />
        </button>
      {:else}
        <button
          class="bg-accent text-accent-fg rounded p-2 disabled:opacity-50"
          disabled={input.trim() === ''}
          onclick={() => send()}
          title="Send"
        >
          <Send class="size-4" />
        </button>
      {/if}
    </div>
  </footer>
</div>

{#if showMailbox}
  <MailboxPanel name={active.name} onclose={() => (showMailbox = false)} />
{/if}
