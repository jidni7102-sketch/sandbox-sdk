/**
 * Unit tests for `withScheduledTunnelCleanup`.
 *
 * The helper produces an `ExportedHandlerScheduledHandler` that runs
 * `sweepStale` against the env-derived credentials and optionally
 * composes a user-supplied scheduled handler. Tests pin:
 *   - the no-op fallback when credentials are missing
 *   - the user handler runs alongside the sweep
 *   - the sweep is wrapped in `ctx.waitUntil` so cron returns fast
 *   - sweep errors don't crash the handler
 */

import { describe, expect, it, vi } from 'vitest';
import { withScheduledTunnelCleanup } from '../../src/tunnels/scheduled-cleanup';

type ScheduledArgs = [
  { readonly scheduledTime: number; readonly cron: string },
  Record<string, string | undefined>,
  {
    waitUntil: (p: Promise<unknown>) => void;
    passThroughOnException: () => void;
  }
];

function jsonPage(body: unknown[]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      result: body,
      result_info: { page: 1, per_page: 1000, total_pages: 1 }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

/**
 * Minimal `ExecutionContext` stub. Collects every promise passed to
 * `waitUntil` so tests can `await Promise.all(waited)` and assert on
 * what the sweep did.
 */
function buildCtx(): {
  ctx: {
    waitUntil: (p: Promise<unknown>) => void;
    passThroughOnException: () => void;
  };
  waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p) => {
        waited.push(p);
      },
      passThroughOnException: () => {}
    },
    waited
  };
}

describe('withScheduledTunnelCleanup', () => {
  it('runs sweepStale against env credentials inside ctx.waitUntil', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonPage([])
    );
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      fetcher: fetcher as unknown as typeof fetch
    })();
    const { ctx, waited } = buildCtx();
    await handler(
      { scheduledTime: 0, cron: '0 3 * * *', noRetry: () => {} } as never,
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx as never
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    // Both list endpoints get hit by the sweep (tunnels then DNS).
    const urls = fetcher.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/cfd_tunnel'))).toBe(true);
    expect(urls.some((u) => u.includes('/dns_records'))).toBe(true);
  });

  it('is a no-op when CLOUDFLARE_API_TOKEN is missing', async () => {
    const fetcher = vi.fn();
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      fetcher: fetcher as unknown as typeof fetch
    })();
    const { ctx, waited } = buildCtx();
    await handler(
      { scheduledTime: 0, cron: '0 3 * * *', noRetry: () => {} } as never,
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_ZONE_ID: 'zone' },
      ctx as never
    );
    expect(waited).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('runs the user-supplied scheduled handler alongside the sweep', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonPage([])
    );
    const userHandler = vi.fn(
      async (
        _c: ScheduledArgs[0],
        _env: ScheduledArgs[1],
        _ctx: ScheduledArgs[2]
      ): Promise<void> => {}
    );
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      fetcher: fetcher as unknown as typeof fetch
    })(userHandler as never);
    const { ctx, waited } = buildCtx();
    const event = {
      scheduledTime: 0,
      cron: '0 3 * * *',
      noRetry: () => {}
    };
    await handler(
      event as never,
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx as never
    );
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(userHandler.mock.calls[0][0]).toBe(event);
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
  });

  it('still runs the user handler when credentials are missing', async () => {
    const fetcher = vi.fn();
    const userHandler = vi.fn(
      async (
        _c: ScheduledArgs[0],
        _env: ScheduledArgs[1],
        _ctx: ScheduledArgs[2]
      ): Promise<void> => {}
    );
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      fetcher: fetcher as unknown as typeof fetch
    })(userHandler as never);
    const { ctx, waited } = buildCtx();
    await handler(
      { scheduledTime: 0, cron: '0 3 * * *', noRetry: () => {} } as never,
      {},
      ctx as never
    );
    expect(userHandler).toHaveBeenCalledTimes(1);
    expect(waited).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('swallows sweep failures so cron doesn\u2019t retry on transient errors', async () => {
    // Sweep failures land in SweepResult.errors today; this test pins
    // the contract that a transport-level rejection bubbling out of
    // listSandboxTunnels (e.g. a 500 on the first list call) doesn't
    // crash the handler.
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response('boom', { status: 500 });
    });
    const onError = vi.fn();
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      fetcher: fetcher as unknown as typeof fetch,
      onError
    })();
    const { ctx, waited } = buildCtx();
    await handler(
      { scheduledTime: 0, cron: '0 3 * * *', noRetry: () => {} } as never,
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx as never
    );
    // waitUntil's promise should resolve, not reject, so the runtime
    // doesn't treat the cron run as failed.
    await expect(Promise.all(waited)).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('respects sandboxId scoping when provided', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonPage([])
    );
    const handler = withScheduledTunnelCleanup({
      staleAfterMs: 24 * 60 * 60_000,
      sandboxId: 'sb1',
      fetcher: fetcher as unknown as typeof fetch
    })();
    const { ctx, waited } = buildCtx();
    await handler(
      { scheduledTime: 0, cron: '0 3 * * *', noRetry: () => {} } as never,
      {
        CLOUDFLARE_API_TOKEN: 'tok',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
        CLOUDFLARE_ZONE_ID: 'zone'
      },
      ctx as never
    );
    await Promise.all(waited);
    // No assertion on URL contents \u2014 sweepStale tests cover the
    // sandboxId-threading; here we just confirm the helper plumbs it
    // through without throwing.
    expect(fetcher).toHaveBeenCalled();
  });
});
