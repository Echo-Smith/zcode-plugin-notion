#!/usr/bin/env node
// Notion MCP server — JSON-RPC 2.0 over stdio (newline-delimited), zero dependencies.
// Curated tools for the common Notion workflows plus a raw `notion_request`
// escape hatch that can reach every endpoint of the REST API.
//
// Configure with a Notion token in the environment:
//   NOTION_API_KEY  (also accepts NOTION_TOKEN / NOTION_INTEGRATION_TOKEN)
// Optional: NOTION_VERSION (default 2026-03-11), NOTION_BASE_URL (default https://api.notion.com).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { NotionClient, NotionAPIError } from "../api/client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const client = new NotionClient({
  auth: process.env.NOTION_API_KEY,
  notionVersion: process.env.NOTION_VERSION,
  baseUrl: process.env.NOTION_BASE_URL,
  agent: "(mcp)",
});

const SERVER_INFO = { name: "notion", version: "0.1.0" };
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

/* ------------------------------ tool plumbing ------------------------------ */

const str = (desc) => ({ type: "string", description: desc });
const int = (desc) => ({ type: "integer", description: desc });
const bool = (desc) => ({ type: "boolean", description: desc });
const jsonObj = (desc) => ({ type: "object", description: desc, additionalProperties: true });

function parseJsonParam(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Parameter "${name}" must be valid JSON: ${String(value).slice(0, 200)}`);
  }
}

function summarizeForDisplay(value, { maxChars = 20000 } = {}) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text === undefined) text = String(value);
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
  }
  return text;
}

/** Flatten pagination across up to `maxPages` requests when `collect_all` is set. */
async function paged(fn, arg, { collectAll = false, maxPages = 5 } = {}) {
  if (!collectAll) return fn(arg);
  const pages = [];
  let cursor;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await fn({ ...arg, ...(cursor ? { start_cursor: cursor } : {}) });
    pages.push(page);
    if (!page.has_more || !page.next_cursor) break;
    cursor = page.next_cursor;
  }
  const results = pages.flatMap((p) => p.results ?? []);
  const last = pages[pages.length - 1];
  const merged = { ...last, results, collected_pages: pages.length };
  if (merged.has_more) {
    merged.next_cursor = last.next_cursor;
    merged.note = `Stopped after ${pages.length} pages; call again with start_cursor to continue.`;
  }
  return merged;
}

const optionalPaging = {
  start_cursor: str("Pagination cursor from a previous response's next_cursor."),
  page_size: int("Page size, 1-100 (default 100)."),
};

/* --------------------------------- tool defs -------------------------------- */

const tools = [
  {
    name: "notion_get_me",
    description: "Get the token's identity: bot name, workspace, owner for the current NOTION_API_KEY. Best first call to verify the token works.",
    inputSchema: { type: "object", properties: {} },
    run: () => client.me(),
  },
  {
    name: "notion_search",
    description: "Search pages and databases visible to the integration. Use titles/keywords in `query`. Filter with filter_value=page|data_source to narrow the object type.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Search text (title/url match). Empty query lists everything shared with the integration."),
        filter_value: str('Restrict object type: "page" or "data_source" (also accepts "database").'),
        sort_direction: str('"ascending" or "descending" by last_edited_time.'),
        collect_all: bool("Fetch up to 5 pages of results in one call (default: single page)."),
        ...optionalPaging,
      },
    },
    run: (a) => {
      const body = {};
      if (a.query) body.query = a.query;
      if (a.filter_value) body.filter = { property: "object", value: a.filter_value };
      if (a.sort_direction) body.sort = { direction: a.sort_direction, timestamp: "last_edited_time" };
      if (a.start_cursor) body.start_cursor = a.start_cursor;
      if (a.page_size) body.page_size = a.page_size;
      return paged((arg) => client.search(arg), body, { collectAll: a.collect_all });
    },
  },
  {
    name: "notion_list_users",
    description: "List workspace users (people and bots).",
    inputSchema: { type: "object", properties: { collect_all: bool("Fetch up to 5 pages (default single page)."), ...optionalPaging } },
    run: (a) => paged((q) => client.listUsers(q), a, { collectAll: a.collect_all }),
  },
  {
    name: "notion_get_user",
    description: "Retrieve one user by id.",
    inputSchema: { type: "object", properties: { user_id: str("User id (UUID).") }, required: ["user_id"] },
    run: (a) => client.getUser(a.user_id),
  },

  /* pages */
  {
    name: "notion_retrieve_page",
    description: "Get a page object: id, url, icon, properties (title, status, dates...). For the page BODY use notion_get_page_markdown.",
    inputSchema: { type: "object", properties: { page_id: str("Page id or URL.") }, required: ["page_id"] },
    run: (a) => client.retrievePage(a.page_id),
  },
  {
    name: "notion_create_page",
    description: 'Create a page. Simplest form: parent_type=page_id, parent_id=<id>, markdown="# Title\\n\\nBody". Under a database/data_source parent, pass properties_json (title required).',
    inputSchema: {
      type: "object",
      properties: {
        parent_type: str('Parent type: "page_id" (default), "database_id", "data_source_id", "block_id", or "workspace".'),
        parent_id: str("Parent id. Omit only when parent_type=workspace."),
        markdown: str("Page content as enhanced markdown; first `# heading` becomes the title (preferred over children)."),
        title: str("Convenience title when markdown has no heading or properties_json is absent."),
        properties_json: str("Full properties object as JSON, for database/data_source-backed pages."),
        icon_emoji: str('Emoji icon, e.g. "🚀".'),
        children_json: str("JSON array of block objects for the page content (use markdown instead when possible)."),
        cover_url: str("External cover image URL."),
        allow_async: bool("Opt into async processing; response returns an async_task id to poll."),
      },
      required: ["parent_type"],
    },
    run: (a) => {
      const body = {};
      if (a.parent_type === "workspace") {
        body.parent = { type: "workspace", workspace: true };
      } else {
        if (!a.parent_id) throw new Error("parent_id is required unless parent_type is workspace");
        body.parent = { type: a.parent_type, [a.parent_type]: a.parent_id };
      }
      const props = parseJsonParam(a.properties_json, "properties_json");
      if (props) body.properties = props;
      if (!props && a.title) {
        body.properties = { title: { type: "title", title: [{ type: "text", text: { content: a.title } }] } };
      }
      if (a.markdown) body.markdown = a.markdown;
      const children = parseJsonParam(a.children_json, "children_json");
      if (children) body.children = children;
      if (a.icon_emoji) body.icon = { type: "emoji", emoji: a.icon_emoji };
      if (a.cover_url) body.cover = { type: "external", external: { url: a.cover_url } };
      if (a.allow_async !== undefined) body.allow_async = a.allow_async;
      return client.createPage(body);
    },
  },
  {
    name: "notion_update_page",
    description: "Update page properties, icon or cover. Pass properties_json for property changes.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page id."),
        properties_json: str('Properties object as JSON, e.g. {"Status":{"status":{"name":"Done"}},"Done":{"checkbox":true}}.'),
        icon_json: str("Icon object as JSON."),
        cover_json: str("Cover object as JSON."),
      },
      required: ["page_id"],
    },
    run: (a) => {
      const body = {};
      const props = parseJsonParam(a.properties_json, "properties_json");
      if (props) body.properties = props;
      const icon = parseJsonParam(a.icon_json, "icon_json");
      if (icon) body.icon = icon;
      const cover = parseJsonParam(a.cover_json, "cover_json");
      if (cover) body.cover = cover;
      return client.updatePage(a.page_id, body);
    },
  },
  {
    name: "notion_move_page",
    description: "Move a page to a different parent (page, workspace, database or data source).",
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page id."),
        parent_type: str('"page_id", "workspace", "database_id" or "data_source_id".'),
        parent_id: str("New parent id (omit for workspace)."),
      },
      required: ["page_id", "parent_type"],
    },
    run: (a) => {
      const parent = a.parent_type === "workspace"
        ? { type: "workspace", workspace: true }
        : { type: a.parent_type, [a.parent_type]: a.parent_id };
      return client.movePage(a.page_id, { parent });
    },
  },
  {
    name: "notion_trash_page",
    description: "Move a page to trash (in_trash). Reversible with notion_restore_page.",
    inputSchema: { type: "object", properties: { page_id: str("Page id.") }, required: ["page_id"] },
    run: (a) => client.trashPage(a.page_id),
  },
  {
    name: "notion_restore_page",
    description: "Restore a page from trash/archive.",
    inputSchema: { type: "object", properties: { page_id: str("Page id.") }, required: ["page_id"] },
    run: (a) => client.restorePage(a.page_id),
  },
  {
    name: "notion_get_page_property",
    description: "Retrieve one page property item (e.g. a long relation or rollup) by property id.",
    inputSchema: {
      type: "object",
      properties: { page_id: str("Page id."), property_id: str("Property id from the page object."), ...optionalPaging },
      required: ["page_id", "property_id"],
    },
    run: (a) => client.getPageProperty(a.page_id, a.property_id, a),
  },
  {
    name: "notion_get_page_markdown",
    description: "Read a page's full content as markdown. Prefer this over block-walking.",
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page id."),
        markdown_version: str('"v1" enhanced markdown (default) or "v2" Notion-flavored markdown.'),
        include_transcript: bool("Include meeting-note transcripts."),
      },
      required: ["page_id"],
    },
    run: (a) => client.getPageMarkdown(a.page_id, {
      ...(a.markdown_version ? { markdown_version: a.markdown_version } : {}),
      ...(a.include_transcript !== undefined ? { include_transcript: a.include_transcript } : {}),
    }),
  },
  {
    name: "notion_update_page_markdown",
    description: 'Edit page content with markdown operations. Simplest: insert_content to append markdown at the end (or after an "start...end" anchor). For full control pass operation_json.',
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page id."),
        insert_content: str('Markdown to insert. Omit `after` to append at the end of the page.'),
        after: str('Anchor: insert after existing content selected as "start text...end text".'),
        at_start: bool("Insert at the start of the page instead of the end."),
        operation_json: str("Full typed operation object as JSON (insert_content/replace/delete/...). Overrides the convenience params."),
        markdown_version: str('"v1" (default) or "v2".'),
        allow_async: bool("Opt into async processing; poll the returned async_task id."),
      },
      required: ["page_id"],
    },
    run: (a) => {
      let body = parseJsonParam(a.operation_json, "operation_json");
      if (!body) {
        if (!a.insert_content) throw new Error("Provide either operation_json or insert_content");
        const ic = { content: a.insert_content };
        if (a.after) ic.after = a.after;
        else if (a.at_start) ic.position = { type: "start" };
        body = { type: "insert_content", insert_content: ic };
      }
      if (a.markdown_version) body.markdown_version = a.markdown_version;
      if (a.allow_async !== undefined) body.allow_async = a.allow_async;
      return client.updatePageMarkdown(a.page_id, body);
    },
  },

  /* blocks */
  {
    name: "notion_get_block",
    description: "Retrieve one block by id.",
    inputSchema: { type: "object", properties: { block_id: str("Block id (a page id works too — it is a block).") }, required: ["block_id"] },
    run: (a) => client.retrieveBlock(a.block_id),
  },
  {
    name: "notion_get_block_children",
    description: "List direct child blocks of a block/page. For whole-page reading prefer notion_get_page_markdown.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: str("Block or page id."),
        collect_all: bool("Fetch up to 5 pages (default single page)."),
        ...optionalPaging,
      },
      required: ["block_id"],
    },
    run: (a) => paged((q) => client.getBlockChildren(a.block_id, q), a, { collectAll: a.collect_all }),
  },
  {
    name: "notion_append_block_children",
    description: "Append blocks (paragraphs, headings, to-dos...) to a page or block. Pass children_json as a JSON array of block objects.",
    inputSchema: {
      type: "object",
      properties: {
        block_id: str("Parent block or page id."),
        children_json: str("JSON array of block objects, e.g. [{\"object\":\"block\",\"type\":\"paragraph\",\"paragraph\":{\"rich_text\":[{\"type\":\"text\",\"text\":{\"content\":\"Hi\"}}]}}]."),
      },
      required: ["block_id", "children_json"],
    },
    run: (a) => {
      const children = parseJsonParam(a.children_json, "children_json");
      if (!Array.isArray(children)) throw new Error("children_json must decode to an array of block objects");
      return client.appendBlockChildren(a.block_id, { children });
    },
  },
  {
    name: "notion_update_block",
    description: "Update a block's content by id.",
    inputSchema: {
      type: "object",
      properties: { block_id: str("Block id."), block_json: str("Block object as JSON with the fields to update.") },
      required: ["block_id", "block_json"],
    },
    run: (a) => {
      const body = parseJsonParam(a.block_json, "block_json");
      return client.updateBlock(a.block_id, body);
    },
  },
  {
    name: "notion_delete_block",
    description: "Archive/delete a block by id.",
    inputSchema: { type: "object", properties: { block_id: str("Block id.") }, required: ["block_id"] },
    run: (a) => client.deleteBlock(a.block_id),
  },

  /* databases & data sources */
  {
    name: "notion_retrieve_database",
    description: "Get a database: its data sources, title, parent. In the current API, rows/schema live on data sources (use notion_retrieve_data_source).",
    inputSchema: { type: "object", properties: { database_id: str("Database id.") }, required: ["database_id"] },
    run: (a) => client.retrieveDatabase(a.database_id),
  },
  {
    name: "notion_create_database",
    description: "Create a database under a parent page.",
    inputSchema: {
      type: "object",
      properties: {
        parent_page_id: str("Parent page id."),
        title: str("Database title."),
        icon_emoji: str('Emoji icon, e.g. "📊".'),
        properties_json: str('Optional initial schema, e.g. {"Name":{"title":{}},"Status":{"select":{"options":[{"name":"Todo"},{"name":"Done"}]}}}.'),
      },
      required: ["parent_page_id", "title"],
    },
    run: (a) => {
      const body = {
        parent: { type: "page_id", page_id: a.parent_page_id },
        title: [{ type: "text", text: { content: a.title } }],
      };
      const props = parseJsonParam(a.properties_json, "properties_json");
      if (props) body.properties = props;
      if (a.icon_emoji) body.icon = { type: "emoji", emoji: a.icon_emoji };
      return client.createDatabase(body);
    },
  },
  {
    name: "notion_retrieve_data_source",
    description: "Get a data source: full property schema and parent database. Find its id from a database object or search results.",
    inputSchema: { type: "object", properties: { data_source_id: str("Data source id.") }, required: ["data_source_id"] },
    run: (a) => client.retrieveDataSource(a.data_source_id),
  },
  {
    name: "notion_query_data_source",
    description: "Query rows of a data source with filter/sort. filter_json/sorts_json take the Notion filter/sort syntax; collect_all gathers up to 5 pages.",
    inputSchema: {
      type: "object",
      properties: {
        data_source_id: str("Data source id."),
        filter_json: str('Filter as JSON, e.g. {"property":"Done","checkbox":{"equals":true}} or {"and":[...]} compound.'),
        sorts_json: str('Sorts as JSON array, e.g. [{"property":"Created","direction":"descending"}].'),
        result_type: str("Restrict result object type (e.g. page)."),
        collect_all: bool("Fetch up to 5 pages of rows (default single page of 100)."),
        ...optionalPaging,
      },
      required: ["data_source_id"],
    },
    run: (a) => {
      const body = {};
      const filter = parseJsonParam(a.filter_json, "filter_json");
      if (filter) body.filter = filter;
      const sorts = parseJsonParam(a.sorts_json, "sorts_json");
      if (sorts) body.sorts = sorts;
      if (a.start_cursor) body.start_cursor = a.start_cursor;
      if (a.page_size) body.page_size = a.page_size;
      if (a.result_type) body.result_type = a.result_type;
      return paged((arg) => client.queryDataSource(a.data_source_id, arg), body, { collectAll: a.collect_all });
    },
  },

  /* comments */
  {
    name: "notion_create_comment",
    description: "Comment on a page (page_id) or reply in a discussion (discussion_id).",
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page id to comment on (omit when using discussion_id)."),
        discussion_id: str("Discussion id to reply in."),
        text: str("Comment text."),
        rich_text_json: str("Optional rich_text array as JSON (overrides text)."),
      },
      required: ["text"],
    },
    run: (a) => {
      const body = {};
      if (a.discussion_id) body.discussion_id = a.discussion_id;
      else if (a.page_id) body.parent = { type: "page_id", page_id: a.page_id };
      else throw new Error("Provide page_id or discussion_id");
      const richText = parseJsonParam(a.rich_text_json, "rich_text_json");
      body.rich_text = richText ?? [{ type: "text", text: { content: a.text } }];
      return client.createComment(body);
    },
  },
  {
    name: "notion_list_comments",
    description: "List comments on a page or block.",
    inputSchema: {
      type: "object",
      properties: { block_id: str("Page/block id."), collect_all: bool("Fetch up to 5 pages."), ...optionalPaging },
      required: ["block_id"],
    },
    run: (a) => paged((q) => client.listComments({ block_id: a.block_id, ...q }), a, { collectAll: a.collect_all }),
  },

  /* async tasks + raw passthrough */
  {
    name: "notion_retrieve_async_task",
    description: "Poll an async task returned by allow_async markdown operations.",
    inputSchema: { type: "object", properties: { task_id: str("Async task id.") }, required: ["task_id"] },
    run: (a) => client.retrieveAsyncTask(a.task_id),
  },
  {
    name: "notion_request",
    description: 'Raw REST escape hatch for any Notion endpoint not covered above: method + path + optional query_json/body_json. Example: method=POST, path=/v1/views, body_json={...}. Paths must start with /v1/.',
    inputSchema: {
      type: "object",
      properties: {
        method: str('HTTP method: GET, POST, PATCH or DELETE (default GET).'),
        path: str("Endpoint path starting with /v1/, e.g. /v1/data_sources/{id}/templates."),
        query_json: str("Query params object as JSON."),
        body_json: str("Request body object as JSON."),
      },
      required: ["path"],
    },
    run: (a) => {
      const method = (a.method ?? "GET").toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE", "PUT"].includes(method)) {
        throw new Error(`Unsupported method: ${method}`);
      }
      if (!/^\/v1\//.test(a.path)) throw new Error("path must start with /v1/");
      return client.request({
        method,
        path: a.path,
        query: parseJsonParam(a.query_json, "query_json"),
        body: parseJsonParam(a.body_json, "body_json"),
      });
    },
  },
];

