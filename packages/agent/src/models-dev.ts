import type { Provider } from '@opencode-ai/models'
import { Models } from '@opencode-ai/models'
import { ResultAsync } from 'neverthrow'
import type { Bus } from './bus.js'

/**
 * Fetch the models.dev provider catalog using the official typed client and
 * cache it in the NATS KV (30-minute TTL) so any replica can serve provider
 * prefill hints. The KV entry self-expires; `refreshModelsDev` re-pulls on
 * startup or on demand.
 */

export type CatalogProvider = Provider

const client = Models.make()

/** Fetch the catalog and cache it into the NATS KV. */
export function refreshModelsDev(bus: Bus): ResultAsync<void, string> {
  return ResultAsync.fromPromise(
    client.providers(),
    e => `models.dev fetch: ${String(e)}`,
  ).andThen(providers => bus.putModelsDev(JSON.stringify(providers)))
}
