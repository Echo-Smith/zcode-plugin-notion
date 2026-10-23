// Notion REST API client — zero-dependency (Node >= 18, uses global fetch).
// Covers every endpoint of Notion API version 2026-03-11:
// users, pages (+ markdown, move, properties), blocks (+ children, meeting notes),
// databases, data sources, search, comments, file uploads, views, custom emojis,
// async tasks, agents, AI plugins/skills, sessions, and OAuth token management.
//
// Security: every outbound request URL is validated before connecting — only
// http/https schemes, and the host (literal IP or DNS-resolved address) must not
// be localhost, loopback, private, link-local, or reserved address space.
//
// Usage:
//   import { NotionClient, NotionAPIError, collectPaginatedAPI } from "./client.mjs";
//   const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
//   const page = await notion.createPage({ parent: { type: "page_id", page_id: "..." }, markdown: "# Hello" });

import { lookup as dnsLookup } from "node:dns/promises";

export const NOTION_API_VERSION = "2026-03-11";
export const DEFAULT_BASE_URL = "https://api.notion.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

/* ----------------------------- URL/host guard ----------------------------- */

const u32 = (n) => n >>> 0;
const ipv4BlockedRanges = [
  [u32(0), 8], // 0.0.0.0/8 "this network"
  [u32(10 << 24), 8], // 10.0.0.0/8 private
  [u32(100 << 24 | 64 << 16), 10], // 100.64.0.0/10 carrier-grade NAT
  [u32(127 << 24), 8], // loopback
  [u32(169 << 24 | 254 << 16), 16], // 169.254.0.0/16 link-local
  [u32(172 << 24 | 16 << 16), 12], // 172.16.0.0/12 private
  [u32(192 << 24), 24], // 192.0.0.0/24 IETF protocol assignments
  [u32(192 << 24 | 2 << 16), 24], // 192.0.2.0/24 TEST-NET-1
  [u32(192 << 24 | 168 << 16), 16], // 192.168.0.0/16 private
  [u32(198 << 24 | 18 << 16), 15], // 198.18.0.0/15 benchmarking
  [u32(198 << 24 | 51 << 16 | 100 << 8), 24], // TEST-NET-2
  [u32(203 << 24 | 113 << 16), 24], // TEST-NET-3
  [u32(224 << 24), 4], // multicast
  [u32(240 << 24), 4], // reserved (incl. 255.255.255.255 broadcast)
];

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function isBlockedIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable literal -> refuse
  for (const [base, bits] of ipv4BlockedRanges) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

function isBlockedIPv6(ip) {
  const compact = ip.toLowerCase().split("%")[0]; // strip zone index
  if (compact === "::" || compact === "::1") return true; // unspecified / loopback
  let v4mapped = compact.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped) return isBlockedIPv4(v4mapped[1]);
  if (/^f[cd]/.test(compact)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(compact)) return true; // fe80::/10 link-local
  if (/^ff/.test(compact)) return true; // ff00::/8 multicast
  if (/^2001:db8/.test(compact)) return true; // documentation range
  return false;
}

function isBlockedIpLiteral(host) {
  if (host.includes(":")) return isBlockedIPv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isBlockedIPv4(host);
  return false; // not an IP literal; hostname/DNS rules apply
}

function isBlockedHostname(name) {
  const h = name.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  return false;
}

// DNS answers can change; cache only briefly.
const dnsCache = new Map(); // hostname -> { expires, blocked, addresses }
const DNS_TTL_MS = 60_000;

async function resolveHostBlocked(hostname) {
  const now = Date.now();
  const hit = dnsCache.get(hostname);
  if (hit && hit.expires > now) return hit.blocked;
  let blocked = false;
  let addresses = [];
  try {
    const results = await dnsLookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
    blocked = results.length === 0 || results.some((r) => isBlockedIpLiteral(r.address));
  } catch {
    blocked = true; // unresolvable -> refuse
  }
  dnsCache.set(hostname, { expires: now + DNS_TTL_MS, blocked, addresses });
  return blocked;
}

/**
 * Validate a request URL before any connection is made.
 * Only http/https; rejects localhost/loopback/private/reserved hosts (literal or resolved).
 */
