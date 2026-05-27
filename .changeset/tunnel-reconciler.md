---
'@cloudflare/sandbox': patch
---

Add a `@cloudflare/sandbox/tunnels` entrypoint with helpers for sweeping abandoned named tunnels and orphaned DNS records from your Cloudflare account. Useful for long-lived deployments where Durable Object cleanup may not run before tunnel resources are abandoned (e.g. DO eviction, crashes, missed `destroy()` calls). Designed to run from a cron-triggered Worker.

```ts
import { withScheduledTunnelCleanup } from '@cloudflare/sandbox/tunnels';

export default {
  scheduled: withScheduledTunnelCleanup({
    staleAfterMs: 24 * 60 * 60_000
  })()
};
```

The wrapper reads `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_ZONE_ID` from env at run time and is a no-op when the token is missing. To compose with an existing scheduled handler, pass it to the inner call:

```ts
scheduled: withScheduledTunnelCleanup({ staleAfterMs: 24 * 60 * 60_000 })(
  async (event, env, ctx) => {
    // your own scheduled work
  }
);
```

Cleanup only deletes tunnels tagged by this SDK and refuses to delete any tunnel that is missing its `metadata.sandboxId` tag, so a misconfigured token can't wipe resources created by other tools. The lower-level `sweepStale`, `listSandboxTunnels`, and `listSandboxDNSRecords` are also exported for one-off audits.
