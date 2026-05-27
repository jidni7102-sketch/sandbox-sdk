/**
 * Cloudflare API client for named-tunnel orchestration.
 *
 * Design notes:
 *
 * - The Cloudflare API envelope is `{ success, result, errors }`. We
 *   unwrap `result` on success and surface a thrown `Error` with the
 *   API error code/message on failure. Transport-level errors
 *   propagate unchanged.
 * - Delete endpoints are idempotent from the caller's perspective:
 *   a 404 (already gone) resolves successfully so destroy() can run
 *   without special-casing.
 * - `upsertCNAME` is the most subtle wrapper: it lists existing
 *   records, reuses a matching one, and refuses to mutate a record
 *   whose content differs from what we want. This is the fence that
 *   stops two sandboxes from racing on the same hostname.
 */

const API_BASE = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's standard envelope around every response. */
interface CloudflareResponse<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
}

type Fetcher = typeof fetch;

interface BaseArgs {
  token: string;
  fetcher?: Fetcher;
}

/**
 * Credentials bundle used by the account- and zone-scoped helpers
 * (`listSandboxTunnels`, `listSandboxDNSRecords`, and the orchestration
 * in `sweep.ts`). Tunnel-only helpers leave `zoneId` undefined; DNS
 * helpers require it and throw when it is missing.
 *
 * Kept separate from the per-function arg shapes so the reconciler can
 * thread one value through every CF call without rebuilding the bag.
 */
export interface CloudflareCredentials {
  token: string;
  accountId: string;
  zoneId?: string;
  fetcher?: Fetcher;
}

/**
 * Tag attached to every tunnel resource the SDK creates. Survives
 * round-tripping through the Cloudflare API so `findTunnelByName` can
 * reconcile orphaned resources from a previous failed attempt.
 */
export interface TunnelMetadata {
  sandboxId: string;
  createdBy: 'sandbox-sdk';
  name: string;
  port: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Treat these HTTP statuses as success and skip envelope parsing. */
  acceptStatuses?: number[];
  /**
   * Per-request timeout in milliseconds. Defaults to `DEFAULT_TIMEOUT_MS`.
   * Without a timeout a hung Cloudflare call wedges the per-port lock in
   * `tunnels-handler.ts` indefinitely, which then blocks every subsequent
   * `get(port)` / `destroy(port)` on that port. The shared
   * `#zoneNamePromise` makes the impact span every port for named
   * tunnels.
   */
  timeoutMs?: number;
}

/**
 * Default request timeout. Cloudflare API P99 latency is well under
 * this; values much smaller risk false positives on cold control-plane
 * paths (e.g. first `cfd_tunnel` POST in a new account).
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Internal request helper. Centralises auth header, JSON encoding,
 * timeout enforcement, and envelope unwrapping so each wrapper above
 * stays declarative.
 */
async function cfRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher,
  options: RequestOptions = {}
): Promise<T | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const init: RequestInit = {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(timeoutMs)
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    // `AbortSignal.timeout` rejects with a DOMException whose name is
    // 'TimeoutError'. Surface it as a clearly-labelled error so callers
    // can distinguish a transport hang from a Cloudflare-side failure;
    // a SandboxSecurityError-shaped class would be better but we keep
    // the error shape consistent with the rest of this module.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cloudflare API request to ${url} timed out after ${timeoutMs}ms`
      );
    }
    throw err;
  }
  if (options.acceptStatuses?.includes(response.status)) {
    return undefined;
  }

  let envelope: CloudflareResponse<T>;
  try {
    envelope = (await response.json()) as CloudflareResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API returned non-JSON response (status ${response.status}): ${message}`
    );
  }

  if (!response.ok || envelope.success === false) {
    const errs = envelope.errors ?? [];
    const summary = errs.length
      ? errs
          .map((e) => `${e.code ?? '???'}: ${e.message ?? 'unknown'}`)
          .join(', ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API error: ${summary}`);
  }

  return envelope.result;
}

