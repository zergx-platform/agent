import { buildRoutes } from './routes/index.js'

/**
 * The API app with its routes mounted at the root. Kept module-level so the
 * UI can derive a fully type-safe Hono client via `hc<AppType>()` — routes,
 * `:id` params, request bodies and response shapes all flow from the real
 * server router.
 *
 * The `/api/v1` prefix is applied at runtime in `index.ts` (via `.route`), but
 * the client already includes that prefix in its base URL, so the exported
 * type keeps root-relative paths (`/sessions`, `/providers`, `/models`, ...).
 *
 * Runtime concerns (deps injection, error handler, SEA static serving) are
 * attached in `index.ts`.
 */
export const app = buildRoutes()

export type AppType = typeof app
