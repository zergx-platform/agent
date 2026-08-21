"use strict";

// packages/server/src/index.ts
var import_node_module = require("node:module");
var import_node_server = require("@hono/node-server");
var import_agent4 = require("@rucoder-agent/agent");
var import_hono5 = require("hono");
var import_http_exception = require("hono/http-exception");

// packages/server/src/routes/index.ts
var import_hono4 = require("hono");

// packages/server/src/routes/config.ts
var import_zod_validator = require("@hono/zod-validator");
var import_agent = require("@rucoder-agent/agent");
var import_schema = require("@rucoder-agent/schema");
var import_hono = require("hono");
var import_neverthrow = require("neverthrow");
var import_zod = require("zod");
var ModelsArraySchema = import_zod.z.array(import_zod.z.string());
var HeadersRecordSchema = import_zod.z.record(import_zod.z.string(), import_zod.z.unknown());
var configRoutes = new import_hono.Hono();
configRoutes.get("/presets", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent.Presets.list(db);
  return r.isErr() ? c.json({ ok: false, error: r.error }, 500) : c.json(r.value);
});
configRoutes.post("/presets", (0, import_zod_validator.zValidator)("json", import_schema.PresetBodySchema), async (c) => {
  const { db } = c.get("deps");
  const b = c.req.valid("json");
  const r = await import_agent.Presets.upsert(db, {
    id: b.id,
    systemPrompt: b.system_prompt ?? "",
    tools: JSON.stringify(b.tools ?? []),
    maxTurns: b.max_turns ?? 0
  });
  return r.isErr() ? c.json({ ok: false, error: r.error }, 500) : c.json({ ok: true });
});
configRoutes.delete("/presets/:id", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent.Presets.delete(db, c.req.param("id"));
  return r.isErr() ? c.json({ ok: false, error: r.error }, 500) : c.json({ ok: true });
});
configRoutes.get("/config", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent.Config.get(db, "providers");
  const providers = r.isOk() && r.value !== null ? (0, import_agent.parseLoose)(r.value).unwrapOr({}) : {};
  return c.json({ providers });
});
configRoutes.get("/config/:key", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent.Config.get(db, c.req.param("key"));
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  return r.value === null ? c.json({ ok: false, error: "config not found" }, 404) : c.json({ key: c.req.param("key"), value: r.value });
});
configRoutes.put("/config", (0, import_zod_validator.zValidator)("json", import_schema.ConfigBodySchema), async (c) => {
  const { db } = c.get("deps");
  const b = c.req.valid("json");
  const r = await import_agent.Config.set(db, b.key, b.value);
  return r.isErr() ? c.json({ ok: false, error: r.error }, 500) : c.json({ ok: true });
});
configRoutes.get("/tool-config", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent.Config.get(db, "tool_config");
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  const value = r.value === null ? {} : (0, import_agent.parseLoose)(r.value).unwrapOr({});
  return c.json(value);
});
configRoutes.put("/tool-config", async (c) => {
  const { db } = c.get("deps");
  const body = await import_neverthrow.ResultAsync.fromPromise(c.req.json(), () => null);
  if (body.isErr() || body.value === null) {
    return c.json({ ok: false, error: "invalid json body" }, 400);
  }
  const r = await import_agent.Config.set(db, "tool_config", JSON.stringify(body.value));
  return r.isErr() ? c.json({ ok: false, error: r.error }, 500) : c.json({ ok: true, config: body.value });
});
configRoutes.get("/tools", async (c) => {
  const deps = c.get("deps");
  const tools = await (0, import_agent.discoverTools)(deps.config.toolServers);
  return c.json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description
    }))
  });
});
configRoutes.get("/models", async (c) => {
  const { db, llm } = c.get("deps");
  const r = await import_agent.Providers.list(db);
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  const models = [];
  for (const p of r.value) {
    const arr = (0, import_agent.parse)(ModelsArraySchema, p.models);
    if (arr.isOk()) models.push(...arr.value);
  }
  if (!models.includes(llm.defaultModelId()))
    models.unshift(llm.defaultModelId());
  return c.json({ models });
});
configRoutes.get("/recore-config", async (c) => {
  const deps = c.get("deps");
  const r = await import_agent.Providers.list(deps.db);
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  const providers = {};
  for (const p of r.value) {
    providers[p.provider_id] = {
      provider_id: p.provider_id,
      api_type: p.api_type,
      base_url: p.base_url,
      api_key: p.api_key,
      headers: (0, import_agent.parse)(HeadersRecordSchema, p.headers).unwrapOr({}),
      models: (0, import_agent.parse)(ModelsArraySchema, p.models).unwrapOr([])
    };
  }
  return c.json({
    providers,
    cdp_url: process.env.RUCODER_CDP_URL ?? "",
    http_proxy: process.env.RUCODER_HTTP_PROXY ?? "",
    self_base: process.env.RUCODER_SELF_BASE ?? ""
  });
});

