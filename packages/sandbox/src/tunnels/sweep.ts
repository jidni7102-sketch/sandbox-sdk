/**
 * Tunnel reconciler / stale-resource sweeper.
 *
 * Walks the account's `cfd_tunnel` list and the configured zone's
 * `dns_records` list, deletes tunnels that look abandoned, and deletes
 * CNAMEs that point at tunnels which no longer exist. Operates only on
 * resources tagged by this SDK (`metadata.createdBy === 'sandbox-sdk'`
 * for tunnels; `comment` prefix `sandbox-` for DNS).
 *
 * Designed to run from a Worker on a Cron Trigger; see
 * `examples/tunnel-reconciler` for the end-to-end shape.
 */

import {
  type CloudflareCredentials,
  type DNSSummary,
  deleteDNSRecord,
  deleteTunnel,
  listSandboxDNSRecords,
  listSandboxTunnels,
  type TunnelSummary
} from './cloudflare-api';

/**
 * Outcome of a single sweep run. Shape is identical between dry-run and
 * destructive modes so an operator can wire one Worker to both ship
 * results to logs and alert on `errors.length`.
 *
 * `tunnelsScanned` / `dnsScanned` count post-filter candidates — the
 * resources the sweep actually evaluated for deletion — not the raw API
 * response sizes.
 */
export interface SweepResult {
  tunnelsScanned: number;
  tunnelsDeleted: { id: string; name: string }[];
  dnsScanned: number;
  dnsDeleted: { id: string; name: string }[];
  errors: { resource: 'tunnel' | 'dns'; id: string; message: string }[];
}

export interface SweepOptions {
  /**
   * Threshold below which a tunnel is considered abandoned. Compared
   * against `max(conns_active_at, conns_inactive_at, created_at)` so a
   * never-connected tunnel gets cleaned up once it ages past the
   * threshold.
   *
   * 24h is the recommended starting point: long enough to absorb
   * cloudflared reconnect storms, short enough to keep the account
   * under the per-account tunnel quota.
   */
  staleAfterMs: number;
  /**
   * Restrict the sweep to a single sandbox. When set, threaded through
   * to `listSandboxTunnels` and `listSandboxDNSRecords` so the
   * underlying API calls return only matching resources.
   */
  sandboxId?: string;
  /**
   * Compute the staleness threshold against this instant instead of
   * `Date.now()`. Tests pass a fixed `Date`; production omits it.
   */
  now?: Date;
  /**
   * When true, report what *would* be deleted via `tunnelsDeleted` /
   * `dnsDeleted` but skip the DELETE calls. Useful for the first
   * deployment of a Worker reconciler — operators can confirm the
   * staleness threshold is sane before enabling destructive mode.
   */
  dryRun?: boolean;
}

/**
 * Sweep stale tunnels and orphan DNS records across the account.
 *
 * Staleness rules (tunnels):
 *
 *   - `metadata.createdBy === 'sandbox-sdk'` and `metadata.sandboxId`
 *     present (the safety net — see gotcha #6 in
 *     `.plans/02-tunnel-reconciler.md`). A tunnel that matches the
 *     `createdBy` tag but is missing `sandboxId` is recorded under
 *     `errors` and **never** deleted.
 *   - `status !== 'healthy'`. A healthy tunnel is in use; the timestamp
 *     check is irrelevant.
 *   - `max(conns_active_at, conns_inactive_at, created_at) < now -
 *     staleAfterMs`. `conns_inactive_at` resets on reconnect, so this
 *     correctly leaves flappy-but-recovering tunnels alone.
 *
 * Orphan rules (DNS):
 *
 *   - `comment` matches `^sandbox-` (scoped by `listSandboxDNSRecords`).
 *   - `type === 'CNAME'` and `content` looks like
 *     `<tunnel-id>.cfargotunnel.com`.
 *   - The tunnel id is *not* in the current account's `cfd_tunnel`
 *     list. A record whose tunnel still exists is left alone — the
 *     tunnel-side delete path in the SDK handles paired teardown.
 *
 * Errors during individual deletes are recorded under
 * `SweepResult.errors`. They do **not** abort the rest of the sweep so
 * a single transient 5xx can't poison an entire cron run.
 */
