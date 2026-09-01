# zergx-agent-ts

TypeScript implementation of the zergx coding-agent session service,
mirroring the architecture and tooling of `zergx` (Hono + drizzle +
neverthrow + Vercel AI SDK) while interoperating with the Rust `zergx-agent`
on the same Postgres and NATS/JetStream cluster (both replicas can serve the
same sessions; cross-replica mutual exclusion via Postgres advisory locks,
event fan-out via JetStream subjects).

## Packages

```
agent-ts/
├── packages/
│   ├── schema/     # Shared zod schemas + types (API contract)
│   ├── lib-config/ # Env config loader
│   ├── lib-db/     # drizzle + postgres.js: sessions/messages/parts/mailbox/
│   │               # providers tables, chain queries, advisory locks
│   ├── lib-bus/    # nats.ts: JetStream streams, object store, subjects
│   ├── lib-llm/    # Provider registry + Vercel AI SDK model factory
│   ├── lib-agent/  # Turn loop (streamText multi-turn), NATS tool bridge,
│   │               # history rebuild, SSE events, mid-stream interrupt
│   └── server/     # Hono API (30 endpoints) + SSE + static SPA + bootstrap
```

## Develop

```bash
npm install
npm run dev        # tsx watch (needs NATS + Postgres reachable)
npm run build      # schema → libs → server (esbuild bundles)
npm run check      # biome check .
npm test           # vitest unit tests
```

## Configuration

Same env vars as the Rust agent (`RUCODER_PORT`, `POSTGRES_*`, `NATS_URL`,
`RUCODER_LLM_*`, `RUCODER_TOOL_SERVERS`, `RUCODER_TOOL_TIMEOUT_SECS`,
`RUCODER_DEFAULT_MAX_TURNS`, `RUCODER_WEB_DIST`).

## Tool contract

Tools are discovered from tool servers (`GET /api/v1/tools`) and invoked over
NATS (`tool.call.{name}` → `tool.result.{call_id}`, large results via the
`ZERGX_TOOL` object store) — byte-compatible with `zergx-sdk-bus`, so tool
servers need no changes.

## Behavior notes vs the Rust agent

- Mid-stream interrupt: `POST /sessions/{id}/interrupt` aborts the running
  stream on the local replica and, via the durable mailbox wake signal, on
  whichever replica holds the session lock.
- Messages form a `prev_id` chain with a session tip (undo works).
- Each finished agent step is persisted immediately (crash-safe).
- Token usage accumulates across turns.
