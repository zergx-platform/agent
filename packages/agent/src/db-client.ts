import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { ResultAsync } from 'neverthrow'
import postgres, { type Sql } from 'postgres'
import { z } from 'zod'
import { parse } from './json.js'
import { logger } from './logger.js'

/** The drizzle database handle, with its underlying postgres.js `$client`. */
export type Db = PostgresJsDatabase & { $client: Sql }

export type {
  ContentPayload,
  Json,
  TextPartData,
  ToolPartData,
  ToolResultPartData,
  WakePayload,
} from './json.js'
// Re-export the shared JSON/parse surface for one-stop imports elsewhere in
// the agent package (single source of truth in ./json.ts).
export {
  ContentPayloadSchema,
  parse,
  stringify,
  TextPartDataSchema,
  ToolPartDataSchema,
  ToolResultPartDataSchema,
  WakePayloadSchema,
} from './json.js'

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    name TEXT PRIMARY KEY,
    model TEXT NOT NULL DEFAULT '',
    preset TEXT NOT NULL DEFAULT '',
    tip_id TEXT,
    max_turns INTEGER NOT NULL DEFAULT 0,
    system_prompt TEXT NOT NULL DEFAULT '',
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    last_input_tokens BIGINT NOT NULL DEFAULT 0,
    last_output_tokens BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    updated_at TEXT NOT NULL DEFAULT (NOW()::text),
    last_used_at TEXT
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    prev_id TEXT,
    created_at TEXT NOT NULL DEFAULT (NOW()::text)
);
CREATE INDEX IF NOT EXISTS idx_messages_prev ON messages (prev_id);

CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_parts_message ON parts (message_id, seq);

CREATE TABLE IF NOT EXISTS mailbox (
    id TEXT PRIMARY KEY,
    session_name TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    msg_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    effective_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    consumed_at TEXT,
    seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mb_sess ON mailbox (session_name);

CREATE TABLE IF NOT EXISTS worksheets (
    id TEXT PRIMARY KEY,
    session_name TEXT NOT NULL REFERENCES sessions(name) ON DELETE CASCADE,
    ext_id TEXT NOT NULL,
    action TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    title TEXT NOT NULL DEFAULT '',
    origin_call_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ws_session ON worksheets (session_name);
CREATE INDEX IF NOT EXISTS idx_ws_status ON worksheets (status);

CREATE TABLE IF NOT EXISTS providers (
    provider_id TEXT PRIMARY KEY,
    api_type TEXT NOT NULL DEFAULT 'openai-compatible',
    base_url TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    headers TEXT NOT NULL DEFAULT 'null',
    models TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);

-- presets / config / files-meta moved to NATS KV buckets (abc-presets,
-- abc-agent-config, abc-files-meta). The legacy PG tables are intentionally
-- NOT dropped: existing deployments keep them as the one-time backfill
-- source (see kv-backfill.ts); fresh installs never create them.
`

export function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export function uuid(): string {
  return crypto.randomUUID()
}

/** Normalize a raw drizzle/postgres.js execute() result into a row array. */
const RawRowsSchema = z.array(z.record(z.string(), z.unknown()))

const ResultWithRowsSchema = z
  .object({ rows: z.array(z.record(z.string(), z.unknown())) })
  .partial()

export function rowsOf(res: unknown): Record<string, unknown>[] {
  const direct = RawRowsSchema.safeParse(res)
  if (direct.success) return direct.data
  const wrapped = ResultWithRowsSchema.safeParse({ rows: res })
  if (wrapped.success && wrapped.data.rows !== undefined) {
    return wrapped.data.rows
  }
  return []
}

/**
 * Connect (idempotent DDL) and import any legacy providers blob from the
 * config table into the providers table (single source of truth).
 */
export function connectDb(url: string): ResultAsync<Db, string> {
  return ResultAsync.fromPromise(
    (async () => {
      const sql = postgres(url, { max: 10 })
      await migrateSchema(sql)
      const db = drizzle({ client: sql })
      await importProviders(sql)
      return db
    })(),
    e => `db connect failed: ${String(e)}`,
  )
}

/**
 * Idempotent schema bootstrap. Tables are created with IF NOT EXISTS and are
 * never dropped: session history, mailbox, and message chains must survive
 * restarts, rollouts, and multi-replica boots (dropping them would destroy
 * every conversation on each deploy and break cross-replica durable mailbox
 * delivery). Column/table changes must be expressed as additive migrations,
 * not a drop-and-recreate reset.
 */
async function migrateSchema(sql: Sql): Promise<void> {
  await sql.unsafe(DDL)
  // Additive migration: sessions.max_turns / system_prompt added after the
  // initial table existed in the wild. CREATE IF NOT EXISTS won't add them
  // to an existing table, so backfill missing columns idempotently.
  await sql.unsafe(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS max_turns INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
    -- Latest single-request token usage (overwrite, not cumulative).
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_input_tokens BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_output_tokens BIGINT NOT NULL DEFAULT 0;
    -- Retired dead columns (always DEFAULT ''; tool identity lives in the
    -- parts table). Drop is safe: nothing wrote to them.
    ALTER TABLE messages DROP COLUMN IF EXISTS tool_name;
    ALTER TABLE messages DROP COLUMN IF EXISTS tool_call_id;
    -- Retired: read/unread state moved to the platform (vars KV under its
    -- own extension id). The agent no longer stores or interprets it.
    ALTER TABLE sessions DROP COLUMN IF EXISTS last_read_at;
  `)
}