// packages/server/src/routes/providers.ts
var import_zod_validator2 = require("@hono/zod-validator");
var import_agent2 = require("@rucoder-agent/agent");
var import_schema2 = require("@rucoder-agent/schema");
var import_hono2 = require("hono");
var import_neverthrow2 = require("neverthrow");
var import_zod2 = require("zod");
var HeadersRecordSchema2 = import_zod2.z.record(import_zod2.z.string(), import_zod2.z.unknown());
var ModelsArraySchema2 = import_zod2.z.array(import_zod2.z.string());
function providerToJson(p) {
  const headers = (0, import_agent2.parse)(HeadersRecordSchema2, p.headers);
  const models = (0, import_agent2.parse)(ModelsArraySchema2, p.models);
  return {
    provider_id: p.provider_id,
    api_type: p.api_type,
    base_url: p.base_url,
    api_key: p.api_key,
    headers: headers.isOk() ? headers.value : {},
    models: models.isOk() ? models.value : []
  };
}
var providerRoutes = new import_hono2.Hono();
providerRoutes.get("/", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent2.Providers.list(db);
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  const providers = {};
  for (const p of r.value) providers[p.provider_id] = providerToJson(p);
  return c.json({ providers });
});
providerRoutes.get("/catalog", async (c) => {
  const { bus } = c.get("deps");
  const result = await bus.getModelsDev();
  if (result.isErr()) return c.json({ ok: false, error: result.error }, 500);
  return c.json({ catalog: result.value ?? {} });
});
providerRoutes.post("/", (0, import_zod_validator2.zValidator)("json", import_schema2.ProviderBodySchema), async (c) => {
  const deps = c.get("deps");
  const b = c.req.valid("json");
  const valid = (0, import_agent2.validateApiType)(b.api_type);
  if (valid.isErr()) return c.json({ ok: false, error: valid.error }, 400);
  if (!b.base_url.startsWith("http://") && !b.base_url.startsWith("https://")) {
    return c.json({ ok: false, error: "base_url must be http(s)" }, 400);
  }
  const r = await import_agent2.Providers.upsert(deps.db, {
    providerId: b.provider_id,
    apiType: b.api_type,
    baseUrl: b.base_url,
    apiKey: b.api_key ?? "",
    headers: b.headers ?? null,
    models: b.models ?? []
  });
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  deps.llm.invalidate();
  return c.json({ ok: true, provider_id: b.provider_id });
});
providerRoutes.delete("/:id", async (c) => {
  const deps = c.get("deps");
  const r = await import_agent2.Providers.delete(deps.db, c.req.param("id"));
  if (r.isErr()) return c.json({ ok: false, error: r.error }, 500);
  deps.llm.invalidate();
  return c.json({ deleted: true });
});
providerRoutes.post(
  "/test",
  (0, import_zod_validator2.zValidator)("json", import_schema2.ProviderTestBodySchema),
  async (c) => {
    c.get("deps");
    const b = c.req.valid("json");
    const url = `${b.base_url.replace(/\/$/, "")}/models`;
    const result = await import_neverthrow2.ResultAsync.fromPromise(
      fetch(url, {
        headers: b.api_key !== void 0 && b.api_key !== "" ? { authorization: `Bearer ${b.api_key}` } : {},
        signal: AbortSignal.timeout(1e4)
      }),
      () => "provider test: network error"
    );
    if (result.isErr()) {
      return c.json({ ok: false, error: result.error });
    }
    const res = result.value;
    if (!res.ok) {
      return c.json({ ok: false, error: `HTTP ${res.status}` });
    }
    const body = await import_neverthrow2.ResultAsync.fromPromise(
      res.json().then((v) => v),
      () => "provider test: invalid json"
    );
    if (body.isErr()) {
      return c.json({ ok: false, error: body.error });
    }
    return c.json({ ok: true, models: body.value.data ?? null });
  }
);

