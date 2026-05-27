/**
 * `withScheduledTunnelCleanup` \u2014 zero-boilerplate cron wrapper.
 *
 * Produces an `ExportedHandlerScheduledHandler` that runs `sweepStale`
 * against env-derived Cloudflare credentials. The wrapper is curried:
 * the outer call binds sweep options at module-load time, the inner
 * call (optionally) composes a user-supplied scheduled handler so
 * callers don't have to choose between "my cron job" and "the SDK's
 * cleanup cron job".
 *
 * ```ts
 * // Just the sweep:
 * scheduled: withScheduledTunnelCleanup({ staleAfterMs: 24 * 60 * 60_000 })();
 *
 * // Sweep alongside an existing cron handler:
 * scheduled: withScheduledTunnelCleanup({ staleAfterMs: 24 * 60 * 60_000 })(
 *   async (event, env, ctx) => {
 *     // your own scheduled work
 *   }
 * );
 * ```
 *
 * Credentials are read from `env` at handler-invocation time (when
 * secrets are populated). When `CLOUDFLARE_API_TOKEN` is missing the
 * sweep is silently skipped \u2014 the user handler still runs \u2014 so the
 * wrapper is safe to wire into examples that ship without secrets.
 */

import { type SweepResult, sweepStale } from './sweep';

/**
 * Subset of `ExecutionContext` the wrapper relies on. Matches the
 * Workers runtime shape without depending on `@cloudflare/workers-types`
 * at the SDK boundary, so the helper is portable to consumers using
 * looser type setups.
 */
interface ScheduledExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Loose `ScheduledController` shape \u2014 only `scheduledTime` and `cron` are observable. */
interface ScheduledControllerLike {
  readonly scheduledTime: number;
  readonly cron: string;
}

type ScheduledHandler<Env> = (
  controller: ScheduledControllerLike,
  env: Env,
  ctx: ScheduledExecutionContext
) => void | Promise<void>;

export interface ScheduledTunnelCleanupOptions {
  /** Tunnel-staleness threshold in milliseconds. See `SweepOptions.staleAfterMs`. */
  staleAfterMs: number;
  /** Restrict the sweep to a single sandbox. Threaded into `sweepStale`. */
  sandboxId?: string;
  /** When true, the sweep reports without issuing deletes. */
  dryRun?: boolean;
  /**
   * Override `fetch` used for Cloudflare API calls. Tests inject a
   * mock; production omits it.
   */
  fetcher?: typeof fetch;
  /**
   * Invoked when the sweep itself rejects (transport error, malformed
   * envelope, etc.). Per-resource failures already land in
   * `SweepResult.errors` and don't reach here. Default: `console.error`.
   */
  onError?: (err: unknown) => void;
  /**
   * Invoked with each completed sweep's `SweepResult`. Default:
   * `console.log('tunnel sweep', JSON.stringify(result))`. Override to
   * pipe into a structured logger or alerting hook.
   */
  onResult?: (result: SweepResult) => void;
}

/**
 * Env shape required by the wrapper. The handler degrades to a no-op
 * sweep when `CLOUDFLARE_API_TOKEN` is missing; account/zone ids fall
 * back to the token-introspection path used elsewhere in the SDK when
 * the token is scoped to a single account/zone.
 */
interface ScheduledTunnelCleanupEnv {
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ZONE_ID?: string;
}

export function withScheduledTunnelCleanup(
  opts: ScheduledTunnelCleanupOptions
): <Env extends ScheduledTunnelCleanupEnv>(
  userHandler?: ScheduledHandler<Env>
) => ScheduledHandler<Env> {
  const onError =
    opts.onError ??
    ((err: unknown) => {
      console.error('tunnel sweep failed', err);
    });
  const onResult =
    opts.onResult ??
    ((result: SweepResult) => {
      console.log('tunnel sweep', JSON.stringify(result));
    });

  return <Env extends ScheduledTunnelCleanupEnv>(
    userHandler?: ScheduledHandler<Env>
  ): ScheduledHandler<Env> => {
    return async (controller, env, ctx) => {
      const token = env.CLOUDFLARE_API_TOKEN;
      if (token && env.CLOUDFLARE_ACCOUNT_ID) {
        // Run the sweep in waitUntil so the cron returns immediately
        // while the (potentially slow) Cloudflare API walk completes
        // in the background. Errors are routed to `onError` so a
        // transient 5xx doesn't reject the waitUntil promise \u2014 the
        // runtime would otherwise treat the cron invocation as failed.
        ctx.waitUntil(
          sweepStale(
            {
              token,
              accountId: env.CLOUDFLARE_ACCOUNT_ID,
              zoneId: env.CLOUDFLARE_ZONE_ID,
              fetcher: opts.fetcher
            },
            {
              staleAfterMs: opts.staleAfterMs,
              sandboxId: opts.sandboxId,
              dryRun: opts.dryRun
            }
          ).then(onResult, onError)
        );
      }
      if (userHandler) {
        await userHandler(controller, env, ctx);
      }
    };
  };
}
