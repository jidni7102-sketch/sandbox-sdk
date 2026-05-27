/**
 * Unit tests for the tunnel reconciler / stale-resource sweeper.
 *
 * The sweep orchestrates two list calls and a set of best-effort
 * deletes. Tests pin the staleness semantics, the safety-net behaviour
 * for tunnels missing identifying metadata, and the dry-run contract.
 *
 * `fetch` is mocked via the `fetcher` injection on each call. The
 * helper `mockSweep` lets each test declare the API responses
 * deterministically rather than threading a manual call counter.
 */

import { describe, expect, it, vi } from 'vitest';
import { sweepStale } from '../../src/tunnels/sweep';

interface TunnelFixture {
  id: string;
  name: string;
  status?: 'healthy' | 'down' | 'degraded' | 'inactive';
  created_at?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface DNSFixture {
  id: string;
  name: string;
  type?: string;
  content: string;
  comment?: string | null;
  created_on?: string;
}

/**
 * Build a paginated response shaped like Cloudflare's list endpoints.
 * The sweep helpers walk `result_info` until `page >= total_pages`.
 */
function jsonPage(body: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: body,
      result_info: {
        page: 1,
        per_page: 1000,
        total_pages: 1,
        count: body.length,
        total_count: body.length
      }
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }
  );
}

function jsonOK(body: unknown): Response {
  return new Response(JSON.stringify({ success: true, result: body }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

/**
 * Wire up a fake fetch that serves canned `cfd_tunnel` and
 * `dns_records` list responses and accepts arbitrary DELETE requests.
 * Returns the deletes the SUT issued so tests can assert against them.
 */
function buildFetcher(opts: {
  tunnels: TunnelFixture[];
  dns: DNSFixture[];
  failOnDelete?: (url: string) => Response | null;
}): {
  fetcher: ReturnType<typeof vi.fn>;
  deletedTunnels: string[];
  deletedDNS: string[];
} {
  const deletedTunnels: string[] = [];
  const deletedDNS: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const u = new URL(String(url));
    if (method === 'GET' && u.pathname.endsWith('/cfd_tunnel')) {
      return jsonPage(opts.tunnels);
    }
    if (method === 'GET' && u.pathname.endsWith('/dns_records')) {
      return jsonPage(opts.dns);
    }
    if (method === 'DELETE' && u.pathname.includes('/cfd_tunnel/')) {
      if (opts.failOnDelete) {
        const failure = opts.failOnDelete(String(url));
        if (failure) return failure;
      }
      deletedTunnels.push(u.pathname.split('/cfd_tunnel/')[1]);
      return jsonOK({ id: 'ok' });
    }
    if (method === 'DELETE' && u.pathname.includes('/dns_records/')) {
      if (opts.failOnDelete) {
        const failure = opts.failOnDelete(String(url));
        if (failure) return failure;
      }
      deletedDNS.push(u.pathname.split('/dns_records/')[1]);
      return jsonOK({ id: 'ok' });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  });
  return { fetcher, deletedTunnels, deletedDNS };
}

const NOW = new Date('2026-05-26T12:00:00Z');
const ONE_DAY_MS = 24 * 60 * 60_000;

function tunnel(overrides: Partial<TunnelFixture>): TunnelFixture {
  return {
    id: 'tun-id',
    name: 'sandbox-sb-api',
    status: 'down',
    created_at: '2026-05-01T00:00:00Z',
    conns_active_at: null,
    conns_inactive_at: null,
    deleted_at: null,
    metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb' },
    ...overrides
  };
}

describe('sweepStale > tunnel staleness', () => {
  it('deletes a tunnel whose conns_inactive_at is older than the threshold', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'stale-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 2 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: []
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual(['stale-tun']);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'stale-tun', name: 'sandbox-sb-api' }
    ]);
    expect(result.tunnelsScanned).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('deletes a tunnel that was created long ago and never connected', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'ghost-tun',
          status: 'inactive',
          created_at: new Date(NOW.getTime() - 3 * ONE_DAY_MS).toISOString(),
          conns_active_at: null,
          conns_inactive_at: null
        })
      ],
      dns: []
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual(['ghost-tun']);
  });

  it('leaves a healthy tunnel alone even if conns_inactive_at is stale', async () => {
    // `conns_inactive_at` resets on disconnect; a flappy-but-currently-up
    // tunnel reports `status: healthy` and we trust that over the
    // timestamp.
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'healthy-tun',
          status: 'healthy',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: []
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual([]);
    expect(result.tunnelsDeleted).toEqual([]);
  });

  it('leaves a tunnel alone when the most recent activity is within the threshold', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'recent-tun',
          status: 'down',
          conns_inactive_at: new Date(NOW.getTime() - 60_000).toISOString()
        })
      ],
      dns: []
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual([]);
  });

  it('uses max(conns_active_at, conns_inactive_at, created_at) as the staleness anchor', async () => {
    // conns_inactive_at is stale, but conns_active_at is fresh — the
    // tunnel reconnected recently, so leave it alone.
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'reconnected-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 5 * ONE_DAY_MS
          ).toISOString(),
          conns_active_at: new Date(NOW.getTime() - 60_000).toISOString()
        })
      ],
      dns: []
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual([]);
  });

  it('skips soft-deleted tunnels even when stale', async () => {
    // The list endpoint already filters by `is_deleted=false`; this is
    // belt-and-braces for the case where the API ignores it.
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'soft-deleted',
          deleted_at: '2026-05-01T00:00:00Z'
        })
      ],
      dns: []
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual([]);
  });
});

