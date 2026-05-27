import { getSandbox, proxyToSandbox } from '@cloudflare/sandbox';
import { withScheduledTunnelCleanup } from '@cloudflare/sandbox/tunnels';

export { Sandbox } from '@cloudflare/sandbox';

const VITE_PORT = 5173;
const VITE_BASE = '/_/';

export default {
  async fetch(request, env) {
    const proxiedResponse = await proxyToSandbox(request, env);
    if (proxiedResponse) {
      return proxiedResponse;
    }

    const url = new URL(request.url);

    if (url.pathname === '/api/sandbox') {
      return handleAPISandboxRoute(url, env);
    }

    return new Response('Not Found', { status: 404 });
  },

  /**
   * Daily tunnel reconciler. Sweeps abandoned Cloudflare tunnels and
   * orphaned DNS records left behind when a sandbox is evicted,
   * restarted, or otherwise outlives the caller before it can run
   * its own `destroy()` cleanup.
   *
   * The wrapper reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
   * / `CLOUDFLARE_ZONE_ID` from env at run time and short-circuits to
   * a no-op when the token is missing, so the example keeps working
   * out of the box. See README.md § Tunnel reconciler for the token
   * scopes and threshold tuning.
   */
  scheduled: withScheduledTunnelCleanup({
    staleAfterMs: 24 * 60 * 60_000
  })()
};

async function handleAPISandboxRoute(url, env) {
  const sandbox = getSandbox(env.Sandbox, 'vite-sandbox');

  let port = await sandbox
    .getExposedPorts(url.host)
    .then((ports) => ports.find((p) => p.port === VITE_PORT));

  if (!port) {
    port = await sandbox.exposePort(VITE_PORT, { hostname: url.host });

    const process = await sandbox.startProcess('npm run dev', {
      processId: 'vite-dev-server',
      cwd: '/app',
      env: {
        VITE_BASE: VITE_BASE,
        VITE_PORT: `${VITE_PORT}`,
        VITE_HMR_CLIENT_PORT:
          url.port || (url.protocol === 'https:' ? '443' : '80')
      }
    });
    await process.waitForPort(VITE_PORT);
  }

  return Response.json({ url: `${port.url.replace(/\/$/, '')}${VITE_BASE}` });
}
