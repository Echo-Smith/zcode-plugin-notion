# Notion Plugin for ZCode

Notion 集成插件，基于 Notion API `2026-03-11` 版（https://developers.notion.com），包含三部分能力：

## 1. 完整 REST API 客户端（`api/client.mjs`）

零依赖（Node ≥ 18），覆盖官方 OpenAPI 规范全部 49 个端点：

- **users**：`me` / `getUser` / `listUsers`
- **pages**：创建/读取/更新、`movePage`、trash/restore、属性项、**markdown 读写端点**（`getPageMarkdown` / `updatePageMarkdown`）
- **blocks**：读取/更新/删除、children 追加、meeting notes
- **databases & data sources**：retrieve/create/update、`queryDataSource`（filter/sort）、templates
- **search**、**comments**、**file uploads**（单分/多分/外链）、**views** + 视图查询
- **custom emojis**、**async tasks**、**agents**、**AI plugins/skills**、**sessions**、**OAuth token** 管理

内建：分页助手（`iteratePaginatedAPI` / `collectPaginatedAPI`）、429/5xx 自动重试（尊重 Retry-After）、超时控制、**SSRF 防护**（仅 http/https；请求前校验 host，拒绝 localhost/环回/私有/保留地址，含 DNS 解析校验与重定向再校验）。

```js
import { NotionClient, collectPaginatedAPI } from "./api/client.mjs";
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY }); // 或 NOTION_TOKEN
```

## 2. MCP 服务器（`mcp/server.mjs`）

stdio JSON-RPC 2.0（MCP 协议 2024-11-05 / 2025-03-26 / 2025-06-18），26 个工具：

`notion_get_me`、`notion_search`、`notion_list_users`、`notion_get_user`、`notion_retrieve_page`、`notion_create_page`、`notion_update_page`、`notion_move_page`、`notion_trash_page`、`notion_restore_page`、`notion_get_page_property`、`notion_get_page_markdown`、`notion_update_page_markdown`、`notion_get_block`、`notion_get_block_children`、`notion_append_block_children`、`notion_update_block`、`notion_delete_block`、`notion_retrieve_database`、`notion_create_database`、`notion_retrieve_data_source`、`notion_query_data_source`、`notion_create_comment`、`notion_list_comments`、`notion_retrieve_async_task`、`notion_request`（原始端点逃生舱）。

配置：环境变量 `NOTION_API_KEY`（必备，internal token 或 PAT，`ntn_` 开头）；可选 `NOTION_VERSION`、`NOTION_BASE_URL`。

## 3. Skills（`skills/`）

- **notion** — 建联指南（创建 integration/PAT、Add connections 共享页面）、API 约定、工具速查、错误处理。
- **notion-database** — 数据库/数据源查询：schema 探查、filter/sort 语法、分页遍历、建库插行。
- **notion-authoring** — 内容创作：markdown 创建/编辑页面、锚点插入、块级操作、评论、页面管理。

## 快速开始

1. 在 https://www.notion.so/my-integrations 或 https://www.notion.so/developers/tokens 创建 token；
2. （internal token）在目标页面 `•••` → Connections 添加 integration；
3. `export NOTION_API_KEY=ntn_...` 后重启 ZCode；
4. 新任务里用 `notion_get_me` 验证连通。