/**
 * Heuristic for the "tags are an Enterprise-only feature" error class.
 * Empirically grounded against a non-Enterprise account:
 *
 *   - DNS create with `tags: [...]` on a non-Enterprise zone rejects with
 *     Cloudflare error code 9300 and the message "DNS record has N tags,
 *     exceeding the quota of 0.". The error string `cfRequest` constructs
 *     embeds both the code and the message, so we match on either signal.
 *   - Tunnel create with `tags: [...]` silently succeeds and drops the
 *     field on the floor (no error to retry on). The fallback wrapper
 *     therefore costs nothing on tunnel writes.
 *
 * Generic "requires Enterprise" phrasing is also matched as a forward-
 * compatibility hedge in case Cloudflare changes the response shape on
 * future endpoints.
 */
function isEnterpriseOnlyTagError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  // Code 9300 is the observed DNS "tags exceed quota" code.
  if (msg.includes('9300') && msg.includes('tag')) return true;
  // Generic phrasings used by Cloudflare's documented Enterprise gates.
  if (!msg.includes('tag')) return false;
  return (
    msg.includes('quota') ||
    msg.includes('enterprise') ||
    msg.includes('not allowed') ||
    msg.includes('not entitled') ||
    msg.includes('not available') ||
    msg.includes('not supported')
  );
}

/**
 * Build the `tags` field attached to created Cloudflare resources. The
 * tag is `sandboxId:<id>`, the same key used in DNS comments / tunnel
 * metadata; together they let an operator find every resource a given
 * sandbox owns from the Cloudflare dashboard.
 *
 * Tags are an Enterprise-only feature. The wrapper `createWithTagFallback`
 * automatically retries the request without tags on the documented
 * "requires Enterprise" error so non-enterprise accounts succeed without
 * any configuration.
 */
function buildSandboxTags(sandboxId: string | undefined): string[] | undefined {
  if (!sandboxId) return undefined;
  return [`sandboxId:${sandboxId}`];
}

/**
 * Wrap a tagged-create request with an automatic tag-strip retry. The
 * callback receives `tags`: pass it through to the request body as-is on
 * the first call (`undefined` on the retry). The retry only fires for
 * the Enterprise-only tag error class; any other failure surfaces
 * verbatim.
 */
async function createWithTagFallback<T>(
  sandboxId: string | undefined,
  send: (tags: string[] | undefined) => Promise<T>
): Promise<T> {
  const tags = buildSandboxTags(sandboxId);
  if (!tags) return send(undefined);
  try {
    return await send(tags);
  } catch (err) {
    if (!isEnterpriseOnlyTagError(err)) throw err;
    return send(undefined);
  }
}

// ---------------------------------------------------------------------------
// Tunnels
// ---------------------------------------------------------------------------

export interface CreateTunnelArgs extends BaseArgs {
  accountId: string;
  /**
   * The on-Cloudflare display name for the tunnel resource. Conventionally
   * `sandbox-<sandboxId>-<userName>` so it's stable per (sandbox, name).
   */
  tunnelName: string;
  metadata: TunnelMetadata;
}

export interface CreatedTunnel {
  id: string;
  /** Opaque `--token` for `cloudflared tunnel run --token <T>`. */
  token: string;
}

export async function createTunnel(
  args: CreateTunnelArgs
): Promise<CreatedTunnel> {
  const fetcher = args.fetcher ?? fetch;
  // The `/cfd_tunnel` endpoint silently ignores unknown body fields,
  // including `tags`, so today this is effectively a no-op on the wire
  // — the tagging story for tunnels lives on the Resource Tagging API
  // (PUT /accounts/{id}/tags). We keep the inline field in case the
  // endpoint adopts it later; the wrapper handles the Enterprise-only
  // fallback for DNS (see upsertCNAME), where it does fire.
  const result = await createWithTagFallback(args.metadata.sandboxId, (tags) =>
    cfRequest<{ id: string; token: string }>(
      `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel`,
      args.token,
      fetcher,
      {
        method: 'POST',
        body: {
          name: args.tunnelName,
          // `cloudflare` lets cloudflared run with just --token, no local
          // config file. The alternative `local` requires a YAML config.
          config_src: 'cloudflare',
          metadata: args.metadata,
          ...(tags ? { tags } : {})
        }
      }
    )
  );
  if (!result) {
    throw new Error('Cloudflare tunnel create returned no result body');
  }
  return { id: result.id, token: result.token };
}

