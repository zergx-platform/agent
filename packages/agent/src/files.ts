import { createHash, randomUUID } from 'node:crypto'
import { type Result, ResultAsync } from 'neverthrow'
import type { Bus } from './bus.js'
import { BUCKET_FILES_META } from './bus.js'

/** Metadata for a stored file; the NATS KV bucket is the single source of
 *  truth, colocated with the bytes in the persistent object store. */
export interface FileRecord {
  code: string
  sha256: string
  name: string
  mime: string
  size: number
  uploader_session: string
  created_at: string
}

const NO_TTL = 0
const META_PREFIX = 'f.'
const SHA_PREFIX = 'sha.'

/**
 * Write-through cache closing the KV read-after-write propagation window:
 * an upload followed by a cross-service meta lookup (e.g. the platform's
 * attachment refs) must never miss its own just-written entry.
 */
const CACHE_CAP = 4096
const metaCache = new Map<string, FileRecord>()
const shaCache = new Map<string, string>()

function cachePut(record: FileRecord): void {
  metaCache.set(record.code, record)
  if (record.sha256 !== '') shaCache.set(record.sha256, record.code)
  while (metaCache.size > CACHE_CAP) {
    const oldest = metaCache.keys().next().value
    if (oldest === undefined) break
    metaCache.delete(oldest)
  }
  while (shaCache.size > CACHE_CAP) {
    const oldest = shaCache.keys().next().value
    if (oldest === undefined) break
    shaCache.delete(oldest)
  }
}

function parseMeta(raw: string): FileRecord | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const code = String(v.code ?? '')
    if (code === '') return null
    return {
      code,
      sha256: String(v.sha256 ?? ''),
      name: String(v.name ?? ''),
      mime: String(v.mime ?? ''),
      size: Number(v.size ?? 0),
      uploader_session: String(v.uploader_session ?? ''),
      created_at: String(v.created_at ?? ''),
    }
  } catch {
    return null
  }
}

function ra<T>(op: Promise<T>, context: string): ResultAsync<T, string> {
  return ResultAsync.fromPromise(op, e => `${context}: ${String(e)}`)
}

/**
 * Persist a file mapping: meta key first, then the dedup index. A crash
 * between the two only loses dedup (harmless re-upload), never a dangling
 * index pointing at missing meta.
 */
export async function upsertFile(
  bus: Bus,
  record: FileRecord,
): Promise<Result<FileRecord, string>> {
  return ra(
    (async () => {
      await bus.kvPut(
        BUCKET_FILES_META,
        META_PREFIX + record.code,
        JSON.stringify(record),
        NO_TTL,
      )
      if (record.sha256 !== '') {
        // Atomic when absent; a lost race means identical bytes, harmless.
        const created = await bus.kvCreate(
          BUCKET_FILES_META,
          SHA_PREFIX + record.sha256,
          record.code,
          NO_TTL,
        )
        if (created === null) {
          await bus.kvPut(
            BUCKET_FILES_META,
            SHA_PREFIX + record.sha256,
            record.code,
            NO_TTL,
          )
        }
        shaCache.set(record.sha256, record.code)
      }
      cachePut(record)
      return record
    })(),
    'upsert file failed',
  )
}

/** Look up the file record (if any) that already stores this sha256 (dedup). */
export async function fileBySha(
  bus: Bus,
  sha256: string,
): Promise<Result<FileRecord | null, string>> {
  return ra(
    (async () => {
      if (sha256 === '') return null
      const cached = shaCache.get(sha256)
      if (cached !== undefined) {
        const hit = metaCache.get(cached)
        if (hit !== undefined) return hit
      }
      const code = await bus.kvGet(BUCKET_FILES_META, SHA_PREFIX + sha256)
      if (code === null) return null
      const raw = await bus.kvGet(BUCKET_FILES_META, META_PREFIX + code)
      if (raw === null) return null
      const record = parseMeta(raw)
      if (record !== null) cachePut(record)
      return record
    })(),
    'fileBySha failed',
  )
}

/** Fetch a file record by code. */
export async function fileByCode(
  bus: Bus,
  code: string,
): Promise<Result<FileRecord | null, string>> {
  return ra(
    (async () => {
      const cached = metaCache.get(code)
      if (cached !== undefined) return cached
      const raw = await bus.kvGet(BUCKET_FILES_META, META_PREFIX + code)
      if (raw === null) return null
      const record = parseMeta(raw)
      if (record !== null) cachePut(record)
      return record
    })(),
    'fileByCode failed',
  )
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
 * NATS KV bucket; durable file bytes use the persistent (no-TTL) object
 * bucket, so they never expire.
 */
export interface BlobStore {
  put(code: string, meta: FileRecord, data: Uint8Array): Promise<void>
  get(code: string): Promise<{ meta: FileRecord; data: Uint8Array }>
  stat(code: string): Promise<FileRecord | null>
}

/**
 * NATS JetStream backend: bytes → persistent object bucket, meta → KV.
 */
function makeNatsStore(bus: Bus): BlobStore {
  return {
    async put(code, _meta, data) {
      await bus.objectPutPersistent(code, Uint8Array.from(data))
    },
    async get(code) {
      const data = await bus.objectGetPersistent(code)
      if (data === null) throw new Error(`file not found: ${code}`)
      const meta = await fileByCode(bus, code)
      return {
        meta:
          meta.isOk() && meta.value !== null
            ? meta.value
            : ({ code } as FileRecord),
        data: Uint8Array.from(data),
      }
    },
    async stat(code) {
      const data = await bus.objectGetPersistent(code)
      if (data === null) return null
      const meta = await fileByCode(bus, code)
      return meta.isOk() && meta.value !== null
        ? meta.value
        : ({ code } as FileRecord)
    },
  }
}

/** Build the file blob backend (NATS object store + KV metadata). */
export function makeBlobStore(bus: Bus): BlobStore {
  return makeNatsStore(bus)
}
