---
name: notion
description: Notion 集成总入口：创建 integration/token 并连接页面（建联），认证与 API 版本约定，通过 MCP 工具或 Node API 客户端操作 Notion，含分页、错误处理与限流实践。任何 Notion 相关任务先从这里开始。
---

# Notion 集成

本插件提供三种能力，按需选择：

1. **MCP 工具**（推荐）：安装插件后自动可用，工具名以 `notion_` 开头（`notion_search`、`notion_create_page`、`notion_query_data_source`、`notion_get_page_markdown` 等 20+ 个），另有一个 `notion_request` 原始端点逃生舱。
2. **API 客户端**：`../../api/client.mjs`（相对本 SKILL.md，即插件根下的 `api/client.mjs`），零依赖 Node（≥18），覆盖 2026-03-11 版全部 REST 端点，适合脚本与批量任务。
3. **配套技能**：`notion-database`（数据库查询/filter 语法）、`notion-authoring`（写内容/页面管理）。

## 一、建联：拿到 token 并连接内容

Notion API 的所有请求都需要 Bearer token，且 integration 只能访问**显式共享给它**的内容。

**获取 token（二选一）：**

- **Internal integration token**（团队自动化常用）：
  1. 打开 https://www.notion.so/my-integrations （或开发者门户 → New integration）；
  2. 命名、选择 workspace、保存；
  3. 在 Configuration 页复制 **Internal Integration Secret**（`ntn_` 或 `secret_` 开头，只显示一次）；
  4. 按需在 Capabilities 勾选读取内容/更新内容/插入内容/读取评论。
- **Personal Access Token (PAT)**（以个人身份操作，继承自己的权限，页面无需共享给 bot）：
  1. 打开 https://www.notion.so/developers/tokens → **New token**；
  2. 选择 Notion API capability，创建并复制（只显示一次）；
  3. Business/Enterprise 计划默认禁用 PAT，需管理员在 Settings → Connections 开启。

**连接页面/数据库（internal token 必做，PAT 跳过）：**

在 Notion 中打开目标页面 → 右上 `•••` → **Connections / 连接** → 添加你创建的 integration。共享父页面即同时共享其子页面。未共享的页面 API 返回 `object_not_found`。

**配置 token 给 MCP：** 在启动 ZCode 的环境中设置 `export NOTION_API_KEY=ntn_...`（插件 manifest 会透传该变量）。验证：调用 `notion_get_me`，返回 bot 名称与 workspace 即成功。

## 二、API 约定

- Base URL：`https://api.notion.com`；所有路径以 `/v1/` 开头，强制 HTTPS、JSON。
- 认证头：`Authorization: Bearer <token>`；版本头：`Notion-Version: 2026-03-11`（client 默认已带）。
- 顶层资源对象都有 `object` 和 `id`；属性名 snake_case；空值用 `null`，不支持空字符串。
- 分页：列表端点返回 `{results, has_more, next_cursor}`；用 `start_cursor` 翻页，`page_size` 最大 100。
- 速率限制：平均约 3 请求/秒，超限返回 429 + `Retry-After`。客户端已自动重试；自己写循环时也要尊重 Retry-After。
- 客户端内置 SSRF 防护：仅允许 http/https，拒绝 localhost/环回/私有/保留地址（含 DNS 解析校验），不要绕过它去改 base URL 指向内网。

## 三、MCP 工具速查

| 场景 | 工具 |
|---|---|
| 验证 token | `notion_get_me` |
| 找页面/数据库 | `notion_search`（`filter_value` 可限定 page/data_source） |
| 读页面属性 | `notion_retrieve_page` |
| 读页面正文 | `notion_get_page_markdown`（优先，勿逐块遍历） |
| 建/改/移/删页面 | `notion_create_page`、`notion_update_page`、`notion_move_page`、`notion_trash_page` / `notion_restore_page` |
| 编辑正文 | `notion_update_page_markdown`（insert_content 追加/锚点插入） |
| 块级操作 | `notion_get_block_children`、`notion_append_block_children`、`notion_update_block`、`notion_delete_block` |
| 数据库 | `notion_retrieve_database`、`notion_create_database`、`notion_retrieve_data_source`、`notion_query_data_source` |
| 评论 | `notion_create_comment`、`notion_list_comments` |
| 异步任务 | `notion_retrieve_async_task` |
| 其余端点 | `notion_request`（method + path + body_json，path 须以 /v1/ 开头） |

## 四、API 客户端用法（脚本）

```js
import { NotionClient, collectPaginatedAPI } from "../../api/client.mjs"; // 相对本 SKILL.md

const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });

// 创建页面（markdown 首个 # 标题即页面标题）
const page = await notion.createPage({
  parent: { type: "page_id", page_id: "PARENT_PAGE_ID" },
  markdown: "# 会议纪要\n\n- [ ] 跟进事项",
  icon: { type: "emoji", emoji: "🚀" },
});
console.log(page.url);

// 遍历全部用户（自动翻页）
const users = await collectPaginatedAPI(notion.listUsers.bind(notion));
```

命令行直接跑：`node your-script.mjs`（需先 `export NOTION_API_KEY=...`）。

## 五、错误处理

| 信号 | 含义与处理 |
|---|---|
| 401 `unauthorized` | token 无效/过期，或环境变量未展开（值是字面 `${NOTION_API_KEY}` 会被忽略）。重新配置 token。 |
| 404 `object_not_found` | 页面未共享给 integration（用 ••• → Connections 添加），或 id 错误。 |
| 400 `validation_error` | 请求体结构错误；对照 schema 修正，空字符串改 null。 |
| 429 `rate_limited` | 触发限流；客户端自动按 Retry-After 重试，批处理请降低并发。 |
| 409 `conflict_error` | 并发修改冲突（如版本 head 不匹配）；重读后再改。 |

定位失败时先 `notion_get_me` 验证链路，再 `notion_search` 确认目标可见，最后做具体调用。