export interface FindTunnelArgs extends BaseArgs {
  accountId: string;
  tunnelName: string;
  /**
   * When set, only return tunnels whose `metadata.sandboxId` equals this
   * value. Otherwise the function matches by name alone.
   *
   * Use this to defend against the case where two sandboxes happen to
   * mint the same tunnel name (the name conventionally encodes the
   * sandbox id, but the API does not enforce that): without the
   * metadata check, sandbox B's `findTunnelByName` would happily claim
   * sandbox A's tunnel and start managing it.
   */
  expectedSandboxId?: string;
}

export interface ExistingTunnel {
  id: string;
  name: string;
}

/**
 * Look up an existing tunnel by exact name match. Filters out tunnels
 * marked `deleted_at != null` defensively in case the API ignores the
 * `is_deleted=false` query parameter.
 *
 * When `expectedSandboxId` is provided, also verify that the tunnel's
 * `metadata.sandboxId` tag matches — this is the authoritative "this
 * resource was created by this sandbox" check, and the tag is set by
 * `createTunnel`. Mismatches are treated as "not found" so the caller
 * falls through to creating a fresh tunnel.
 */
export async function findTunnelByName(
  args: FindTunnelArgs
): Promise<ExistingTunnel | null> {
  const fetcher = args.fetcher ?? fetch;
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel` +
    `?name=${encodeURIComponent(args.tunnelName)}&is_deleted=false`;
  const result = await cfRequest<
    Array<{
      id: string;
      name: string;
      deleted_at?: string | null;
      metadata?: unknown;
    }>
  >(url, args.token, fetcher);
  if (!result) return null;
  const live = result.find((t) => !t.deleted_at);
  if (!live) return null;
  if (args.expectedSandboxId !== undefined) {
    const meta = live.metadata as { sandboxId?: unknown } | undefined;
    if (meta?.sandboxId !== args.expectedSandboxId) return null;
  }
  return { id: live.id, name: live.name };
}

export interface DeleteTunnelArgs extends BaseArgs {
  accountId: string;
  tunnelId: string;
}

export async function deleteTunnel(args: DeleteTunnelArgs): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  await cfRequest<unknown>(
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel/${encodeURIComponent(args.tunnelId)}`,
    args.token,
    fetcher,
    {
      method: 'DELETE',
      // 404 is a successful (already-gone) outcome so destroy() can
      // chain other cleanup steps without surfacing benign races.
      acceptStatuses: [404]
    }
  );
}

export interface GetTunnelTokenArgs extends BaseArgs {
  accountId: string;
  tunnelId: string;
}

/**
 * Fetch the opaque `--token` for an existing tunnel. Used on the retry
 * path: when `findTunnelByName` discovers a tunnel left behind from a
 * previous failed attempt, we need its token to run `cloudflared` again.
 *
 * The Cloudflare API returns the token as a bare quoted string in the
 * `result` envelope (e.g. `"<base64-token>"`).
 */
