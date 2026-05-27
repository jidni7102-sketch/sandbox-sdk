# Vite dev server with Cloudflare Sandbox

An example demonstrating a Vite React application embedded in a sandbox hosted by a Vite React application. A "counter" script changes the sandbox App.jsx file to demonstrate hot module reloading (HMR).

## Setup

Start the development server:

```bash
npm start
```

## Usage

This is a non-interactive demo. The counter in the host frame will increment once per second using the host HMR server. The counter in the iframed sandbox will decrement once per second to demonstrate that the hot module reloading is working over websockets between browser and sandbox.

## Deploy

```bash
npm run deploy
```

## Tunnel reconciler

The worker is wired up as a daily cron trigger (`0 3 * * *`, see `wrangler.jsonc`) that sweeps abandoned Cloudflare Tunnels and orphaned DNS records out of the account. This catches the case where a sandbox is evicted, restarted, or otherwise outlives the caller before it can run its own `destroy()` cleanup.

The wiring is a single line via the `withScheduledTunnelCleanup` helper from `@cloudflare/sandbox/tunnels` (see `src/worker.js`):

```js
import { withScheduledTunnelCleanup } from '@cloudflare/sandbox/tunnels';

export default {
  scheduled: withScheduledTunnelCleanup({
    staleAfterMs: 24 * 60 * 60_000
  })()
  // … fetch handler etc.
};
```

If you already have a `scheduled` handler, pass it to the inner call and both will run on every cron tick:

```js
scheduled: withScheduledTunnelCleanup({ staleAfterMs: 24 * 60 * 60_000 })(
  async (event, env, ctx) => {
    // your own scheduled work
  }
),
```

The handler is a no-op unless `CLOUDFLARE_API_TOKEN` is configured — the example deploys without it. To enable:

```bash
wrangler secret put CLOUDFLARE_API_TOKEN
wrangler secret put CLOUDFLARE_ACCOUNT_ID   # optional; inferred from a single-account token
wrangler secret put CLOUDFLARE_ZONE_ID      # optional; inferred from a single-zone token
```

The token needs `Account → Cloudflare Tunnel: Edit` and `Zone → DNS: Edit` on the zone(s) the SDK provisions records in. Read-only scopes are not enough — the reconciler issues `DELETE` calls.

### What gets deleted

A tunnel is considered stale when **all** of the following hold:

- `metadata.createdBy === 'sandbox-sdk'` (the SDK tags every tunnel it creates).
- `metadata.sandboxId` is set (safety net — untagged matches are reported under `errors` and never deleted).
- `status !== 'healthy'`.
- `max(conns_active_at, conns_inactive_at, created_at)` is older than 24h.

A DNS record is considered orphan when its `comment` starts with `sandbox-`, its `content` is `<tunnel-id>.cfargotunnel.com`, and that tunnel id is missing from the live tunnel list at sweep time.

### Tuning the threshold

24 hours is a sensible default: long enough to absorb cloudflared reconnect storms, short enough to stay under the per-account tunnel quota. Lower it if you mint and discard tunnels rapidly; raise it if your sandboxes routinely run quiet for long periods between reconnects.

Pass `dryRun: true` to `withScheduledTunnelCleanup` for the first run after deploying — the result is logged via `console.log('tunnel sweep', …)` and you can confirm the candidate set before enabling destructive mode.

### Inspecting results

Each run logs a JSON payload of the form:

```json
{
  "tunnelsScanned": 12,
  "tunnelsDeleted": [{ "id": "…", "name": "…" }],
  "dnsScanned": 3,
  "dnsDeleted": [{ "id": "…", "name": "…" }],
  "errors": []
}
```

Wire `errors.length > 0` to an alert; per-resource failures don't abort the sweep, so a single transient 5xx surfaces here without affecting the rest of the run.

## Implementation Notes

Hosting two Vite servers on the same port along with the Cloudflare wrangler server has the potential for unexpected behavior.

We refer to the current directory as the "host" server and the one loaded in the sandbox as the "sandbox" server. The Cloudflare services (workers, assets, storage etc.) are referred to as wrangler. Configuration for the host Vite server is in the root vite.config.js, the Cloudflare config is in wrangler.jsonc and the sandbox Vite config is in sandbox-app/vite.config.js.

This repository has been setup in a way to reduce the confusion.

1.  We assume static assets will be served by Cloudflare. The host Vite server has `appType` set to `"custom"` to disable Vite handling HTML.
2.  A `base` path of `/_/` has been set on the sandbox Vite server to minimize path conflicts with the Cloudflare asset server. If this still causes issues or is not suitable for your application then setting `assets.run_worker_first` can act as a workaround (see note below).
3.  The host hot module reloading server is configured under `server.hmr` and has been set to run on a different port to the Vite dev server. This reduces the chance of conflicts between the host and sandbox HMR websockets.
4.  We configure the host server via environment variables, namely `base` via `VITE_BASE`, `server.port` via `VITE_PORT` and `server.hmr.clientPort` via the `VITE_HMR_CLIENT_PORT` environment variables so that the sandboxed HMR server is configured correctly for both development and production config.

### Troubleshooting

Depending on your Vite configuration and application setup the above setup may still not work.

1.  Set `run_worker_first`. This can be used to explicitly run the worker for certain paths, such as the Vite base, this might be needed if your sandbox is not receiving expected requests due
    to Cloudflare handling them too early.

    ```jsonc
    // wrangler.jsonc
    "assets": {
        "not_found_handling": "none",
        "run_worker_first": ["/_/*"]
    },
    ```

2.  Always run the worker before Cloudflare asset handling. This will be needed if your sandbox server cannot use the Vite `base` setting, for example if you're running external code with little control over routing. Note that with this approach you will either need to exclude any assets you explicitly want served by Cloudflare or handle these manually in your worker with a service binding.

    ```jsonc
    // wrangler.jsonc
    "assets": {
        "binding": "Assets",
        "not_found_handling": "none",
        "run_worker_first": ["/*", "!/assets"]
    },
    ```

    With service binding:

    ```js
    async fetch(request, env) {
      // Handle any preview URL requests first.
      const response = await proxyToSandbox(request, env);
      if (response) return response

      // worker code

      // Finally fallback to serving assets.
      return env.Assets.fetch(request);
    }
    ```