// packages/server/src/routes/sessions.ts
var import_zod_validator3 = require("@hono/zod-validator");
var import_agent3 = require("@rucoder-agent/agent");
var import_schema3 = require("@rucoder-agent/schema");
var import_hono3 = require("hono");
var import_streaming = require("hono/streaming");
var import_neverthrow3 = require("neverthrow");
var import_zod3 = require("zod");

// packages/server/src/context.ts
var EidDedup = class {
  constructor(cap = 4096) {
    this.cap = cap;
  }
  cap;
  seen = /* @__PURE__ */ new Set();
  order = [];
  evict() {
    while (this.order.length > this.cap) {
      const old = this.order.shift();
      if (old !== void 0) this.seen.delete(old);
    }
  }
  mark(eid) {
    if (eid === void 0 || this.seen.has(eid)) return;
    this.seen.add(eid);
    this.order.push(eid);
    this.evict();
  }
  /** True when the eid was already seen (and is now marked). */
  duplicate(eid) {
    if (eid === void 0) return false;
    if (this.seen.has(eid)) return true;
    this.seen.add(eid);
    this.order.push(eid);
    while (this.order.length > this.cap * 2) {
      const old = this.order.shift();
      if (old !== void 0) this.seen.delete(old);
    }
    return false;
  }
};

