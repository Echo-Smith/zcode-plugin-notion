---
name: notion-authoring
description: 在 Notion 里写内容：用 markdown 创建/更新页面、按锚点插入段落、块级追加、设置 icon/属性、移动/回收页面、发表评论。写文档、周报、会议纪要走这个技能。
---

# Notion 内容创作与页面管理

## 首选路径：markdown

markdown 端点最省 token、可读性最好；`# 一级标题` 自动成为页面标题。

**创建页面**（`notion_create_page` 或 `client.createPage`）：

```js
await notion.createPage({
  parent: { type: "page_id", page_id: PARENT_ID },
  icon: { type: "emoji", emoji: "📝" },
  markdown: [
    "# 2026-10-23 周报",
    "",
    "## 本周进展",
    "- 完成 API 客户端",
    "",
    "## 下周计划",
    "- [ ] 联调 MCP",
  ].join("\n"),
});
```

**读取页面**：`notion_get_page_markdown`（`markdown_version: "v2"` 可取 Notion 风格 markdown）。

**编辑已有页面**（`notion_update_page_markdown`，PATCH 语义是操作指令而非整体覆盖）：

```js
// 末尾追加（最常用）
await notion.updatePageMarkdown(pageId, {
  type: "insert_content",
  insert_content: { content: "## 新章节\n\n内容…" },
});

// 在既有内容之后插入：锚点是 "起始文本...结束文本"（省略号选中中间内容）
await notion.updatePageMarkdown(pageId, {
  type: "insert_content",
  insert_content: { content: "- 新增条目", after: "## 本周进展...## 下周计划" },
});

// 页首插入
await notion.updatePageMarkdown(pageId, {
  type: "insert_content",
  insert_content: { content: "> 置顶说明", position: { type: "start" } },
});
```

MCP 工具对应传参：`insert_content` + 可选 `after` / `at_start`；复杂操作传 `operation_json`。大页面可设 `allow_async: true`，返回 async_task id 后用 `notion_retrieve_async_task` 轮询。

## 块级操作（需要精细控制时）

```js
// 追加块
await notion.appendBlockChildren(pageId, {
  children: [
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: "小节" } }] } },
    { object: "block", type: "to_do", to_do: { rich_text: [{ type: "text", text: { content: "事项" } }], checked: false } },
    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ type: "text", text: { content: "要点" } }] } },
    { object: "block", type: "code", code: { rich_text: [{ type: "text", text: { content: "console.log(1)" } }], language: "javascript" } },
    { object: "block", type: "callout", callout: { rich_text: [{ type: "text", text: { content: "注意" } }], icon: { type: "emoji", emoji: "⚠️" } } },
  ],
});

// 更新/删除单个块
await notion.updateBlock(blockId, { paragraph: { rich_text: [...] } });
await notion.deleteBlock(blockId);
```

能用 markdown 就别手拼块；markdown 端点会把文本自动转块。

## 页面属性与管理

```js
// 改标题/属性（页面在库里时）
await notion.updatePage(pageId, {
  properties: { Status: { status: { name: "Done" } }, Done: { checkbox: true } },
});

// 换 icon
await notion.updatePage(pageId, { icon: { type: "emoji", emoji: "✅" } });

// 移动页面
await notion.movePage(pageId, { parent: { type: "page_id", page_id: NEW_PARENT } });

// 回收站（可恢复） / 恢复
await notion.trashPage(pageId);
await notion.restorePage(pageId);
```

## 评论

```js
// 页面评论
await notion.createComment({ parent: { type: "page_id", page_id: PAGE_ID }, rich_text: [{ type: "text", text: { content: "已审阅 ✅" } }] });
// 回复讨论
await notion.createComment({ discussion_id: DISCUSSION_ID, rich_text: [{ type: "text", text: { content: "收到" } }] });
```

MCP：`notion_create_comment` 传 `page_id` / `discussion_id` + `text` 即可。

## 写作建议

- 一次 `createPage` 的 markdown 控制在合理长度内（超长内容分多次 `insert_content` 追加更稳）；
- 插入前先 `notion_get_page_markdown` 拿到现有标题结构，锚点才不会选错；
- 敏感内容写入前与用户确认目标页面（写入是外部可见动作）。