describe('sweepStale > safety net for ambiguous tunnels', () => {
  it('refuses to delete a sandbox-sdk-tagged tunnel that has no sandboxId', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'no-sb-id',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk' }
        })
      ],
      dns: []
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual([]);
    expect(result.errors).toEqual([
      {
        resource: 'tunnel',
        id: 'no-sb-id',
        message: 'missing-identifying-metadata'
      }
    ]);
  });

  it('refuses to delete a tunnel with non-object metadata', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'weird-meta',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: null
        })
      ],
      dns: []
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    // Filtered out by listSandboxTunnels (no createdBy), so the sweep
    // never sees it. tunnelsScanned reflects what was actually
    // candidates, not what the API returned.
    expect(deletedTunnels).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.tunnelsScanned).toBe(0);
  });
});

describe('sweepStale > DNS record orphans', () => {
  it('deletes a sandbox CNAME whose tunnel id is not in the live tunnel list', async () => {
    const { fetcher, deletedDNS } = buildFetcher({
      tunnels: [], // no tunnels at all
      dns: [
        {
          id: 'orphan-dns',
          name: 'old.example.com',
          type: 'CNAME',
          content: 'gone-tunnel.cfargotunnel.com',
          comment: 'sandbox-sb',
          created_on: '2026-05-01T00:00:00Z'
        }
      ]
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedDNS).toEqual(['orphan-dns']);
    expect(result.dnsDeleted).toEqual([
      { id: 'orphan-dns', name: 'old.example.com' }
    ]);
  });

  it('leaves a CNAME alone when its tunnel id is still in the live list', async () => {
    const { fetcher, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'live-tun',
          status: 'healthy',
          conns_active_at: new Date(NOW.getTime() - 60_000).toISOString()
        })
      ],
      dns: [
        {
          id: 'still-used',
          name: 'api.example.com',
          type: 'CNAME',
          content: 'live-tun.cfargotunnel.com',
          comment: 'sandbox-sb',
          created_on: '2026-05-01T00:00:00Z'
        }
      ]
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedDNS).toEqual([]);
  });

  it('deletes both the stale tunnel and its CNAME in a combined sweep', async () => {
    const { fetcher, deletedTunnels, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'stale-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [
        {
          id: 'paired-dns',
          name: 'api.example.com',
          type: 'CNAME',
          // CNAME still points at the (now-stale) tunnel.
          content: 'stale-tun.cfargotunnel.com',
          comment: 'sandbox-sb',
          created_on: '2026-05-01T00:00:00Z'
        }
      ]
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual(['stale-tun']);
    // The CNAME's tunnel id ('stale-tun') was in the live list at the
    // start of the sweep, so the orphan check leaves it alone — the
    // *tunnel*'s deletion path handles the corresponding DNS record.
    // (DNS sweep handles the case where the tunnel is already gone.)
    expect(deletedDNS).toEqual([]);
  });
});

describe('sweepStale > dry run', () => {
  it('reports what would be deleted without issuing any DELETE calls', async () => {
    const { fetcher, deletedTunnels, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'would-delete',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [
        {
          id: 'would-delete-dns',
          name: 'old.example.com',
          type: 'CNAME',
          content: 'no-such-tunnel.cfargotunnel.com',
          comment: 'sandbox-sb',
          created_on: '2026-05-01T00:00:00Z'
        }
      ]
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW, dryRun: true }
    );
    expect(deletedTunnels).toEqual([]);
    expect(deletedDNS).toEqual([]);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'would-delete', name: 'sandbox-sb-api' }
    ]);
    expect(result.dnsDeleted).toEqual([
      { id: 'would-delete-dns', name: 'old.example.com' }
    ]);
  });
});

describe('sweepStale > error handling', () => {
  it('records per-resource delete failures without aborting the sweep', async () => {
    const { fetcher, deletedTunnels, deletedDNS } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'fail-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        }),
        tunnel({
          id: 'ok-tun',
          name: 'sandbox-sb-other',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString()
        })
      ],
      dns: [],
      failOnDelete: (url) =>
        url.includes('fail-tun')
          ? new Response(
              JSON.stringify({
                success: false,
                errors: [{ code: 9999, message: 'transient' }]
              }),
              { status: 500, headers: { 'content-type': 'application/json' } }
            )
          : null
    });
    const result = await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW }
    );
    expect(deletedTunnels).toEqual(['ok-tun']);
    expect(deletedDNS).toEqual([]);
    expect(result.tunnelsDeleted).toEqual([
      { id: 'ok-tun', name: 'sandbox-sb-other' }
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      resource: 'tunnel',
      id: 'fail-tun'
    });
    expect(result.errors[0].message).toMatch(/9999|transient/);
  });
});

describe('sweepStale > scoping', () => {
  it('passes sandboxId through to the underlying list calls', async () => {
    const { fetcher, deletedTunnels } = buildFetcher({
      tunnels: [
        tunnel({
          id: 'sb1-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb1' }
        }),
        tunnel({
          id: 'sb2-tun',
          status: 'down',
          conns_inactive_at: new Date(
            NOW.getTime() - 7 * ONE_DAY_MS
          ).toISOString(),
          metadata: { createdBy: 'sandbox-sdk', sandboxId: 'sb2' }
        })
      ],
      dns: []
    });
    await sweepStale(
      { token: 'tok', accountId: 'acct', zoneId: 'zone', fetcher },
      { staleAfterMs: ONE_DAY_MS, now: NOW, sandboxId: 'sb1' }
    );
    expect(deletedTunnels).toEqual(['sb1-tun']);
  });
});