export async function sweepStale(
  creds: CloudflareCredentials,
  opts: SweepOptions
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const threshold = now.getTime() - opts.staleAfterMs;
  const errors: SweepResult['errors'] = [];

  const allTunnels = await listSandboxTunnels(creds, {
    sandboxId: opts.sandboxId,
    fetcher: creds.fetcher
  });

  const candidates: TunnelSummary[] = [];
  for (const t of allTunnels) {
    // Safety net: refuse to operate on tunnels missing identifying
    // metadata even if they carry our `createdBy` tag. See gotcha #6.
    const meta = t.metadata ?? {};
    if (typeof meta.sandboxId !== 'string' || meta.sandboxId.length === 0) {
      errors.push({
        resource: 'tunnel',
        id: t.id,
        message: 'missing-identifying-metadata'
      });
      continue;
    }
    candidates.push(t);
  }

  const stale = candidates.filter((t) => isTunnelStale(t, threshold));
  const tunnelsDeleted: SweepResult['tunnelsDeleted'] = [];
  for (const t of stale) {
    if (opts.dryRun) {
      tunnelsDeleted.push({ id: t.id, name: t.name });
      continue;
    }
    try {
      await deleteTunnel({
        token: creds.token,
        accountId: creds.accountId,
        tunnelId: t.id,
        fetcher: creds.fetcher
      });
      tunnelsDeleted.push({ id: t.id, name: t.name });
    } catch (err) {
      errors.push({
        resource: 'tunnel',
        id: t.id,
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  // DNS sweep runs only when zoneId is configured. Without it we can
  // still clean tunnels (their endpoint is account-scoped); skipping
  // the DNS pass keeps the helper usable in tunnel-only deployments.
  let dnsScanned = 0;
  const dnsDeleted: SweepResult['dnsDeleted'] = [];
  if (creds.zoneId) {
    const dnsRecords = await listSandboxDNSRecords(creds, {
      sandboxId: opts.sandboxId,
      fetcher: creds.fetcher
    });
    // Build a lookup of live tunnel ids — anything not in this set
    // whose CNAME content points at `*.cfargotunnel.com` is orphan.
    const liveTunnelIds = new Set(allTunnels.map((t) => t.id));
    const orphans = dnsRecords.filter((r) => isOrphanCNAME(r, liveTunnelIds));
    dnsScanned = orphans.length;
    for (const r of orphans) {
      if (opts.dryRun) {
        dnsDeleted.push({ id: r.id, name: r.name });
        continue;
      }
      try {
        await deleteDNSRecord({
          token: creds.token,
          zoneId: creds.zoneId,
          recordId: r.id,
          fetcher: creds.fetcher
        });
        dnsDeleted.push({ id: r.id, name: r.name });
      } catch (err) {
        errors.push({
          resource: 'dns',
          id: r.id,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  return {
    tunnelsScanned: candidates.length,
    tunnelsDeleted,
    dnsScanned,
    dnsDeleted,
    errors
  };
}

/**
 * Stale iff the tunnel is non-healthy, non-deleted, and the most
 * recent activity (or its creation, if it never connected) is older
 * than the threshold.
 */
function isTunnelStale(t: TunnelSummary, thresholdMs: number): boolean {
  if (t.deletedAt) return false;
  if (t.status === 'healthy') return false;
  const candidates = [
    t.connsActiveAt?.getTime(),
    t.connsInactiveAt?.getTime(),
    t.createdAt.getTime()
  ].filter((v): v is number => typeof v === 'number');
  if (candidates.length === 0) return false;
  const mostRecent = Math.max(...candidates);
  return mostRecent < thresholdMs;
}

/**
 * Extract `<tunnel-id>` from `<tunnel-id>.cfargotunnel.com` and check
 * whether that id is missing from the live tunnel set. Non-cfargotunnel
 * CNAMEs are left alone — they aren't ours to manage.
 */
function isOrphanCNAME(r: DNSSummary, liveTunnelIds: Set<string>): boolean {
  if (r.type !== 'CNAME') return false;
  const match = /^([^.]+)\.cfargotunnel\.com$/.exec(r.content);
  if (!match) return false;
  return !liveTunnelIds.has(match[1]);
}