export async function getTunnelToken(
  args: GetTunnelTokenArgs
): Promise<string> {
  const fetcher = args.fetcher ?? fetch;
  const result = await cfRequest<string>(
    `${API_BASE}/accounts/${encodeURIComponent(args.accountId)}/cfd_tunnel/${encodeURIComponent(args.tunnelId)}/token`,
    args.token,
    fetcher
  );
  if (typeof result !== 'string' || result.length === 0) {
    throw new Error(
      `Cloudflare did not return a token for tunnel ${args.tunnelId}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface GetZoneNameArgs extends BaseArgs {
  zoneId: string;
}

export async function getZoneName(args: GetZoneNameArgs): Promise<string> {
  const fetcher = args.fetcher ?? fetch;
  const result = await cfRequest<{ id: string; name: string }>(
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}`,
    args.token,
    fetcher
  );
  if (!result?.name) {
    throw new Error(`Cloudflare zone ${args.zoneId} did not return a name`);
  }
  return result.name;
}

// ---------------------------------------------------------------------------
// DNS records
// ---------------------------------------------------------------------------

export interface UpsertCNAMEArgs extends BaseArgs {
  zoneId: string;
  hostname: string;
  /** `<tunnel-id>.cfargotunnel.com`. */
  cnameTarget: string;
  /** `sandbox-<sandbox-id>` — used both for tagging and reuse matching. */
  comment: string;
  /**
   * Sandbox id used to build the `sandboxId:<id>` Cloudflare tag
   * attached to the created DNS record. Tags are an Enterprise-only
   * feature; the create call falls back to an untagged record on the
   * documented "requires Enterprise" error. Omit to skip tagging.
   */
  sandboxId?: string;
}

export interface UpsertCNAMEResult {
  recordId: string;
  /** True when an existing matching record was reused; false when created. */
  reused: boolean;
}

interface DNSRecordEntry {
  id: string;
  type: string;
  name: string;
  content: string;
  comment?: string | null;
  proxied?: boolean;
}

export async function upsertCNAME(
  args: UpsertCNAMEArgs
): Promise<UpsertCNAMEResult> {
  const fetcher = args.fetcher ?? fetch;
  const listUrl =
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records` +
    `?type=CNAME&name=${encodeURIComponent(args.hostname)}`;
  const records =
    (await cfRequest<DNSRecordEntry[]>(listUrl, args.token, fetcher)) ?? [];

  const existing = records.find(
    (r) => r.type === 'CNAME' && r.name === args.hostname
  );
  if (existing) {
    // The CNAME content `<tunnel-id>.cfargotunnel.com` is the
    // authoritative "ours" check: only the holder of the tunnel id
    // could have asked Cloudflare to mint that target. Comment is
    // free text that operators commonly edit through the dashboard,
    // so we deliberately do not key reuse on it.
    if (existing.content === args.cnameTarget) {
      return { recordId: existing.id, reused: true };
    }
    throw new Error(
      `DNS record for ${args.hostname} already exists with different content ` +
        `(owned by you, not us): existing content="${existing.content}", ` +
        `existing comment="${existing.comment ?? ''}". Delete the record ` +
        'manually to allow the sandbox to manage it.'
    );
  }

  const createResult = await createWithTagFallback(args.sandboxId, (tags) =>
    cfRequest<{ id: string }>(
      `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records`,
      args.token,
      fetcher,
      {
        method: 'POST',
        body: {
          type: 'CNAME',
          name: args.hostname,
          content: args.cnameTarget,
          proxied: true,
          comment: args.comment,
          ...(tags ? { tags } : {})
        }
      }
    )
  );
  if (!createResult) {
    throw new Error('Cloudflare DNS create returned no result body');
  }
  return { recordId: createResult.id, reused: false };
}

export interface DeleteDNSRecordArgs extends BaseArgs {
  zoneId: string;
  recordId: string;
}

export async function deleteDNSRecord(
  args: DeleteDNSRecordArgs
): Promise<void> {
  const fetcher = args.fetcher ?? fetch;
  await cfRequest<unknown>(
    `${API_BASE}/zones/${encodeURIComponent(args.zoneId)}/dns_records/${encodeURIComponent(args.recordId)}`,
    args.token,
    fetcher,
    {
      method: 'DELETE',
      acceptStatuses: [404]
    }
  );
}

// ---------------------------------------------------------------------------
// Reconciler / sweep helpers
// ---------------------------------------------------------------------------

/**
 * Cloudflare list endpoints (`/cfd_tunnel`, `/dns_records`) return a
 * `result_info` block alongside `result`. `cfRequest` discards
 * `result_info` because the named-tunnel paths only ever fetch single
 * pages. The sweep helpers below page through the full account/zone, so
 * they read `result_info` directly via `cfRequestPaginated`.
 */
interface ResultInfo {
  page: number;
  per_page: number;
  total_pages: number;
  count?: number;
  total_count?: number;
}

/**
 * Cloudflare's paginated list endpoints respond with one of two
 * shapes. On success the envelope carries `result` and `result_info`;
 * on failure it carries `errors` (and HTTP status is non-2xx). The
 * union forces callers to discriminate on `success` before reaching
 * for `result`, so a malformed-but-2xx response can't slip through as
 * an empty page.
 */
type PaginatedResponse<T> =
  | {
      success: true;
      result: T[];
      result_info?: ResultInfo;
    }
  | {
      success: false;
      errors?: Array<{ code?: number; message?: string }>;
    };

/**
 * Walk a Cloudflare list endpoint until every page has been read.
 *
 * `urlBuilder` is invoked per page with the 1-indexed page number and is
 * expected to return the full URL including any caller-provided query
 * parameters. The helper appends `page` and `per_page` itself so the
 * pagination contract stays in one place.
 *
 * The loop terminates as soon as `result_info.total_pages` is reached;
 * a missing `result_info` (e.g. an endpoint that returned a single
 * page without metadata) is treated as the only page, which keeps the
 * helper safe against the API returning the legacy non-paginated shape
 * by accident.
 */
const PAGE_SIZE = 1000;

/**
 * Single-page request that returns the full `PaginatedResponse<T>`
 * envelope so the pagination loop can inspect `result_info`. Named
 * `Paginated` (vs the full-walk helper below) because it participates
 * in pagination but only fetches one page — the loop owns the cursor.
 *
 * `cfRequest` deliberately discards `result_info` for non-paginated
 * callers; this is the parallel path for the list helpers.
 */
async function cfPaginatedRequest<T>(
  url: string,
  token: string,
  fetcher: Fetcher
): Promise<Extract<PaginatedResponse<T>, { success: true }>> {
  const init: RequestInit = {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  };
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cloudflare API request to ${url} timed out after ${DEFAULT_TIMEOUT_MS}ms`
      );
    }
    throw err;
  }
  let envelope: PaginatedResponse<T>;
  try {
    envelope = (await response.json()) as PaginatedResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cloudflare API returned non-JSON response (status ${response.status}): ${message}`
    );
  }
  if (!response.ok || envelope.success === false) {
    const errs = envelope.success === false ? (envelope.errors ?? []) : [];
    const summary = errs.length
      ? errs
          .map((e) => `${e.code ?? '???'}: ${e.message ?? 'unknown'}`)
          .join(', ')
      : `HTTP ${response.status}`;
    throw new Error(`Cloudflare API error: ${summary}`);
  }
  // envelope.success is necessarily `true` here — the `!ok || success ===
  // false` branch above throws. TS's control-flow narrowing through the
  // explicit-false check picks that up.
  return envelope as Extract<PaginatedResponse<T>, { success: true }>;
}

