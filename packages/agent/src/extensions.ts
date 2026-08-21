import {
  ExtensionManifestSchema,
  type ExtensionVariable,
  ExtensionVariableSchema,
  ExtensionVariableValueSchema,
} from '@rucoder-agent/schema'
import { ResultAsync } from 'neverthrow'
import type { Bus } from './bus.js'
import { parse } from './json.js'

/**
 * Extension-server discovery + template-variable resolution over NATS.
 *
 * There is no HTTP discovery and no static server list: an extension is any
 * NATS client that (a) subscribes to `rucoder.extension.discover` and replies
 * with its `ExtensionManifestSchema` JSON, and (b) optionally answers
 * `extension.{id}.prompt.variable.{name}` requests with an
 * `ExtensionVariableValueSchema` reply. This keeps the contract language
 * agnostic — Go/Rust/Python clients generate their types from
 * `dist/extension-schema.json`.
 */

/** NATS subject an extension must subscribe to for discovery. */
export const EXTENSION_DISCOVER_SUBJECT = 'rucoder.extension.discover'

/** NATS subject a variable-resolution request goes to. */
export const extVariableSubject = (id: string, name: string) =>
  `extension.${id}.prompt.variable.${name}`

/** A discovered extension with its declared template variables. */
export interface ResolvedExtension {
  id: string
  variables: ExtensionVariable[]
}

const VAR_TOKEN = /\{\{ext\.([^.}]+)\.([^}]+)\}\}/g

/**
 * Discover every reachable prompt-capable extension via a NATS broadcast.
 * Each reply is validated against `ExtensionManifestSchema`; malformed replies
 * are skipped. Returns after `maxWaitMs` has elapsed.
 */
export function discoverExtensions(
  bus: Bus,
  maxWaitMs = 500,
): ResultAsync<ResolvedExtension[], string> {
  return bus
    .requestMany(EXTENSION_DISCOVER_SUBJECT, {}, maxWaitMs)
    .map(replies => {
      const out: ResolvedExtension[] = []
      const seen = new Map<string, boolean>()
      for (const bytes of replies) {
        const parsed = parse(ExtensionManifestSchema, bytes)
        if (parsed.isErr()) continue
        const m = parsed.value
        if (!m.capabilities.includes('prompt')) continue
        if (seen.has(m.id)) continue
        seen.set(m.id, true)
        out.push({
          id: m.id,
          variables: m.prompt?.variables ?? [],
        })
      }
      return out
    })
}

/**
 * Resolve one extension template variable to a string. Returns an `ok` with the
 * value, or an `err` describing the failure (callers leave the literal
 * `{{ext...}}` placeholder in place on error, per the preview contract).
 */
export function resolveExtensionVariable(
  bus: Bus,
  id: string,
  name: string,
): ResultAsync<string, string> {
  return bus.request(extVariableSubject(id, name), { name }).andThen(bytes => {
    const r = parse(ExtensionVariableValueSchema, bytes)
    if (r.isErr()) {
      return ResultAsync.fromSafePromise<string, string>(
        Promise.reject(new Error(r.error)),
      )
    }
    return ResultAsync.fromSafePromise(Promise.resolve(r.value.value))
  })
}

/** Built-in variables the agent resolves itself (no extension required). */
function builtinVariableValue(name: string): string | null {
  switch (name) {
    case 'date':
      return new Date().toISOString().slice(0, 10)
    case 'datetime':
      return new Date().toISOString()
    default:
      return null
  }
}

/**
 * Render a system-prompt template, substituting `{{ext.<id>.<name>}}` tokens
 * (resolved over NATS) and built-in `{{date}}` / `{{datetime}}` tokens. Tokens
 * that cannot be resolved are left as literal placeholders.
 */
export async function renderTemplate(
  template: string,
  bus: Bus,
): Promise<string> {
  const matches = [...template.matchAll(VAR_TOKEN)]
  if (matches.length === 0) return template

  let out = template
  for (const match of matches) {
    const full = match[0]
    const id = match[1]
    const name = match[2]

    const builtin = builtinVariableValue(name)
    if (builtin !== null) {
      out = out.split(full).join(builtin)
      continue
    }

    const resolved = await resolveExtensionVariable(bus, id, name)
    if (resolved.isOk()) {
      out = out.split(full).join(resolved.value)
    }
  }
  return out
}

// Re-export the variable schema so extension authors can build manifests.
export { ExtensionVariableSchema }
