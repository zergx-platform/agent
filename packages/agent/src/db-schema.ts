import {
  type AnyPgColumn,
  bigint,
  integer,
  pgTable,
  text,
} from 'drizzle-orm/pg-core'

export const sessions = pgTable('sessions', {
  name: text('name').primaryKey(),
  model: text('model').notNull().default(''),
  preset: text('preset').notNull().default(''),
  tipId: text('tip_id'),
  maxTurns: integer('max_turns').notNull().default(0),
  systemPrompt: text('system_prompt').notNull().default(''),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  totalTokens: bigint('total_tokens', { mode: 'number' }).notNull().default(0),
  // Last single request (one LLM step), overwritten not accumulated. The
  // cumulative *_tokens above are reserved for billing/history; the chat
  // footer shows the most recent request's context size.
  lastInputTokens: bigint('last_input_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  lastOutputTokens: bigint('last_output_tokens', { mode: 'number' })
    .notNull()
    .default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastUsedAt: text('last_used_at'),
})

export const messages = pgTable('messages', {
  id: text('id').primaryKey(),
  role: text('role').notNull(),
  prevId: text('prev_id').references((): AnyPgColumn => messages.id, {
    onDelete: 'set null',
  }),
  createdAt: text('created_at').notNull(),
})

export const parts = pgTable('parts', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  seq: integer('seq').notNull().default(0),
  data: text('data').notNull().default('{}'),
})

export const mailbox = pgTable('mailbox', {
  id: text('id').primaryKey(),
  sessionName: text('session_name')
    .notNull()
    .references(() => sessions.name, { onDelete: 'cascade' }),
  msgType: text('msg_type').notNull(),
  payload: text('payload').notNull().default('{}'),
  effectiveAt: text('effective_at'),
  status: text('status').notNull().default('pending'),
  createdAt: text('created_at').notNull(),
  consumedAt: text('consumed_at'),
  seq: integer('seq'),
})

export const presets = pgTable('presets', {
  id: text('id').primaryKey(),
  systemPrompt: text('system_prompt').notNull().default(''),
  tools: text('tools').notNull().default('[]'),
  maxTurns: integer('max_turns').notNull().default(30),
})

export const config = pgTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default('{}'),
})

export const providers = pgTable('providers', {
  providerId: text('provider_id').primaryKey(),
  apiType: text('api_type').notNull().default('openai-compatible'),
  baseUrl: text('base_url').notNull(),
  apiKey: text('api_key').notNull().default(''),
  headers: text('headers').notNull().default('null'),
  models: text('models').notNull().default('[]'),
  createdAt: text('created_at').notNull().default(''),
  updatedAt: text('updated_at').notNull().default(''),
})