// packages/server/src/routes/sessions.ts
function sessionToJson(s) {
  return { ...s, base_image: null, unread: 0 };
}
function err500(c, message) {
  return c.json({ ok: false, error: message }, 500);
}
function triggerClaim(deps, sid) {
  void (0, import_agent3.runSessionTurn)(deps, sid).then(
    () => {
    },
    (e) => console.error(`[agent] turn crashed (${sid}): ${String(e)}`)
  );
}
var sessionRoutes = new import_hono3.Hono();
sessionRoutes.get("/", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent3.Sessions.list(db);
  return r.isErr() ? err500(c, r.error) : c.json({ sessions: r.value.map(sessionToJson) });
});
sessionRoutes.post(
  "/",
  (0, import_zod_validator3.zValidator)("json", import_schema3.CreateSessionBodySchema),
  async (c) => {
    const { db } = c.get("deps");
    const b = c.req.valid("json");
    const exists = await import_agent3.Sessions.exists(db, b.name);
    if (exists.isErr()) return err500(c, exists.error);
    if (exists.value) {
      return c.json({ ok: false, error: "Session already exists" }, 409);
    }
    const name = await import_agent3.Sessions.create(db, b);
    return name.isErr() ? err500(c, name.error) : c.json({ ok: true, session_name: name.value });
  }
);
sessionRoutes.get("/:id", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent3.Sessions.get(db, c.req.param("id"));
  if (r.isErr()) return err500(c, r.error);
  return r.value === null ? c.json({ ok: false, error: "session not found" }, 404) : c.json({ session: sessionToJson(r.value) });
});
sessionRoutes.delete("/:id", async (c) => {
  const { db } = c.get("deps");
  const id = c.req.param("id");
  (0, import_agent3.interruptRun)(id);
  const r = await import_agent3.Sessions.delete(db, id);
  return r.isErr() ? err500(c, r.error) : c.json({ ok: true });
});
sessionRoutes.get("/:id/messages", async (c) => {
  const { db } = c.get("deps");
  const sid = c.req.param("id");
  const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
  const before = c.req.query("before") ?? null;
  const tipRes = await import_agent3.Sessions.tip(db, sid);
  const tipId = tipRes.isErr() ? null : tipRes.value;
  const r = await import_agent3.Messages.chain(db, tipId, limit, before);
  return r.isErr() ? err500(c, r.error) : c.json({ messages: r.value });
});
sessionRoutes.post(
  "/:id/prompt",
  (0, import_zod_validator3.zValidator)("json", import_schema3.PromptBodySchema),
  async (c) => {
    const deps = c.get("deps");
    const sid = c.req.param("id");
    const { prompt } = c.req.valid("json");
    const session = await import_agent3.Sessions.get(deps.db, sid);
    if (session.isErr()) return err500(c, session.error);
    if (session.value === null) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    const tipRes = await import_agent3.Sessions.tip(deps.db, sid);
    const tipId = tipRes.isErr() ? null : tipRes.value;
    const insert = await import_agent3.Messages.insert(deps.db, "user", prompt, tipId);
    if (insert.isErr()) return err500(c, insert.error);
    await import_agent3.Sessions.setTip(deps.db, sid, insert.value);
    const enq = await import_agent3.Mailbox.enqueue(deps.db, sid, "user_prompt", {
      text: prompt
    });
    if (enq.isErr()) return err500(c, enq.error);
    void deps.bus.publishStream((0, import_agent3.mailboxSubject)(sid), {
      type: "user_prompt",
      session_name: sid
    }).then(() => void 0);
    void triggerClaim(deps, sid);
    return c.json({ ok: true });
  }
);
var EidEventSchema = import_zod3.z.object({ eid: import_zod3.z.string().optional() }).passthrough();
async function sseHandler(c) {
  const { bus } = c.get("deps");
  const sid = c.req.param("id");
  if (sid === void 0) {
    return c.json({ ok: false, error: "session not found" }, 404);
  }
  return (0, import_streaming.streamSSE)(c, async (stream) => {
    const subject = (0, import_agent3.sseSubject)(sid);
    const subRes = await bus.subscribe(subject);
    if (subRes.isErr()) {
      await stream.writeSSE({
        data: JSON.stringify({
          event: "error",
          params: { message: subRes.error }
        })
      });
      return;
    }
    const sub = subRes.value;
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      sub.unsubscribe();
    });
    const dedup = new EidDedup();
    const replay = await bus.replayAll(import_agent3.STREAM_SSE, subject);
    if (replay.isOk()) {
      for (const raw of replay.value) {
        const v = EidEventSchema.safeParse(raw);
        if (!v.success) continue;
        dedup.mark(v.data.eid);
        await stream.writeSSE({ data: JSON.stringify(raw) });
      }
    }
    for await (const m of sub) {
      if (closed) break;
      const parsed = (0, import_agent3.parseLoose)(Buffer.from(m.data));
      if (!parsed.isOk()) continue;
      const v = EidEventSchema.safeParse(parsed.value);
      if (!v.success) continue;
      if (dedup.duplicate(v.data.eid)) continue;
      await stream.writeSSE({ data: JSON.stringify(parsed.value) });
    }
  });
}
sessionRoutes.get("/:id/stream", sseHandler);
sessionRoutes.get("/:id/events", sseHandler);
sessionRoutes.get("/:id/todos", async (c) => {
  const deps = c.get("deps");
  const url = `${deps.config.memoryUrl.replace(/\/$/, "")}/api/v1/todos?session_name=${c.req.param("id")}`;
  const res = await import_neverthrow3.ResultAsync.fromPromise(fetch(url), () => null);
  if (res.isErr() || res.value === null) {
    return err500(c, "memory service unreachable");
  }
  const body = await import_neverthrow3.ResultAsync.fromPromise(res.value.json(), () => ({}));
  return c.json(body.isOk() ? body.value : {});
});
sessionRoutes.post("/:id/fork", (0, import_zod_validator3.zValidator)("json", import_schema3.ForkBodySchema), async (c) => {
  const deps = c.get("deps");
  const pid = c.req.param("id");
  const b = c.req.valid("json");
  const parent = await import_agent3.Sessions.get(deps.db, pid);
  if (parent.isErr()) return err500(c, parent.error);
  if (parent.value === null) {
    return c.json({ ok: false, error: "session not found" }, 404);
  }
  const p = parent.value;
  const exists = await import_agent3.Sessions.exists(deps.db, b.name);
  if (exists.isErr()) return err500(c, exists.error);
  if (exists.value) {
    return c.json({ ok: false, error: "Session already exists" }, 409);
  }
  const name = await import_agent3.Sessions.create(deps.db, {
    name: b.name,
    model: p.model,
    preset: p.preset,
    tipId: p.tip_id
  });
  return name.isErr() ? err500(c, name.error) : c.json({ ok: true, session_name: name.value });
});
sessionRoutes.post(
  "/:id/rename",
  (0, import_zod_validator3.zValidator)("json", import_schema3.RenameBodySchema),
  async (c) => {
    const deps = c.get("deps");
    const oldName = c.req.param("id");
    const b = c.req.valid("json");
    if (b.name === oldName) {
      return c.json({ ok: true, session_name: oldName });
    }
    const parent = await import_agent3.Sessions.get(deps.db, oldName);
    if (parent.isErr()) return err500(c, parent.error);
    if (parent.value === null) {
      return c.json({ ok: false, error: "session not found" }, 404);
    }
    const exists = await import_agent3.Sessions.exists(deps.db, b.name);
    if (exists.isErr()) return err500(c, exists.error);
    if (exists.value) {
      return c.json({ ok: false, error: "Session already exists" }, 409);
    }
    const p = parent.value;
    const created = await import_agent3.Sessions.create(deps.db, {
      name: b.name,
      model: p.model,
      preset: p.preset,
      tipId: p.tip_id
    });
    if (created.isErr()) return err500(c, created.error);
    const removed = await import_agent3.Sessions.delete(deps.db, oldName);
    if (removed.isErr()) return err500(c, removed.error);
    return c.json({ ok: true, session_name: b.name });
  }
);
sessionRoutes.post(
  "/:id/model",
  (0, import_zod_validator3.zValidator)("json", import_schema3.ModelBodySchema),
  async (c) => {
    const { db } = c.get("deps");
    const r = await import_agent3.Sessions.setModel(
      db,
      c.req.param("id"),
      c.req.valid("json").model
    );
    return r.isErr() ? err500(c, r.error) : c.json({ model: c.req.valid("json").model });
  }
);
sessionRoutes.post("/:id/undo", (0, import_zod_validator3.zValidator)("json", import_schema3.UndoBodySchema), async (c) => {
  const deps = c.get("deps");
  const sid = c.req.param("id");
  const { message_id } = c.req.valid("json");
  const session = await import_agent3.Sessions.get(deps.db, sid);
  if (session.isErr()) return err500(c, session.error);
  const s = session.value;
  if (s === null) return c.json({ ok: false, error: "session not found" }, 404);
  const tip = s.tip_id;
  if (tip === null || tip === "") {
    return c.json({ ok: false, undone: false });
  }
  const targetId = message_id ?? tip;
  const target = await import_agent3.Messages.get(deps.db, targetId);
  if (target.isErr()) return err500(c, target.error);
  if (target.value === null) return c.json({ ok: false, undone: false });
  await import_agent3.Sessions.setTip(deps.db, sid, target.value.prev_id);
  return c.json({ ok: true, undone: true });
});
sessionRoutes.post("/:id/read", async (c) => c.json({ ok: true }));
sessionRoutes.get(
  "/:id/state",
  async (c) => c.json({ status: "idle", parts: [] })
);
sessionRoutes.get("/:id/mailbox", async (c) => {
  const { db } = c.get("deps");
  const r = await import_agent3.Mailbox.list(db, c.req.param("id"));
  return r.isErr() ? err500(c, r.error) : c.json({ entries: r.value });
});
sessionRoutes.get("/:id/changes", async (c) => {
  const { db } = c.get("deps");
  const sid = c.req.param("id");
  const tipRes = await import_agent3.Sessions.tip(db, sid);
  const tipId = tipRes.isErr() ? null : tipRes.value;
  const chain = await import_agent3.Messages.chain(db, tipId, 1e5, null);
  if (chain.isErr()) return err500(c, chain.error);
  const ids = chain.value.map((m) => m.id);
  const partsRes = await import_agent3.Parts.listByMessages(db, ids);
  if (partsRes.isErr()) return err500(c, partsRes.error);
  const changes = [];
  for (const p of partsRes.value) {
    if (p.type !== "tool" || p.change_id === null) continue;
    const data = (0, import_agent3.parse)(import_agent3.ToolPartDataSchema, p.data);
    const name = data.isOk() ? data.value.name : "tool";
    changes.push({
      change_id: p.change_id,
      tool_name: name,
      timestamp: "",
      message_id: p.message_id,
      content: "",
      seq: p.seq
    });
  }
  return c.json({ changes });
});
sessionRoutes.patch(
  "/:id/settings",
  (0, import_zod_validator3.zValidator)("json", import_schema3.SessionSettingsBodySchema),
  async (c) => {
    const { db } = c.get("deps");
    const sid = c.req.param("id");
    const b = c.req.valid("json");
    const r = await import_agent3.Sessions.updateSettings(db, sid, {
      model: b.model,
      preset: b.preset
    });
    if (r.isErr()) return err500(c, r.error);
    const s = await import_agent3.Sessions.get(db, sid);
    if (s.isErr()) return err500(c, s.error);
    return s.value === null ? c.json({ ok: false, error: "session not found" }, 404) : c.json({ session: sessionToJson(s.value) });
  }
);
sessionRoutes.post("/:id/interrupt", async (c) => {
  const deps = c.get("deps");
  const sid = c.req.param("id");
  (0, import_agent3.interruptRun)(sid);
  const enq = await import_agent3.Mailbox.enqueue(deps.db, sid, "interrupt", {});
  if (enq.isErr()) return err500(c, enq.error);
  void deps.bus.publishStream((0, import_agent3.mailboxSubject)(sid), {
    type: "interrupt",
    session_name: sid
  }).then(() => void 0);
  void triggerClaim(deps, sid);
  return c.json({ interrupted: true });
});