/**
 * Walk a Cloudflare list endpoint until every page has been read,
 * collecting `result` arrays into a single flat array.
 *
 * `urlBuilder` is invoked per page with the 1-indexed page number; it
 * is expected to return the full URL including any caller-provided
 * query parameters. The helper owns `page` and `per_page` so the
 * pagination contract stays in one place.
 *
 * The loop terminates as soon as `result_info.total_pages` is reached;
 * a missing `result_info` (e.g. an endpoint that returned a single
 * page without metadata) is treated as the only page, which keeps the
 * helper safe against the API returning the legacy non-paginated shape
 * by accident.
 */
async function cfFullyPaginatedRequest<T>(
  urlBuilder: (page: number, perPage: number) => string,
  token: string,
  fetcher: Fetcher
): Promise<T[]> {
  const collected: T[] = [];
  let page = 1;
  for (;;) {
    const response = await cfPaginatedRequest<T>(
      urlBuilder(page, PAGE_SIZE),
      token,
      fetcher
    );
    for (const item of response.result) collected.push(item);
    const totalPages = response.result_info?.total_pages ?? 1;
    if (page >= totalPages) return collected;
    page += 1;
  }
}

/**
 * Summary of a tunnel returned by `listSandboxTunnels`. ISO timestamps
 * are parsed into `Date` so callers don't have to repeat the same
 * conversion for every staleness check.
 *
 * `metadata` stays raw (`Record<string, unknown>`) because the sweep
 * has to defend against tunnels created by another tool that happened
 * to set `createdBy: 'sandbox-sdk'` without our identifying fields. The
 * caller inspects `metadata.sandboxId` itself before deciding to delete.
 */