export async function assertSafeRequestUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Blocked URL scheme ${url.protocol} — only http/https are allowed: ${rawUrl}`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new Error(`Blocked URL without host: ${rawUrl}`);
  if (isBlockedHostname(host)) {
    throw new Error(`Blocked host ${host} — localhost/internal hostnames are not allowed: ${rawUrl}`);
  }
  if (isBlockedIpLiteral(host)) {
    throw new Error(`Blocked address ${host} — loopback/private/reserved addresses are not allowed: ${rawUrl}`);
  }
  if (await resolveHostBlocked(host)) {
    throw new Error(`Blocked host ${host} — it resolves to a loopback/private/reserved address: ${rawUrl}`);
  }
  return url;
}

/* --------------------------------- errors --------------------------------- */

export class NotionAPIError extends Error {
  constructor(status, code, message, body, headers) {
    // Notion's own messages sometimes already carry the "Notion API error ..." prefix.
    const full = /^Notion API error/.test(message ?? "")
      ? message
      : `Notion API error ${status} ${code}: ${message}`;
    super(full);
    this.name = "NotionAPIError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.headers = headers;
  }
  get isUnauthorized() { return this.status === 401; }
  get isRateLimited() { return this.status === 429; }
  get isNotFound() { return this.code === "object_not_found"; }
}

/* --------------------------------- helpers -------------------------------- */

function buildQuery(searchParams, query) {
  if (!query) return;
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) searchParams.append(key, String(v));
    } else {
      searchParams.set(key, String(value));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- client --------------------------------- */

export class NotionClient {
  /**
   * @param {object} [options]
   * @param {string} [options.auth] Bearer token (defaults to $NOTION_API_KEY, $NOTION_TOKEN, $NOTION_INTEGRATION_TOKEN)
   * @param {string} [options.notionVersion] Notion-Version header (default 2026-03-11)
   * @param {string} [options.baseUrl] Default https://api.notion.com
   * @param {string} [options.agent] Optional user-agent suffix appended to "notion-plugin/0.1.0"
   * @param {number} [options.timeoutMs] Per-request timeout (default 60000)
   * @param {number} [options.maxRetries] Retries for 429/5xx (default 3)
   * @param {typeof fetch} [options.fetchImpl] Injectable fetch for tests
   */
  constructor(options = {}) {
    this.auth = options.auth ?? this.#envToken();
    this.notionVersion = options.notionVersion ?? NOTION_API_VERSION;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.agentSuffix = options.agent ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  #envToken() {
    const raw = process.env.NOTION_API_KEY ?? process.env.NOTION_TOKEN ?? process.env.NOTION_INTEGRATION_TOKEN ?? "";
    // Ignore values that were never expanded (e.g. a literal "${NOTION_API_KEY}").
    return /^\$\{[^}]*\}$/.test(raw) ? "" : raw;
  }

  #headers(extra) {
    const headers = {
      "Notion-Version": this.notionVersion,
      ...extra,
    };
    if (this.auth) headers.Authorization = `Bearer ${this.auth}`;
    let ua = "notion-plugin/0.1.0";
    if (this.agentSuffix) ua += ` ${this.agentSuffix}`;
    headers["User-Agent"] = ua;
    return headers;
  }

  /**
   * Core request method. Validates the URL (scheme + host) before connecting,
   * follows at most a few redirects through the same guard, retries 429/5xx.
   */
  async request({ method = "GET", path, query, body, headers = {}, contentType } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new Error(`path must start with "/": ${String(path)}`);
    }
    let currentUrl = new URL(`${this.baseUrl}${path}`);
    buildQuery(currentUrl.searchParams, query);

    let attempt = 0;
    // Retry loop also re-enters for 429/5xx after the fetch itself.
    for (;;) {
      await assertSafeRequestUrl(currentUrl.toString());
      let response;
      try {
        response = await this.fetchImpl(currentUrl.toString(), {
          method,
          headers: this.#headers(body !== undefined || contentType ? {
            ...(contentType ? { "Content-Type": contentType } : {}),
            ...(body !== undefined ? { "Content-Type": contentType ?? "application/json" } : {}),
            ...headers,
          } : headers),
          body: body === undefined ? undefined
            : (typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)
              || (typeof FormData !== "undefined" && body instanceof FormData)
              || (typeof Blob !== "undefined" && body instanceof Blob)
              || (typeof ReadableStream !== "undefined" && body instanceof ReadableStream))
              ? body
              : JSON.stringify(body),
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          throw new Error(`Request timed out after ${this.timeoutMs}ms: ${method} ${path}`);
        }
        throw err;
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect without Location from ${method} ${path}`);
        if (attempt >= MAX_REDIRECTS) throw new Error(`Too many redirects for ${method} ${path}`);
        attempt += 1;
        currentUrl = new URL(location, currentUrl);
        if ([301, 302, 303].includes(response.status) && method === "POST") method = "GET";
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const waitMs = response.status === 429
          ? Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1), 30_000)
          : 500 * 2 ** attempt;
        if (attempt < this.maxRetries) {
          attempt += 1;
          await sleep(waitMs);
          continue;
        }
      }

      const text = await response.text();
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      }
      if (!response.ok) {
        throw new NotionAPIError(
          response.status,
          parsed?.code ?? "unknown",
          parsed?.message ?? response.statusText,
          parsed,
          Object.fromEntries(response.headers.entries()),
        );
      }
      return parsed;
    }
  }

  /* ---------------------------------- users --------------------------------- */

  /** GET /v1/users/me — the token's bot/user identity. */
  me() { return this.request({ path: "/v1/users/me" }); }

  /** GET /v1/users/:user_id */
  getUser(userId) { return this.request({ path: `/v1/users/${userId}` }); }

  /** GET /v1/users */
  listUsers(query = {}) { return this.request({ path: "/v1/users", query }); }

  /* ---------------------------------- pages --------------------------------- */

  /**
   * POST /v1/pages — create a page.
   * Body accepts `markdown` (enhanced markdown, auto-converted to blocks; the first
   * `# heading` becomes the title), or `children` (explicit block list), plus
   * `parent`, `icon`, `cover`, `properties`, `content`, `template`, `allow_async`.
   */
  createPage(body, query) { return this.request({ method: "POST", path: "/v1/pages", body, query }); }

  /** GET /v1/pages/:page_id */
  retrievePage(pageId, query) { return this.request({ path: `/v1/pages/${pageId}`, query }); }

  /** PATCH /v1/pages/:page_id — update properties/icon/cover, or archive. */
  updatePage(pageId, body, query) { return this.request({ method: "PATCH", path: `/v1/pages/${pageId}`, body, query }); }

  /** PATCH /v1/pages/:page_id with `in_trash: true` — move to trash. */
  trashPage(pageId) { return this.updatePage(pageId, { in_trash: true }); }

  /** PATCH /v1/pages/:page_id with `archived: true, in_trash: true` — legacy archive. */
  archivePage(pageId) { return this.updatePage(pageId, { archived: true, in_trash: true }); }

  /** PATCH /v1/pages/:page_id — restore from trash/archive. */
  restorePage(pageId) { return this.updatePage(pageId, { archived: false, in_trash: false }); }

  /** POST /v1/pages/:page_id/move — body: { parent: { type, page_id|workspace|database_id|... } } */
  movePage(pageId, body) { return this.request({ method: "POST", path: `/v1/pages/${pageId}/move`, body }); }

  /** GET /v1/pages/:page_id/properties/:property_id */
  getPageProperty(pageId, propertyId, query) {
    return this.request({ path: `/v1/pages/${pageId}/properties/${propertyId}`, query });
  }

  /** GET /v1/pages/:page_id/markdown — the page content as enhanced markdown (markdown_version: "v1"|"v2"). */
  getPageMarkdown(pageId, query = {}) {
    return this.request({ path: `/v1/pages/${pageId}/markdown`, query });
  }

  /**
   * PATCH /v1/pages/:page_id/markdown — content edit operations.
   * Body is a typed operation, e.g.
   *   { type: "insert_content", insert_content: { content: "## New\n...", after: "start...end", position: { type: "end" } } }
   * Other operation types follow the same tagged shape (replace/delete/...).
   */
  updatePageMarkdown(pageId, body) {
    return this.request({ method: "PATCH", path: `/v1/pages/${pageId}/markdown`, body });
  }

  /* --------------------------------- blocks --------------------------------- */

  /** GET /v1/blocks/:block_id */
  retrieveBlock(blockId) { return this.request({ path: `/v1/blocks/${blockId}` }); }

  /** PATCH /v1/blocks/:block_id */
  updateBlock(blockId, body) { return this.request({ method: "PATCH", path: `/v1/blocks/${blockId}`, body }); }

  /** DELETE /v1/blocks/:block_id (archive) */
  deleteBlock(blockId) { return this.request({ method: "DELETE", path: `/v1/blocks/${blockId}` }); }

  /** GET /v1/blocks/:block_id/children */
  getBlockChildren(blockId, query = {}) { return this.request({ path: `/v1/blocks/${blockId}/children`, query }); }

  /** PATCH /v1/blocks/:block_id/children — append blocks; body: { children, position?, notifications? } */
  appendBlockChildren(blockId, body) {
    const payload = Array.isArray(body) ? { children: body } : body;
    return this.request({ method: "PATCH", path: `/v1/blocks/${blockId}/children`, body: payload });
  }

  /* ------------------------------ meeting notes ------------------------------ */

  /** POST /v1/blocks/meeting_notes */
  createMeetingNote(body) { return this.request({ method: "POST", path: "/v1/blocks/meeting_notes", body }); }

  /** POST /v1/blocks/meeting_notes/query */
  queryMeetingNotes(body) { return this.request({ method: "POST", path: "/v1/blocks/meeting_notes/query", body }); }

  /* -------------------------------- databases ------------------------------- */

  /** GET /v1/databases/:database_id */
  retrieveDatabase(databaseId) { return this.request({ path: `/v1/databases/${databaseId}` }); }

  /** PATCH /v1/databases/:database_id — title, icon, is_trashed. */
  updateDatabase(databaseId, body) { return this.request({ method: "PATCH", path: `/v1/databases/${databaseId}`, body }); }

  /** POST /v1/databases — body: { parent: { type: "page_id", page_id }, title, properties? } */
  createDatabase(body) { return this.request({ method: "POST", path: "/v1/databases", body }); }

  /* ------------------------------- data sources ------------------------------ */

  /** GET /v1/data_sources/:data_source_id — schema, parent, title. */
  retrieveDataSource(dataSourceId) { return this.request({ path: `/v1/data_sources/${dataSourceId}` }); }

  /** PATCH /v1/data_sources/:data_source_id */
  updateDataSource(dataSourceId, body) { return this.request({ method: "PATCH", path: `/v1/data_sources/${dataSourceId}`, body }); }

  /** POST /v1/data_sources — add a data source to an existing database. */
  createDataSource(body) { return this.request({ method: "POST", path: "/v1/data_sources", body }); }

  /**
   * POST /v1/data_sources/:data_source_id/query — body: { filter?, sorts?, start_cursor?, page_size?, result_type? }
   * Filter/sort syntax follows the property-filter compound shape
   * ({ property, checkbox: { equals: true } }, and/or groups, { property, direction } sorts).
   */
  queryDataSource(dataSourceId, body = {}, query) {
    return this.request({ method: "POST", path: `/v1/data_sources/${dataSourceId}/query`, body, query });
  }

  /** GET /v1/data_sources/:data_source_id/templates */
  listDataSourceTemplates(dataSourceId, query = {}) {
    return this.request({ path: `/v1/data_sources/${dataSourceId}/templates`, query });
  }

  /* --------------------------------- search --------------------------------- */

  /** POST /v1/search — body: { query?, sort?: {direction,timestamp}, filter?: {value,property:"object"}, start_cursor?, page_size? } */
  search(body = {}) { return this.request({ method: "POST", path: "/v1/search", body }); }

  /* -------------------------------- comments -------------------------------- */

  /**
   * POST /v1/comments — body: { parent: { page_id } } | { discussion_id },
   * plus `rich_text` (or `markdown`), optional `attachments` (≤3 file_upload refs),
   * `display_name`.
   */
  createComment(body) { return this.request({ method: "POST", path: "/v1/comments", body }); }

  /** GET /v1/comments?block_id=... (block_id is required) */
  listComments(query) { return this.request({ path: "/v1/comments", query }); }

  /** GET /v1/comments/:comment_id */
  retrieveComment(commentId) { return this.request({ path: `/v1/comments/${commentId}` }); }

  /** PATCH /v1/comments/:comment_id */
  updateComment(commentId, body) { return this.request({ method: "PATCH", path: `/v1/comments/${commentId}`, body }); }

  /** DELETE /v1/comments/:comment_id */
  deleteComment(commentId) { return this.request({ method: "DELETE", path: `/v1/comments/${commentId}` }); }

  /* ------------------------------ file uploads ------------------------------- */

  /**
   * POST /v1/file_uploads — register an upload. Body varies by mode:
   *   { mode: "single_part", filename, content_type } |
   *   { mode: "multi_part", filename, content_type, number_of_parts } |
   *   { mode: "external_url", external_url }
   */
  createFileUpload(body) { return this.request({ method: "POST", path: "/v1/file_uploads", body }); }

  /**
   * POST /v1/file_uploads/:file_upload_id/send — upload bytes (multipart/form-data).
   * `file` may be a Blob/File or { data: string|Uint8Array, filename?, contentType? }.
   * `partNumber` is for multi_part uploads.
   */
  async sendFileUpload(fileUploadId, { file, partNumber } = {}) {
    const form = new FormData();
    let blob;
    if (typeof Blob !== "undefined" && file instanceof Blob) {
      blob = file;
    } else {
      const data = typeof file.data === "string" ? new TextEncoder().encode(file.data) : file.data;
      blob = new Blob([data], { type: file.contentType ?? "application/octet-stream" });
    }
    const filename = file.filename ?? (file instanceof File ? file.name : "upload.bin");
    form.append("file", blob, filename);
    if (partNumber !== undefined) form.append("part_number", String(partNumber));
    return this.request({ method: "POST", path: `/v1/file_uploads/${fileUploadId}/send`, body: form });
  }

  /** POST /v1/file_uploads/:file_upload_id/complete — finalize a multi_part upload. */
  completeFileUpload(fileUploadId) {
    return this.request({ method: "POST", path: `/v1/file_uploads/${fileUploadId}/complete` });
  }

  /** GET /v1/file_uploads/:file_upload_id — poll status (pending/uploaded/expired). */
  retrieveFileUpload(fileUploadId) { return this.request({ path: `/v1/file_uploads/${fileUploadId}` }); }

  /** GET /v1/file_uploads */
  listFileUploads(query = {}) { return this.request({ path: "/v1/file_uploads", query }); }

  /* ---------------------------------- views ---------------------------------- */

  /** GET /v1/views?database_id=... or ?data_source_id=... */
  listViews(query = {}) { return this.request({ path: "/v1/views", query }); }

  /** POST /v1/views */
  createView(body) { return this.request({ method: "POST", path: "/v1/views", body }); }

  /** GET /v1/views/:view_id */
  retrieveView(viewId) { return this.request({ path: `/v1/views/${viewId}` }); }

  /** PATCH /v1/views/:view_id */
  updateView(viewId, body) { return this.request({ method: "PATCH", path: `/v1/views/${viewId}`, body }); }

  /** DELETE /v1/views/:view_id */
  deleteView(viewId) { return this.request({ method: "DELETE", path: `/v1/views/${viewId}` }); }

  /** POST /v1/views/:view_id/queries — run a view query (filter/sort in body). */
  createViewQuery(viewId, body) { return this.request({ method: "POST", path: `/v1/views/${viewId}/queries`, body }); }

  /** GET /v1/views/:view_id/queries/:query_id — fetch results (async queries may be pending). */
  getViewQueryResults(viewId, queryId, query = {}) {
    return this.request({ path: `/v1/views/${viewId}/queries/${queryId}`, query });
  }

  /** DELETE /v1/views/:view_id/queries/:query_id */
  deleteViewQuery(viewId, queryId) {
    return this.request({ method: "DELETE", path: `/v1/views/${viewId}/queries/${queryId}` });
  }

  /* ------------------------------- async tasks ------------------------------- */

  /** GET /v1/async_tasks/:task_id — poll results of allow_async operations. */
  retrieveAsyncTask(taskId) { return this.request({ path: `/v1/async_tasks/${taskId}` }); }

  /* ------------------------------ custom emojis ------------------------------ */

  /** GET /v1/custom_emojis */
  listCustomEmojis(query = {}) { return this.request({ path: "/v1/custom_emojis", query }); }

  /* ---------------------------------- agents --------------------------------- */

  /** POST /v1/agents/query */
  queryAgents(body) { return this.request({ method: "POST", path: "/v1/agents/query", body }); }

  /** GET /v1/agents/:agent_id */
  getAgent(agentId, query) { return this.request({ path: `/v1/agents/${agentId}`, query }); }

  /** DELETE /v1/agents/:agent_id */
  deleteAgent(agentId) { return this.request({ method: "DELETE", path: `/v1/agents/${agentId}` }); }

  /** GET /v1/agents/:agent_id/insights */
  getAgentInsights(agentId, query) { return this.request({ path: `/v1/agents/${agentId}/insights`, query }); }

  /** PATCH /v1/agents/:agent_id/status */
  updateAgentStatus(agentId, body) { return this.request({ method: "PATCH", path: `/v1/agents/${agentId}/status`, body }); }

  /** PATCH /v1/agents/:agent_id/credit_limit */
  updateAgentCreditLimit(agentId, body) {
    return this.request({ method: "PATCH", path: `/v1/agents/${agentId}/credit_limit`, body });
  }

  /** POST /v1/agents/batch */
  batchManageAgents(body) { return this.request({ method: "POST", path: "/v1/agents/batch", body }); }

  /* ---------------------------- AI plugins & skills --------------------------- */

  /** GET /v1/ai/plugins */
  listSkillsPlugins(query = {}) { return this.request({ path: "/v1/ai/plugins", query }); }

  /** GET /v1/ai/plugins/:id */
  getPluginDirectory(id) { return this.request({ path: `/v1/ai/plugins/${id}` }); }

  /** GET /v1/ai/skills/:id */
  getSkillDirectory(id) { return this.request({ path: `/v1/ai/skills/${id}` }); }

  /** POST /v1/ai/skills/:id/upload */
  uploadSkill(id, body) { return this.request({ method: "POST", path: `/v1/ai/skills/${id}/upload`, body }); }

  /* --------------------------------- sessions -------------------------------- */

  /** POST /v1/sessions — create/update an agent session. */
  createSession(body) { return this.request({ method: "POST", path: "/v1/sessions", body }); }

  /** GET /v1/sessions/:session_id */
  retrieveSession(sessionId) { return this.request({ path: `/v1/sessions/${sessionId}` }); }

  /** POST /v1/sessions/query */
  querySessions(body) { return this.request({ method: "POST", path: "/v1/sessions/query", body }); }

  /** POST /v1/sessions/:session_id/events/query */
  querySessionEvents(sessionId, body) {
    return this.request({ method: "POST", path: `/v1/sessions/${sessionId}/events/query`, body });
  }

  /** POST /v1/sessions/:session_id/cancel */
  cancelSession(sessionId) { return this.request({ method: "POST", path: `/v1/sessions/${sessionId}/cancel` }); }

  /* ---------------------------------- OAuth ---------------------------------- */

  /** POST /v1/oauth/token — exchange `code` (public integrations). */
  createToken(body) { return this.request({ method: "POST", path: "/v1/oauth/token", body }); }

  /** POST /v1/oauth/revoke */
  revokeToken(body) { return this.request({ method: "POST", path: "/v1/oauth/revoke", body }); }

  /** POST /v1/oauth/introspect */
  introspectToken(body) { return this.request({ method: "POST", path: "/v1/oauth/introspect", body }); }
}

/* -------------------------------- pagination -------------------------------- */

/**
 * Async-iterate every page of a paginated endpoint.
 * `fn` is a client method (e.g. client.listUsers) and `arg` its params;
 * each yielded value is one full response page ({results, next_cursor, has_more}).
 */
export async function* iteratePaginatedAPI(fn, arg = {}) {
  let cursor = undefined;
  do {
    const page = await fn({ ...arg, start_cursor: cursor });
    yield page;
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor !== undefined);
}

/** Collect all `results` across pages into one array. */
export async function collectPaginatedAPI(fn, arg = {}) {
  const results = [];
  for await (const page of iteratePaginatedAPI(fn, arg)) results.push(...(page.results ?? []));
  return results;
}

export default NotionClient;
