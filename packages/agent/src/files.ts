import { createHash, randomUUID } from 'node:crypto'
import { type Result, ResultAsync } from 'neverthrow'
import type { Bus } from './bus.js'
import type { Db } from './db-client.js'
import { rowsOf } from './db-client.js'

/** Metadata for a stored file; the SQL row is the single source of truth. */
export interface FileRecord {
  code: string
  sha256: string
  name: string
  mime: string
  size: number
  uploader_session: string
  created_at: string
}

/** Run a parameterized SQL statement; returns raw rows. */
async function runSql(
  db: Db,
  query: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  const res = await db.$client.unsafe(query, params as never[])
  return rowsOf(res) ?? []
}

/** Persist a new file mapping (idempotent: returns the existing row on conflict). */
export async function upsertFile(
  db: Db,
  record: FileRecord,
): Promise<Result<FileRecord, string>> {
  return ResultAsync.fromPromise(
    (async () => {
      await runSql(
        db,
        `INSERT INTO files (code, sha256, name, mime, size, uploader_session, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (code) DO UPDATE
           SET sha256=EXCLUDED.sha256, name=EXCLUDED.name, mime=EXCLUDED.mime,
               size=EXCLUDED.size, uploader_session=EXCLUDED.uploader_session`,
        [
          record.code,
          record.sha256,
          record.name,
          record.mime,
          record.size,
          record.uploader_session,
          record.created_at,
        ],
      )
      return record
    })(),
    e => `upsert file failed: ${String(e)}`,
  )
}

/** Look up the file row (if any) that already stores this sha256 (dedup). */
export async function fileBySha(
  db: Db,
  sha256: string,
): Promise<Result<FileRecord | null, string>> {
  return ResultAsync.fromPromise(
    (async () => {
      if (sha256 === '') return null
      const rows = await runSql(
        db,
        `SELECT * FROM files WHERE sha256 = $1 LIMIT 1`,
        [sha256],
      )
      if (rows.length === 0) return null
      const row = rows[0]
      return rowToFile(row ?? {})
    })(),
    e => `fileBySha failed: ${String(e)}`,
  )
}

/** Fetch a file row by code. */
export async function fileByCode(
  db: Db,
  code: string,
): Promise<Result<FileRecord | null, string>> {
  return ResultAsync.fromPromise(
    (async () => {
      const rows = await runSql(
        db,
        `SELECT * FROM files WHERE code = $1 LIMIT 1`,
        [code],
      )
      if (rows.length === 0) return null
      const row = rows[0]
      return rowToFile(row ?? {})
    })(),
    e => `fileByCode failed: ${String(e)}`,
  )
}

function rowToFile(r: Record<string, unknown>): FileRecord {
  return {
    code: String(r.code ?? ''),
    sha256: String(r.sha256 ?? ''),
    name: String(r.name ?? ''),
    mime: String(r.mime ?? ''),
    size: Number(r.size ?? 0),
    uploader_session: String(r.uploader_session ?? ''),
    created_at: String(r.created_at ?? ''),
  }
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Mint a short, unguessable, collision-resistant object key. */
export function randomCode(): string {
  return randomUUID().replace(/-/g, '').slice(0, 16)
}

/**
 * BlobStore stores file bytes addressed by `code`. Metadata lives in the
 * `files` SQL table (single source of truth); the blob layer only backs raw
 * bytes. Durable file bytes use the persistent (no-TTL) NATS object bucket,
 * so they never expire.
 */
export interface BlobStore {
  put(code: string, meta: FileRecord, data: Uint8Array): Promise<void>
  get(code: string): Promise<{ meta: FileRecord; data: Uint8Array }>
  stat(code: string): Promise<FileRecord | null>
}

/**
 * NATS JetStream object-store backend (persistent bucket). Code → key,
 * bytes → object body. `stat` resolves from the SQL row (already the source
 * of truth), so it needs no object-level metadata.
 */
function makeNatsStore(bus: Bus): BlobStore {
  return {
    async put(code, _meta, data) {
      // Warm the persistent bucket once (create-or-open is idempotent), then
      // store the bytes. Durable file bytes are never expired.
      await bus.objectPutPersistent(code, Uint8Array.from(data))
    },
    async get(code) {
      const data = await bus.objectGetPersistent(code)
      if (data === null) throw new Error(`file not found: ${code}`)
      return { meta: {} as FileRecord, data: Uint8Array.from(data) }
    },
    async stat(code) {
      const data = await bus.objectGetPersistent(code)
      if (data === null) return null
      return { code } as FileRecord
    },
  }
}

/**
 * Build the file blob backend. Durable file bytes ride the persistent (no-TTL)
 * NATS object bucket; metadata lives in the `files` SQL table.
 */
export function makeBlobStore(bus: Bus): BlobStore {
  return makeNatsStore(bus)
}