// packages/server/src/routes/index.ts
function buildRoutes() {
  const api = new import_hono4.Hono();
  api.get("/health", (c) => c.json({ ok: true, name: "rucoder-agent-ts" }));
  api.route("/sessions", sessionRoutes);
  api.route("/providers", providerRoutes);
  api.route("/", configRoutes);
  return api;
}

// packages/server/src/index.ts
var import_meta = {};
var MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
function getSeaAsset(key) {
  try {
    const require2 = (0, import_node_module.createRequire)(import_meta.url);
    const raw = require2("node:sea").getRawAsset(key);
    return raw ?? null;
  } catch {
    return null;
  }
}
function seaStatic() {
  return async (c) => {
    const path = new URL(c.req.url).pathname;
    const asset = path === "/" || !path.includes(".") ? "index.html" : path.slice(1);
    const data = getSeaAsset(asset);
    if (data === null) {
      const index = getSeaAsset("index.html");
      if (index === null) return c.json({ ok: false, error: "not found" }, 404);
      return new Response(index, {
        headers: { "content-type": "text/html" }
      });
    }
    const ext = asset.slice(asset.lastIndexOf("."));
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream"
      }
    });
  };
}
async function main() {
  const config = (0, import_agent4.loadConfig)();
  const dbRes = await (0, import_agent4.connectDb)(config.postgresUrl);
  if (dbRes.isErr()) {
    console.error(`[server] ${dbRes.error}`);
    process.exit(1);
  }
  const db = dbRes.value;
  const busRes = await (0, import_agent4.connectBus)(config.natsUrl);
  if (busRes.isErr()) {
    console.error(`[server] ${busRes.error} (event bus is required)`);
    process.exit(1);
  }
  const bus = busRes.value;
  const llm = new import_agent4.LlmRegistry(config);
  const deps = {
    db,
    sql: db.$client,
    bus,
    config,
    llm
  };
  const app = new import_hono5.Hono();
  app.onError((err, c) => {
    if (err instanceof import_http_exception.HTTPException) {
      if (err.res) return c.newResponse(err.res.body, err.res);
      return c.json({ ok: false, error: err.message }, err.status);
    }
    console.error("[server] unhandled error:", err);
    return c.json({ ok: false, error: "Internal Server Error" }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.route("/api/v1", buildRoutes());
  app.use("*", seaStatic());
  const stopWake = (0, import_agent4.watchMailboxWake)(deps);
  void (0, import_agent4.refreshModelsDev)(bus).then(
    () => {
    },
    (e) => console.warn(`[server] ${e}`)
  );
  const server = (0, import_node_server.serve)({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(
      `[server] rucoder-agent-ts listening on :${info.port} (pid ${process.pid})`
    );
  });
  const shutdown = () => {
    console.log("[server] shutting down");
    stopWake();
    server.close(() => {
      bus.close();
      void db.$client.end().then(
        () => process.exit(0),
        () => process.exit(0)
      );
      setTimeout(() => process.exit(0), 3e3).unref();
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const pending = await import_agent4.Mailbox.pendingSessions(db);
  if (pending.isOk()) {
    for (const sid of pending.value) {
      void (0, import_agent4.runSessionTurn)(deps, sid).then(
        () => {
        },
        (e) => console.error(`[agent] recovery turn crashed (${sid}): ${String(e)}`)
      );
    }
  }
}
void main();