export interface TunnelSummary {
  id: string;
  name: string;
  status: 'healthy' | 'down' | 'degraded' | 'inactive';
  createdAt: Date;
  connsActiveAt: Date | null;
  connsInactiveAt: Date | null;
  deletedAt: Date | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Summary of a DNS record returned by `listSandboxDNSRecords`. Filtered
 * to records whose `comment` matches `^sandbox-`, which is the marker
 * `upsertCNAME` writes when provisioning a named tunnel.
 */
export interface DNSSummary {
  id: string;
  name: string;
  type: string;
  content: string;
  comment: string | null;
  createdAt: Date;
}

interface ListTunnelsRaw {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  conns_active_at?: string | null;
  conns_inactive_at?: string | null;
  deleted_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ListDNSRaw {
  id: string;
  name: string;
  type: string;
  content: string;
  comment?: string | null;
  created_on?: string;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  return new Date(value);
}

/**
 * List every Cloudflare tunnel in the account that was tagged by this
 * SDK (`metadata.createdBy === 'sandbox-sdk'`).
 *
 * The Cloudflare API does not index custom metadata, so the SDK pulls
 * every non-deleted tunnel and filters client-side. `per_page=1000` is
 * the documented maximum.
 *
 * `opts.sandboxId` narrows the result to a single sandbox's tunnels
 * — useful for callers building per-sandbox dashboards on top of the
 * sweep primitives.
 */
export async function listSandboxTunnels(
  creds: CloudflareCredentials,
  opts: { sandboxId?: string; fetcher?: Fetcher } = {}
): Promise<TunnelSummary[]> {
  const fetcher = opts.fetcher ?? creds.fetcher ?? fetch;
  const base = `${API_BASE}/accounts/${encodeURIComponent(creds.accountId)}/cfd_tunnel`;
  const raw = await cfFullyPaginatedRequest<ListTunnelsRaw>(
    (page, perPage) =>
      `${base}?is_deleted=false&page=${page}&per_page=${perPage}`,
    creds.token,
    fetcher
  );
  return raw
    .filter((t) => {
      const meta = t.metadata ?? null;
      if (!meta || meta.createdBy !== 'sandbox-sdk') return false;
      if (opts.sandboxId !== undefined && meta.sandboxId !== opts.sandboxId) {
        return false;
      }
      return true;
    })
    .map((t) => ({
      id: t.id,
      name: t.name,
      status: (t.status ?? 'inactive') as TunnelSummary['status'],
      createdAt: parseDate(t.created_at) ?? new Date(0),
      connsActiveAt: parseDate(t.conns_active_at ?? null),
      connsInactiveAt: parseDate(t.conns_inactive_at ?? null),
      deletedAt: parseDate(t.deleted_at ?? null),
      metadata: t.metadata ?? null
    }));
}

/**
 * List every CNAME in the configured zone whose `comment` starts with
 * `sandbox-`, the marker `upsertCNAME` writes when provisioning a named
 * tunnel.
 *
 * Cloudflare's `/dns_records` endpoint supports `comment.startswith`,
 * which scopes the response server-side; the SDK relies on that to
 * keep response sizes small in zones that host non-sandbox records.
 *
 * Requires `creds.zoneId` — throws when omitted so callers don't
 * silently fall back to listing every CNAME in the account.
 */
export async function listSandboxDNSRecords(
  creds: CloudflareCredentials,
  opts: { sandboxId?: string; fetcher?: Fetcher } = {}
): Promise<DNSSummary[]> {
  if (!creds.zoneId) {
    throw new Error(
      'listSandboxDNSRecords requires creds.zoneId. Pass it on CloudflareCredentials.'
    );
  }
  const fetcher = opts.fetcher ?? creds.fetcher ?? fetch;
  const base = `${API_BASE}/zones/${encodeURIComponent(creds.zoneId)}/dns_records`;
  const query = 'type=CNAME&comment.startswith=sandbox-';
  const raw = await cfFullyPaginatedRequest<ListDNSRaw>(
    (page, perPage) => `${base}?${query}&page=${page}&per_page=${perPage}`,
    creds.token,
    fetcher
  );
  return raw
    .filter((r) => {
      if (opts.sandboxId === undefined) return true;
      return r.comment === `sandbox-${opts.sandboxId}`;
    })
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      content: r.content,
      comment: r.comment ?? null,
      createdAt: parseDate(r.created_on) ?? new Date(0)
    }));
}
