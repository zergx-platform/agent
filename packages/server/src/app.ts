import { buildRoutes } from './routes/index.js'

/**
 * The API app with its routes mounted. Kept module-level so the UI can derive
 * a fully type-safe Hono client via `hc<AppType>()` — routes, `:id` params,
 * request bodies and response shapes all flow from the real server router.
 *
 * Following the E1 framework pattern: `buildRoutes()` returns the router
 * (root-relative paths), and `index.ts` mounts it under `/api/v1` at runtime
 * while injecting request deps via middleware on the mounting app.
 */
export const app = buildRoutes()

export type AppType = typeof app
