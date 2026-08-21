import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogle } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ProviderRow } from '@rucoder-agent/schema'
import type { LanguageModel } from 'ai'
import { err, ok, type Result } from 'neverthrow'
import { z } from 'zod'
import type { ServerConfig } from './config.js'
import type { Db } from './db-client.js'
import { findProviderForModel, Providers } from './db-providers.js'
import { parse } from './json.js'

const HeadersSchema = z.record(z.string(), z.string())

export interface ProviderCredentials {
  apiType: string
  baseUrl: string
  apiKey: string
  headers: Record<string, string>
}

const KNOWN_API_TYPES = new Set([
  'anthropic',
  'claude',
  'openai',
  'openai-compatible',
  'openai_compatible',
  'deepseek',
  'google',
  'gemini',
])

export function validateApiType(apiType: string): Result<void, string> {
  return KNOWN_API_TYPES.has(apiType.toLowerCase())
    ? ok(undefined)
    : err(
        `unknown api type: ${apiType} (expected anthropic|openai|openai-compatible|deepseek|google)`,
      )
}

/** Pure model factory — mirrors recoder's provider.ts. */
export function buildModelForApiType(
  credentials: ProviderCredentials,
  modelId: string,
): Result<LanguageModel, string> {
  const apiType = credentials.apiType.toLowerCase()
  const { baseUrl, apiKey, headers } = credentials
  const baseURL = baseUrl ? { baseURL: baseUrl } : {}

  switch (apiType) {
    case 'deepseek':
      return ok(
        createDeepSeek({ ...baseURL, apiKey, headers }).languageModel(modelId),
      )
    case 'anthropic':
    case 'claude':
      return ok(
        createAnthropic({ ...baseURL, apiKey, headers }).languageModel(modelId),
      )
    case 'openai':
      return ok(
        createOpenAI({ ...baseURL, apiKey, headers }).languageModel(modelId),
      )
    case 'google':
    case 'gemini':
      return ok(
        createGoogle({ ...baseURL, apiKey, headers }).languageModel(modelId),
      )
    case 'openai-compatible':
    case 'openai_compatible':
      return ok(
        createOpenAICompatible({
          name: 'openai-compatible',
          baseURL: baseUrl,
          apiKey,
          headers,
          includeUsage: true,
        }).languageModel(modelId),
      )
    default:
      return err(`unknown api type: ${apiType}`)
  }
}

export interface ResolvedModel {
  model: LanguageModel
  modelId: string
}

/**
 * Per-request provider resolution with a client cache. A model advertised by
 * a registered provider is served by that provider; anything else falls back
 * to the bootstrap default (env-configured).
 */
export class LlmRegistry {
  private readonly cache = new Map<string, LanguageModel>()

  constructor(private readonly config: ServerConfig) {}

  invalidate(): void {
    this.cache.clear()
  }

  defaultModelId(): string {
    return this.config.llmModel
  }

  async resolve(
    db: Db,
    modelId: string,
  ): Promise<Result<ResolvedModel, string>> {
    const id = modelId === '' ? this.config.llmModel : modelId
    const rows = await Providers.list(db)
    if (rows.isErr()) return err(rows.error)
    return this.resolveRows(rows.value, id)
  }

  /** Pure resolution over a provider snapshot (unit-testable). */
  resolveRows(
    rows: ProviderRow[],
    modelId: string,
  ): Result<ResolvedModel, string> {
    const hit = findProviderForModel(rows, modelId)
    if (hit !== null) {
      const cached = this.cache.get(hit.provider_id)
      if (cached !== undefined) return ok({ model: cached, modelId })
      const creds: ProviderCredentials = {
        apiType: hit.api_type,
        baseUrl: hit.base_url,
        apiKey: hit.api_key,
        headers: parseHeaders(hit.headers),
      }
      const built = buildModelForApiType(creds, modelId)
      if (built.isOk()) {
        this.cache.set(hit.provider_id, built.value)
        return ok({ model: built.value, modelId })
      }
      // Invalid provider row: log-and-fallthrough to the default below.
      console.warn(
        `[lib-llm] provider ${hit.provider_id} unusable: ${built.error}`,
      )
    }
    const fallback = buildModelForApiType(
      {
        apiType: this.config.llmApiType,
        baseUrl: this.config.llmBaseUrl,
        apiKey: this.config.llmApiKey,
        headers: {},
      },
      modelId,
    )
    return fallback.map(model => ({ model, modelId }))
  }
}

function parseHeaders(raw: string): Record<string, string> {
  return parse(HeadersSchema, raw).match(
    headers => headers,
    () => ({}),
  )
}
