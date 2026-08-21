import { drizzle } from 'drizzle-orm/postgres-js'
import { ResultAsync } from 'neverthrow'
import postgres, { type Sql } from 'postgres'

export type Db = ReturnType<typeof drizzle>

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    org TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    preset TEXT NOT NULL DEFAULT '',
    tip_id TEXT,
    parent_id TEXT,
    fork_at_msg_id TEXT,
    worker_url TEXT,
    container_id TEXT,
    max_turns INTEGER,
    system_prompt TEXT,
    revert TEXT,
    redo_tip_id TEXT,
    last_read_at TEXT,
    input_tokens BIGINT NOT NULL DEFAULT 0,
    output_tokens BIGINT NOT NULL DEFAULT 0,
    total_tokens BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    updated_at TEXT NOT NULL DEFAULT (NOW()::text),
    last_used_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions ON sessions (org, repo, branch);
CREATE INDEX IF NOT EXISTS idx_s_org_repo ON sessions (org, repo);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    parts_json TEXT NOT NULL DEFAULT '[]',
    prev_id TEXT,
    tool_name TEXT NOT NULL DEFAULT '',
    tool_call_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (NOW()::text)
);
CREATE INDEX IF NOT EXISTS idx_msg_sess ON messages (session_id);

CREATE TABLE IF NOT EXISTS parts (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    change_id TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_parts_message ON parts (message_id, seq);
CREATE INDEX IF NOT EXISTS idx_parts_session ON parts (session_id);
CREATE INDEX IF NOT EXISTS idx_parts_change ON parts (change_id);

CREATE TABLE IF NOT EXISTS mailbox (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    msg_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    effective_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    consumed_at TEXT,
    seq INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mb_sess ON mailbox (session_id);

CREATE TABLE IF NOT EXISTS presets (
    id TEXT PRIMARY KEY,
    system_prompt TEXT NOT NULL DEFAULT '',
    tools TEXT NOT NULL DEFAULT '[]',
    max_turns INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS providers (
    provider_id TEXT PRIMARY KEY,
    api_type TEXT NOT NULL DEFAULT 'openai-compatible',
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    headers TEXT NOT NULL DEFAULT 'null',
    models TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orgs (
    org TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (NOW()::text)
);

CREATE TABLE IF NOT EXISTS repos (
    org TEXT NOT NULL,
    repo TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    git_url TEXT,
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    PRIMARY KEY (org, repo)
);

CREATE TABLE IF NOT EXISTS repo_mirrors (
    org TEXT NOT NULL,
    repo TEXT NOT NULL,
    mirror_url TEXT NOT NULL,
    secret TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (NOW()::text),
    updated_at TEXT NOT NULL DEFAULT (NOW()::text),
    PRIMARY KEY (org, repo)
);
`

export function nowStr(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export function uuid(): string {
  return crypto.randomUUID()
}

/** Parse a JSON string (empty/invalid → null). */
export function parseJson<T = unknown>(
  raw: string | null | undefined,
): T | null {
  if (raw === null || raw === undefined || raw === '') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Normalize a raw drizzle/postgres.js execute() result into a row array. */
export function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[]
  const rows = (res as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : []
}

/**
 * Connect (idempotent DDL) and import any legacy providers blob from the
 * config table into the providers table (single source of truth).
 */
export function connectDb(url: string): ResultAsync<Db, string> {
  return ResultAsync.fromPromise(
    (async () => {
      const sql = postgres(url, { max: 10 })
      await sql.unsafe(DDL)
      const db = drizzle({ client: sql })
      await importProviders(sql)
      return db as Db
    })(),
    e => `db connect failed: ${String(e)}`,
  )
}

async function importProviders(sql: Sql): Promise<void> {
  const rows = await sql`SELECT value FROM config WHERE key = 'providers'`
  const raw = rows[0]?.value
  if (typeof raw !== 'string' || raw === '' || raw === '{}') return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object') return
  let imported = 0
  for (const p of Object.values(parsed as Record<string, unknown>)) {
    if (p === null || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const pid = typeof o.provider_id === 'string' ? o.provider_id : ''
    const baseUrl = typeof o.base_url === 'string' ? o.base_url : ''
    if (!pid || !baseUrl) continue
    await sql`
      INSERT INTO providers (provider_id, api_type, base_url, api_key, headers, models, created_at, updated_at)
      VALUES (${pid},
              ${typeof o.api_type === 'string' ? o.api_type : 'openai-compatible'},
              ${baseUrl},
              ${typeof o.api_key === 'string' ? o.api_key : ''},
              ${JSON.stringify(o.headers ?? null)},
              ${JSON.stringify(o.models ?? [])},
              ${nowStr()}, ${nowStr()})
      ON CONFLICT (provider_id) DO NOTHING`
    imported++
  }
  await sql`UPDATE config SET value = '{}' WHERE key = 'providers'`
  if (imported > 0) {
    console.log(`[lib-db] imported ${imported} providers from config table`)
  }
}

/** Wrap a throwing async query into a ResultAsync with context. */
export function q<T>(
  op: () => Promise<T>,
  context: string,
): ResultAsync<T, string> {
  return ResultAsync.fromPromise(op(), e => `${context}: ${String(e)}`)
}