/* ------------------------------ JSON-RPC server ----------------------------- */

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

const methods = {
  initialize(params) {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : "2025-06-18";
    return { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  },
  ping() {
    return {};
  },
  async "tools/list"() {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  },
  async "tools/call"(params) {
    const tool = tools.find((t) => t.name === params?.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${params?.name}` }],
        isError: true,
      };
    }
    try {
      const args = params.arguments ?? {};
      if (!client.auth) {
        return {
          content: [{ type: "text", text: "No Notion token configured. Set the NOTION_API_KEY environment variable for the Notion MCP server (a Notion internal integration token or personal access token, e.g. ntn_...), then retry." }],
          isError: true,
        };
      }
      const result = await tool.run(args);
      return { content: [{ type: "text", text: summarizeForDisplay(result) }] };
    } catch (err) {
      let text = err instanceof NotionAPIError
        ? `Notion API error ${err.status} ${err.code}: ${err.message}`
        : `Tool ${params.name} failed: ${err?.message ?? String(err)}`;
      if (err instanceof NotionAPIError && err.isUnauthorized) {
        text += "\nHint: the token was rejected (401). Check NOTION_API_KEY and that the integration has access to the content (share the page via Add connections, or verify the personal access token).";
      }
      if (err instanceof NotionAPIError && err.isNotFound) {
        text += "\nHint: object_not_found usually means the integration lacks access to that page/database — share it with the integration in Notion (••• menu → Connections).";
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  },
};

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore malformed lines
  }
  if (msg === null || typeof msg !== "object" || !msg.method) return;
  if (msg.id === undefined || msg.id === null) return; // notification — nothing to answer

  const handler = methods[msg.method];
  if (!handler) {
    return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
  try {
    const result = await handler(msg.params ?? {});
    return rpcResult(msg.id, result);
  } catch (err) {
    return rpcError(msg.id, -32603, `Internal error handling ${msg.method}: ${err?.message ?? String(err)}`);
  }
}

async function main() {
  const rl = createInterface({ input: process.stdin });
  const write = (obj) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };
  process.on("uncaughtException", (err) => {
    process.stderr.write(`uncaught: ${err?.stack ?? err}\n`);
  });
  process.on("unhandledRejection", (err) => {
    process.stderr.write(`unhandled rejection: ${err?.stack ?? err}\n`);
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const response = await handleMessage(line);
    if (response) write(response);
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
