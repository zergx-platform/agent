import type { PresetRow } from '@rucoder-agent/schema'
import { eq } from 'drizzle-orm'
import type { ResultAsync } from 'neverthrow'
import type { Db } from './db-client.js'
import { q } from './db-client.js'
import { config, presets } from './db-schema.js'

export const Presets = {
  list(db: Db): ResultAsync<PresetRow[], string> {
    return q(
      () =>
        db
          .select()
          .from(presets)
          .orderBy(presets.id)
          .then(rows =>
            rows.map(r => ({
              id: r.id,
              system_prompt: r.systemPrompt,
              tools: r.tools,
              max_turns: r.maxTurns,
            })),
          ),
      'list presets',
    )
  },

  get(db: Db, id: string): ResultAsync<PresetRow | null, string> {
    return q(
      () =>
        db
          .select()
          .from(presets)
          .where(eq(presets.id, id))
          .limit(1)
          .then(rows => {
            const r = rows[0]
            return r === undefined
              ? null
              : {
                  id: r.id,
                  system_prompt: r.systemPrompt,
                  tools: r.tools,
                  max_turns: r.maxTurns,
                }
          }),
      'get preset',
    )
  },

  upsert(
    db: Db,
    row: { id: string; systemPrompt: string; tools: string; maxTurns: number },
  ): ResultAsync<void, string> {
    return q(
      () =>
        db
          .insert(presets)
          .values({
            id: row.id,
            systemPrompt: row.systemPrompt,
            tools: row.tools,
            maxTurns: row.maxTurns,
          })
          .onConflictDoUpdate({
            target: presets.id,
            set: {
              systemPrompt: row.systemPrompt,
              tools: row.tools,
              maxTurns: row.maxTurns,
            },
          }),
      'upsert preset',
    ).map(() => undefined)
  },

  delete(db: Db, id: string): ResultAsync<void, string> {
    return q(
      () => db.delete(presets).where(eq(presets.id, id)),
      'delete preset',
    ).map(() => undefined)
  },
}

export const Config = {
  get(db: Db, key: string): ResultAsync<string | null, string> {
    return q(
      () =>
        db
          .select({ value: config.value })
          .from(config)
          .where(eq(config.key, key))
          .limit(1)
          .then(rows => rows[0]?.value ?? null),
      'get config',
    )
  },

  set(db: Db, key: string, value: string): ResultAsync<void, string> {
    return q(
      () =>
        db
          .insert(config)
          .values({ key, value })
          .onConflictDoUpdate({ target: config.key, set: { value } }),
      'set config',
    ).map(() => undefined)
  },
}
