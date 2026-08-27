# Extension Server Protocol

The zergx-agent is extended via **extension servers**: independent processes
that contribute tools and system-prompt template variables to the agent.

Transport is **NATS only**. There is no HTTP discovery and no static server
list — an extension registers itself implicitly by subscribing to the correct
NATS subjects.

The contract is defined in `packages/schema/src/index.ts` as zod schemas. The
single source of truth for non-TS languages is
`packages/schema/dist/extension-schema.json` (generated from those schemas by
`scripts/gen-extension-schema.mjs`). Go/Rust/Python/… implementations generate
their message types from that JSON Schema.

## Subjects

| Purpose      | Subject                                  | Direction            |
| ------------ | ---------------------------------------- | -------------------- |
| Discovery    | `zergx.extension.discover`             | agent → extensions   |
| Variable     | `extension.{id}.prompt.variable.{name}`  | agent → one extension |

Tool execution reuses the tool contract with **namespaced subjects** (see
`packages/agent/src/tools.ts`):

| Purpose      | Subject                                | Direction          |
| ------------ | -------------------------------------- | ------------------ |
| Tool call    | `tool.call.{extension-id}.{tool}`      | agent → extension  |
| Tool result  | `tool.result.{call_id}`                | extension → agent  |

The extension id prefix prevents tool-name collisions: two extensions may
both expose a `write` without intercepting each other's calls. Agents MUST
record the owning extension id at discovery time and publish to the
namespaced subject; extension SDKs (Go ≥ v0.1.4, TS) subscribe it
automatically.

## Discovery

When the agent needs tool manifests or wants to resolve template variables, it
broadcasts an empty request to `zergx.extension.discover` using NATS
request/reply fan-out (`requestMany`, timer strategy).

Every extension subscribes to `zergx.extension.discover` and replies with a
single message whose JSON shape is `ExtensionManifestSchema`:

```jsonc
{
  "id": "my-extension",          // string, unique
  "version": "1.0.0",            // string
  "capabilities": ["tools", "prompt"],  // subset of ["tools", "prompt"]
  "tools": [                     // present iff "tools" capability
    {
      "name": "example_tool",    // string
      "description": "...",      // string
      "input_schema": {}         // JSON Schema, optional
    }
  ],
  "prompt": {                    // present iff "prompt" capability
    "variables": [
      { "name": "org", "description": "..." }  // name required, description optional
    ]
  }
}
```

The agent collects all replies, deduplicates by `id`, and skips malformed
replies. Discovery returns after a short timeout (default 500ms, configurable
via `RUCODER_EXTENSION_DISCOVER_MS`).

## Tools

If an extension advertises `tools` capability, the agent exposes each tool in
`manifest.tools` to the model. Execution is unchanged from the existing tool
contract:

- The agent publishes `tool.call.{name}` with `{ call_id, arguments }`.
- The extension publishes a result to `tool.result.{call_id}` with
  `{ call_id, tool, content, metadata, content_object? }`. Large results may be
  offloaded to the Object Store via `content_object`; otherwise `content` is the
  natural-language text fed back to the model.

## Prompt template variables

If an extension advertises `prompt` capability, the preset `system_prompt` may
reference its variables using the syntax:

```
{{ext.<extension-id>.<variable-name>}}
```

For example, an extension with `id: "myext"` declaring variable `org`:

```
You are working in the {{ext.myext.org}} organization.
```

To resolve a variable, the agent sends a request to
`extension.{id}.prompt.variable.{name}` with body `{ "name": "..." }`. The
extension replies with `ExtensionVariableValueSchema`:

```jsonc
{ "name": "org", "value": "acme" }
```

If resolution fails (timeout / unreachable / malformed), the agent leaves the
literal `{{ext...}}` placeholder in the rendered prompt.

### Built-in variables

The agent also resolves a small set of built-ins without any extension:

| Token        | Meaning                      |
| ------------ | ---------------------------- |
| `{{date}}`   | `YYYY-MM-DD` today (UTC)     |
| `{{datetime}}` | ISO-8601 timestamp (UTC)   |

## Preview

`GET /api/v1/presets/{id}/preview` returns `{ template, rendered }` where
`rendered` is the result of substituting built-ins and (reachable) extension
variables into the preset `system_prompt`. Session-scoped variables are not
resolved in preview and remain as literal placeholders.

## Reference implementation notes

- **TypeScript** (in-repo): import the zod schemas directly from
  `@zergx-agent/schema`. See `packages/agent/src/extensions.ts` for the agent
  side; an extension is just a NATS client that (a) subscribes to
  `zergx.extension.discover` and replies with the manifest, and (b) optionally
  subscribes to `extension.{id}.prompt.variable.*`.
- **Go / Rust / Python**: generate types from
  `packages/schema/dist/extension-schema.json` (e.g. `quicktype`,
  `oapi-codegen`, or the language's JSON-Schema codegen), then implement the two
  subscriptions above with the language's NATS client.