async function importProviders(sql: Sql): Promise<void> {
  // The legacy config table is no longer created (config moved to NATS KV);
  // existing deployments may still hold the pre-split providers blob.
  let rows: { value?: unknown }[] = []
  try {
    rows = await sql`SELECT value FROM config WHERE key = 'providers'`
  } catch {
    return
  }
  const raw = rows[0]?.value
  const rawParsed = z.string().safeParse(raw)
  if (!rawParsed.success || rawParsed.data === '' || rawParsed.data === '{}') {
    return
  }
  const parsed = parse(z.unknown(), rawParsed.data)
  if (parsed.isErr()) return

  const ProviderImportSchema = z.object({
    provider_id: z.string(),
    base_url: z.string(),
    api_type: z.string().optional(),
    api_key: z.string().optional(),
    headers: z.unknown(),
    models: z.unknown(),
  })
  const ProvidersMapSchema = z.record(z.string(), ProviderImportSchema)
  const providers = ProvidersMapSchema.safeParse(parsed.value)
  if (!providers.success) return

  let imported = 0
  const providerEntries = z
    .array(z.tuple([z.string(), ProviderImportSchema]))
    .safeParse(Object.entries(providers.data))
  if (!providerEntries.success) return
  for (const [, o] of providerEntries.data) {
    await sql`
      INSERT INTO providers (provider_id, api_type, base_url, api_key, headers, models, created_at, updated_at)
      VALUES (${o.provider_id},
              ${o.api_type ?? 'openai-compatible'},
              ${o.base_url},
              ${o.api_key ?? ''},
              ${JSON.stringify(o.headers ?? null)},
              ${JSON.stringify(o.models ?? [])},
              ${nowStr()}, ${nowStr()})
      ON CONFLICT (provider_id) DO NOTHING`
    imported++
  }
  try {
    await sql`UPDATE config SET value = '{}' WHERE key = 'providers'`
  } catch {
    // legacy table absent on fresh installs
  }
  if (imported > 0) {
    logger.info({ imported }, 'imported providers from config table')
  }
}

/** Wrap a throwing async query into a ResultAsync with context.
 * The error chain (Drizzle wraps the pg cause) is flattened into the
 * message so downstream classifiers (e.g. foreign-key detection) can see
 * the underlying pg error code/detail. */
export function q<T>(
  op: () => Promise<T>,
  context: string,
): ResultAsync<T, string> {
  return ResultAsync.fromPromise(op(), e => {
    const causes: string[] = []
    let cur: unknown = e
    for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
      causes.push(cur.message ?? String(cur))
      cur = (cur as Error & { cause?: unknown }).cause
    }
    return `${context}: ${causes.join(' | caused by: ')}`
  })
}
