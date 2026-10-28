# PageStudy 文档桥接服务

浏览器扩展不能直接调用宿主机的 MCP、`lark-cli` 或文件系统，所以用一个只监听本机的 Node 服务做桥接：

```text
Chrome/Edge 扩展
  └─ 后台 Service Worker
       └─ http://127.0.0.1:17373
            ├─ lark-cli docs +create / docs +update → 飞书云文档
            ├─ Notion REST API → Notion 页面
            └─ 本地 .md 文件 → Obsidian / Logseq
```

## 启动

在项目根目录：

```powershell
npm run bridge
```

或者双击：

```text
bridge\start-bridge.cmd
```

服务默认监听 `127.0.0.1:17373`。确认飞书 CLI 已登录（如果要用飞书）：

```powershell
lark-cli auth status
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PAGE_STUDY_BRIDGE_PORT` | 监听端口，默认 `17373` |
| `PAGE_STUDY_BRIDGE_HOST` | 监听地址，默认 `127.0.0.1` |
| `PAGE_STUDY_BRIDGE_TOKEN` | 可选的共享 Token；设置后扩展请求必须带 `x-pagestudy-token` |
| `LARK_CLI` | 自定义 CLI 命令路径，默认 Windows 使用 `lark-cli.cmd` |
| `NOTION_TOKEN` | Notion Internal Integration Secret；不设置则不启用 Notion |
| `NOTION_PARENT_PAGE_ID` | Notion 默认父页面 ID；扩展设置可覆盖 |
| `NOTION_API_BASE` | 可选，默认 `https://api.notion.com/v1`；测试时可指向假 API |
| `PAGESTUDY_MARKDOWN_DIR` | 本地 Markdown 根目录；不设置则不启用本地写入 |

PowerShell 示例：

```powershell
$env:PAGE_STUDY_BRIDGE_TOKEN = "请换成一个随机字符串"
$env:NOTION_TOKEN = "secret_xxx"
$env:NOTION_PARENT_PAGE_ID = "32 位页面 ID"
$env:PAGESTUDY_MARKDOWN_DIR = "D:\Notes\PageStudy"
npm run bridge
```

然后在扩展设置页“文档与同步”填写同一个桥接地址和 Token。Token 不要提交到代码仓库。

## Notion 配置

1. 在 Notion 创建 Internal Integration，复制 Secret。
2. 打开目标父页面 → 分享 → 邀请该 Integration。
3. 设置 `NOTION_TOKEN`，并设置 `NOTION_PARENT_PAGE_ID`，或在扩展里填写父页面 ID。
4. 父页面 ID 支持 32 位 ID，也支持包含 ID 的页面 URL。

当前 MVP 只支持 `page_id` 作为 parent，不直接写 database。Markdown 会转换为标题、列表、引用、代码块、分割线和表格行等 block；超过 100 个 block 会自动分批追加。

## 本地 Markdown

- 只写 `PAGESTUDY_MARKDOWN_DIR` 根目录内的文件。
- 扩展可以传相对于根目录的子目录，但不能是绝对路径，也不能用 `..` 跳出根目录。
- 新文件名格式：`标题 YYYYMMDD-HHmmss.md`；同秒冲突自动加序号。
- 追加时会在末尾插入 `---` 分隔线，保留原文。
- Obsidian / Logseq 直接把根目录设在 vault 内即可。

## 接口

### `GET /health`

```json
{
  "ok": true,
  "larkCli": true,
  "notion": true,
  "markdown": true,
  "markdownDir": "D:\\Notes\\PageStudy",
  "version": "lark-cli version 1.0.94"
}
```

`ok` 表示桥接 HTTP 服务正常；各目标是否可用看 `larkCli`、`notion`、`markdown`。

### `POST /api/feishu/docs`

创建飞书文档：

```json
{
  "title": "学习记录 · 文章标题 · 10/28",
  "markdown": "# 文章标题\n\n...",
  "parentToken": "可选：文件夹 token 或知识库节点 token"
}
```

### `POST /api/feishu/docs/:documentId/append`

追加飞书文档 Markdown：

```json
{ "markdown": "## 追加更新\n\n..." }
```

### `POST /api/notion/pages`

创建 Notion 页面：

```json
{
  "title": "学习记录 · 文章标题 · 10/28",
  "markdown": "# 文章标题\n\n...",
  "parentPageId": "可选，覆盖默认父页面"
}
```

返回：

```json
{
  "ok": true,
  "documentId": "notion_page_id",
  "url": "https://www.notion.so/..."
}
```

### `POST /api/notion/pages/:pageId/append`

追加 Notion block：

```json
{ "markdown": "## 追加更新\n\n..." }
```

### `POST /api/markdown/notes`

创建本地笔记：

```json
{
  "title": "学习记录 · 文章标题 · 10/28",
  "markdown": "# 文章标题\n\n...",
  "directory": "PageStudy"
}
```

返回：

```json
{
  "ok": true,
  "documentId": "PageStudy/学习记录 ...md",
  "path": "D:\\Notes\\PageStudy\\学习记录 ...md",
  "url": ""
}
```

### `POST /api/markdown/notes/append`

追加本地笔记：

```json
{ "documentId": "PageStudy/学习记录 ...md", "markdown": "## 追加更新" }
```

`documentId` 是相对于根目录的路径；也接受旧字段 `path`。

## 自动同步

扩展负责队列、重试和启动补偿；桥接只提供无状态的写入接口。自动同步失败不会删除队列，扩展会用 `chrome.alarms` 退避重试。关闭浏览器时 Manifest V3 不保证异步请求完成，扩展会在下次启动时补传。

## 安全边界

- 服务只绑定本机回环地址，CORS 只允许扩展来源和本机来源。
- 不把网页内容或用户标题拼进 shell 命令；飞书正文写入临时文件，通过 `@file` 传给 CLI。
- 父节点 token、文档 token 会做字符格式校验。
- Notion Token 只从环境变量读取，不返回给扩展，也不写日志。
- 本地文件路径会解析后校验是否位于配置根目录内，拒绝绝对路径和 `..` 越界。
- 写入动作由扩展侧用户点击或用户启用的自动同步触发，模型不能自行发布。
- 飞书临时 Markdown 文件在请求结束后删除。
