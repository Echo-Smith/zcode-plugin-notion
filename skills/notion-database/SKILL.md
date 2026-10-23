---
name: notion-database
description: 在 Notion 数据库/数据源上做结构化查询：定位数据库、取 data source schema、用 filter/sort 语法查询行、遍历分页、把行详情读成 markdown。建库与插入行也在此。
---

# Notion 数据库查询与写入

当前 API 中"数据库行 + schema"挂在 **data source** 上：一个 database 至少含一个 data source。查询流程固定三步：

1. `notion_search`（filter_value=data_source，或按库名搜 database）找到目标；
2. `notion_retrieve_data_source` 拿属性 schema —— **先看 schema 再写 filter**，property 名和类型以返回为准；
3. `notion_query_data_source` 用 filter/sort 查询行。

MCP 工具中 `filter_json` / `sorts_json` 接受 JSON 字符串；API 客户端直接传对象。

## Filter 语法

按属性类型选择条件对象，`property` 必须与 schema 中的属性名完全一致：

```json
// checkbox
{"property": "Done", "checkbox": {"equals": true}}
// select / status
{"property": "Status", "status": {"equals": "In progress"}}
// 多选包含其一
{"property": "Tags", "multi_select": {"contains": "api"}}
// 文本
{"property": "Name", "rich_text": {"contains": "纪要"}}
// 数字
{"property": "Score", "number": {"greater_than": 80}}
// 日期（ISO 8601）
{"property": "Created", "date": {"on_or_after": "2026-10-01"}}
// relation / people / files / formula 等同样有 contains/isempty 等
{"property": "Assignee", "people": {"is_not_empty": true}}
```

复合条件：

```json
{"and": [{"property": "Done", "checkbox": {"equals": false}},
         {"or": [{"property": "Priority", "select": {"equals": "High"}},
                 {"property": "Due", "date": {"before": "2026-10-30"}}]}]}
```

## Sort 与分页

```json
// sorts_json
[{"property": "Created", "direction": "descending"}, {"timestamp": "last_edited_time", "direction": "ascending"}]
```

- 单次最多 100 行（`page_size`）；`has_more: true` 时用 `next_cursor` 继续查。
- MCP 工具设 `collect_all: true` 可一次取最多 5 页（500 行）；更多请自行循环 `start_cursor`。
- API 客户端：`collectPaginatedAPI((q) => notion.queryDataSource(dsId, q), { filter, sorts })`。

## 读行内容

- 行对象的 `properties` 里 `title`/`rich_text` 取 `title[].plain_text` 或 `rich_text[].plain_text` 拼接；
- 要整段正文时，用行 id 调 `notion_get_page_markdown`（行就是页面，页面就是块）。

## 建库与插入行

```js
// 建库（在父页面下）
const db = await notion.createDatabase({
  parent: { type: "page_id", page_id: PARENT_ID },
  title: [{ type: "text", text: { content: "任务跟踪" } }],
  properties: {
    Name: { title: {} },
    Status: { select: { options: [{ name: "Todo" }, { name: "Done" }] } },
    Due: { date: {} },
  },
});

// 插入行：parent 用 database 的 data source id（db.data_sources[0].id 或 retrieve_database 获得）
const row = await notion.createPage({
  parent: { type: "data_source_id", data_source_id: DS_ID },
  properties: {
    Name: { title: [{ type: "text", text: { content: "发布周报" } }] },
    Status: { status: { name: "Todo" } },
    Due: { date: "2026-10-30" },
  },
});
```

更新行属性：`notion_update_page`（page_id 用行 id）传 `properties_json`，只改需要改的属性。

## 常见坑

- 用 database id 直接 query 会报错——先取 `data_sources[0].id`（`notion_retrieve_database` 或 search 结果里带）。
- filter 条件对象的键必须匹配属性类型（checkbox 用 `equals`，date 用 `on_or_after`），类型不匹配是 `validation_error` 最常见原因。
- 未共享给 integration 的库查不到（404），先在 Notion 里 Add connections。
