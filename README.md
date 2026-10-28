# PageStudy · 阅读学习助手

PageStudy 是一个 Chrome / Edge 的 MV3 浏览器扩展，用来把网页阅读变成可复习、可检索的本地学习资产：

1. 读取网页标题层级，生成大纲树。
2. 在侧栏选中段落，加载 Skill，向大模型提问。
3. 一键记录本页，保存 URL、大纲、对话和总结。
4. 按大纲逐节生成结构化总结，形成可折叠的学习大纲树。
5. 把记录写入**飞书文档、Notion 页面或本地 Markdown**（Obsidian / Logseq）。
6. 每次保存自动派生**本地 Wiki**：记录页、标签页、概念页互相建立反链。
7. 保存后自动同步文档；失败任务进入持久队列，退避重试并在扩展启动时补传。
8. 对 `chrome://`、`edge://`、扩展管理等浏览器内置页，提供手动摘录模式。

技术栈：**React 18 + TypeScript + Vite**，数据本地优先。

---

## 快速开始

### 1. 安装依赖并构建

```powershell
cd PageStudy
npm install
npm run build
```

构建产物在 `dist/`。

### 2. 加载扩展

**Chrome**

1. 打开 `chrome://extensions`。
2. 打开右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择项目下的 `dist` 目录。
4. 在工具栏固定 PageStudy 图标。

**Edge**

1. 打开 `edge://extensions`。
2. 打开“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择 `dist`。

修改代码后重新执行 `npm run build`，然后在扩展管理页点击刷新。

### 3. 配置模型

点击扩展图标打开侧栏，再点右上角“设”进入设置页：

- 选择服务商：DeepSeek、OpenAI、Anthropic、Gemini 或自定义 OpenAI 兼容接口。
- 填写 API Key、Base URL、模型名称。
- 选择推理强度，点击“测试当前模型”。
- 保存设置。

API Key 只保存在 `chrome.storage.local`，侧栏只拿到“是否已配置”的公开信息。设置页可以临时显示 Key，但不会写入日志。

### 4. 使用

1. 打开一篇博客文章。
2. 点击工具栏 PageStudy 图标（或页面右下角“学”按钮）。
3. 在网页中选中一段文字，点击“加入上下文”。
4. 选择 Skill，输入问题。
5. 点击“记录”标签页中的“记录并总结”。
6. 在记录库或本地 Wiki 中继续编辑笔记、标签，导出 Markdown 或写入文档。
7. 在设置页“文档与同步”中启用自动同步后，保存记录会自动上传到默认目标。

---

## 功能说明

### 大纲提取

内容脚本会：

- 优先在 `article`、`[role="article"]`、`main` 中找正文根节点。
- 按 H1–H6 的文档顺序构建大纲树。
- 排除导航、侧栏、页脚、目录、评论、广告、分享按钮等 UI 区域。
- 每个章节保留最多约 5000 字原文摘录，整页最多约 60000 字。
- 为标题生成稳定锚点，点击大纲标题可以跳回原文。

网页没有标题时，会回退为一个“全文”根节点。

### 浏览器内置页与手动摘录

内容脚本不能注入 `chrome://`、`edge://`、`chrome-extension://`、Web Store 等浏览器内置页面，这是浏览器的安全限制，不是扩展能绕过的。

PageStudy 的处理方式：

- 侧栏检测到受限 URL 时，自动切换到“记录”页的手动摘录模式。
- 可以填写标题、地址，并粘贴要学习的正文。
- 摘录会构造一个最小的页面上下文，标记为“手动摘录”，之后仍可生成总结、写入文档、进入 Wiki。
- 如果普通网页读取失败（例如 PDF 阅读器、页面脚本异常），也会回退到手动摘录，而不是让整个侧栏空白。

> 手动摘录不会伪装成自动读取；页面卡片和记录中会明确标记来源。

### Skill

内置 11 个只读 Skill：

| Skill | 用途 |
| --- | --- |
| 通用助读 | 解释、追问、梳理，不限定输出格式 |
| 逐段精读 | 论证、概念、例子和上下文关系 |
| 批判性阅读 | 区分主张、证据、假设和反例 |
| 概念拆解 | 定义、类比、边界和常见误区 |
| 学习卡片 | 生成可复习的问答卡片 |
| 费曼讲解 | 用自己的话讲清楚，暴露理解断点 |
| 苏格拉底追问 | 不急着给答案，用问题逼近假设与边界 |
| 康奈尔笔记 | 线索、笔记、总结三栏 |
| 主动回忆 | 闭卷检索题和间隔复习安排 |
| 卡片笔记 | 原子笔记与可连接概念 |
| 渐进式总结 | 从原文到一句话，逐层压缩重点 |

新增的 6 个学习类 Skill 参考了公开的学习方法资料，并在设置页提供来源链接：

- [the-learning-skill](https://github.com/toddward/the-learning-skill)：费曼、主动回忆、间隔复习
- [anthropics/skills](https://github.com/anthropics/skills)：审慎追问与学习辅助思路
- [Cornell Learning Strategies Center](https://lsc.cornell.edu/how-to-study/taking-notes/cornell-note-taking-system/)：康奈尔笔记
- [Zettelkasten 入门](https://zettelkasten.de/introduction/)：卡片笔记
- [Progressive Summarization](https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/)：渐进式总结

这些 Skill 的提示词是针对 PageStudy 重新编写的中文模板，不是对原仓库提示词的逐字复制。

设置页可以添加自定义 Skill（名称、描述、提示词），也可以导入 JSON 数组。Skill 只是提示词模板，不能执行代码，也不能自动调用写入工具。

### 聊天上下文

- 侧栏最多保留 4 段选中上下文。
- 发送给模型的内容包括页面标题、URL、站点、作者、大纲标题与摘录、选中段落，以及最近 20 条对话。
- 页面内容被明确标记为“不可信数据”，系统提示要求模型拒绝网页里的提示注入。
- 模型不能声称自己已经写入飞书/Notion/本地 Markdown；写入只能由用户点击按钮或启用明确的自动同步后触发。

### 记录与总结

- “仅记录”不需要模型，保存页面快照、大纲、对话和选中段落。
- “记录并总结”会先立即保存记录，再调用当前模型生成严格 JSON 总结。
- 总结包含：整篇概览、标签、逐节摘要/要点/待思考问题、关键概念。
- 总结结果会按 `outlineId` 绑定到真实大纲节点；无法匹配的内容会被丢弃，缺失节点会补空，避免把幻觉内容塞进无关章节。
- 网页内容哈希变化后重新记录会清除旧总结，但保留原记录 id、笔记和标签。
- 文档引用采用合并写入：后台自动同步与侧栏编辑同时发生时，较新的文档 ID 不会被旧 UI 状态覆盖。

### 记录库

独立页面 `dashboard.html`，功能包括：

- 搜索标题、URL、作者、笔记、标签。
- 按标签筛选、按最近更新或标题排序。
- 查看大纲树、概览、关键概念。
- 编辑笔记和标签。
- 复制/下载 Markdown。
- 选择飞书、Notion 或本地 Markdown，创建或追加文档。
- 查看每个目标的文档引用与同步状态。
- 删除记录。

### 本地 Wiki 知识库

独立页面 `dashboard.html#wiki`（记录库右上角“本地 Wiki”）：

- 每条学习记录自动生成一个“记录页”。
- 记录的标签聚合为“标签主题页”，关键概念聚合为“概念主题页”。
- 记录页链接到主题页，主题页通过反链回到记录页；同一标签跨记录自动合并。
- 支持按全部/记录/标签/概念过滤，支持搜索标题、标签和概念。
- Wiki 完全从 IndexedDB 中的最新记录即时派生，不需要额外模型调用、额外上传或手工“转化”步骤。
- 主题页可以查看相关记录，记录页可以跳回记录库继续编辑。

当前 Wiki 只保存在本机浏览器；它不会自动发布到外部知识库。

### 数据存储

- 设置与 API Key：`chrome.storage.local`，键名 `pagestudy.settings.v1`。
- 学习记录：IndexedDB `pagestudy` / `records`，索引包括更新时间、URL、状态。
- 自动同步队列：`chrome.storage.local`，键名 `pagestudy.sync.queue.v1`。
- 不包含云同步、统计或遥测。
- 设置页“数据与记录”可以导出/导入 JSON，或清空本地记录。

---

## 文档目标

### 架构

浏览器扩展不能直接调用宿主机的 MCP Server、lark-cli 或任意本地文件系统。PageStudy 采用：

```text
扩展后台 → 本地 Node 桥接（127.0.0.1:17373）
          ├─ 已登录的 lark-cli → 飞书
          ├─ Notion REST API → Notion 页面
          └─ 本地 .md 文件 → Obsidian / Logseq
```

这样做的原因：

- 飞书用户 Token、Notion Integration Secret 不进入浏览器扩展。
- 复用机器上已经登录的 `lark-cli`。
- 本地文件写入只在用户配置的根目录内发生，并做路径穿越检查。
- 写入动作只发生在本地回环地址。

### 启动桥接

```powershell
cd PageStudy
npm run bridge
```

默认地址：`http://127.0.0.1:17373`。详细接口和环境变量见 [bridge/README.md](bridge/README.md)。

桥接只监听 `127.0.0.1`。如果设置了 `PAGE_STUDY_BRIDGE_TOKEN`，扩展设置里必须填写同一个值。

### 环境变量

| 变量 | 作用 |
| --- | --- |
| `PAGE_STUDY_BRIDGE_PORT` | 桥接端口，默认 `17373` |
| `PAGE_STUDY_BRIDGE_TOKEN` | 可选的本地请求 Token |
| `LARK_CLI` | lark-cli 可执行文件路径 |
| `NOTION_TOKEN` | Notion Internal Integration Secret |
| `NOTION_PARENT_PAGE_ID` | 默认 Notion 父页面 ID |
| `PAGESTUDY_MARKDOWN_DIR` | 本地 Markdown 根目录（建议指向 Obsidian/Logseq vault 内） |
| `NOTION_API_BASE` | 可选，测试时覆盖 Notion API 地址 |

PowerShell 示例：

```powershell
$env:NOTION_TOKEN="secret_xxx"
$env:NOTION_PARENT_PAGE_ID="你的父页面 ID"
$env:PAGESTUDY_MARKDOWN_DIR="D:\Notes\PageStudy"
npm run bridge
```

### 飞书

前置条件：

1. 已安装 Node.js 18+。
2. 已安装并登录 `lark-cli`：

```powershell
lark-cli auth status
```

3. 当前用户具备创建/编辑文档所需权限。至少需要：

- `docx:document:create`
- `docx:document:write_only`
- `docx:document:readonly`（检查/回查时）

设置页 →“桥接与飞书”：

- 桥接地址：`http://127.0.0.1:17373`
- 桥接 Token：如果启动时设置了 `PAGE_STUDY_BRIDGE_TOKEN`，填写同一个值；否则留空。
- 父文件夹 / 知识库节点 Token：可选；填写后新文档会创建到该位置。

首次写入会创建新文档，并把返回的 URL 保存到记录里；已有文档时可以追加或新建一份。

### Notion

1. 在 Notion 创建 Internal Integration，复制 Secret。
2. 打开目标父页面 → 分享 → 邀请该 Integration。
3. 设置 `NOTION_TOKEN`，并设置 `NOTION_PARENT_PAGE_ID` 或在扩展“文档与同步”里填写父页面 ID。
4. 父页面 ID 可以是 32 位 ID，也可以粘贴包含 ID 的页面 URL。

当前 MVP **只支持父页面**，不直接写 Notion database。Markdown 会转换成 Notion 的标题、列表、引用、代码块、分割线和表格行；复杂嵌套块可能降级为普通段落。

### Obsidian / Logseq

1. 设置 `PAGESTUDY_MARKDOWN_DIR` 为一个存在的根目录，建议放在 vault 内。
2. 可选：在扩展设置里填写相对子目录，例如 `PageStudy`。
3. 新建文档会写入 `标题 20261028-153000.md` 这样的文件；追加会在原文件末尾插入分隔线。
4. 桥接会拒绝绝对路径和 `..` 越界路径。

### 自动同步与关闭浏览器

设置页“文档与同步”可以开启“保存后自动同步”：

- 保存记录、保存总结、编辑笔记/标签（停顿约 2.5 秒）后，会把任务加入持久队列。
- 有已有文档引用时追加，没有时创建新文档。
- 失败按 15 秒、30 秒、1 分钟……递增退避，最长 30 分钟；刷新页面或扩展启动时继续补传。
- 侧栏/记录库的手动写入会移除同记录同目标的待处理任务，避免重复创建。
- 设置页可以点击“立即处理同步队列”。

**边界说明**：Manifest V3 不能保证在关闭浏览器的瞬间完成异步网络请求。PageStudy 使用“保存后立即同步 + 持久队列 + 启动补偿 + `onSuspend` 尽力冲刷”，而不是承诺关闭时一定上传成功。看到记录中的“已自动同步”才代表文档写入成功。

---

## 附带的 Agent Skill

仓库内提供可复用的 Skill：[`skills/browser-extension/`](skills/browser-extension/SKILL.md)，用于构建、调试和发布 Chrome/Edge MV3 扩展，包含 Vite 骨架、运行时、权限安全和验收清单。

安装到当前用户的全局 Skill 目录：

```powershell
$target = "$env:USERPROFILE\.agents\skills\browser-extension"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force .\skills\browser-extension\* $target
```

安装后重启 Agent 会话以重新扫描 Skill。仓库文件是源文件，全局目录是运行副本。

## 开发

```powershell
npm run dev        # 仅用于页面样式开发，扩展实际加载 dist
npm run typecheck  # TypeScript 严格检查
npm test           # Vitest
npm run build      # 页面 + content script + background
npm run verify:bridge  # 用假 Notion API 验证桥接创建/追加、Markdown 写入和路径拦截
```

项目结构：

```text
src/
  background/      Service Worker：消息路由、模型调用、总结、文档写入、自动同步队列
  content/         内容脚本：正文/大纲/选区提取、悬浮按钮
  dashboard/       记录库 + 本地 Wiki
  options/         设置页面：模型、文档与同步、桥接、Skills、数据
  shared/          类型、常量、设置、IndexedDB、Markdown、文档引用、Wiki、Skill 提示词
  sidepanel/       侧栏 React 应用与大纲树
bridge/
  lark-bridge.mjs      本地桥接 HTTP 服务
  notion.mjs           Notion API 与 Markdown → block 转换
  markdown-store.mjs   Obsidian/Logseq 本地文件写入
  start-bridge.cmd
scripts/
  verify-bridge.mjs    桥接端到端验证（假 Notion）
public/
  manifest.json
  icons/
```

### 模型适配

| 服务商 | 接口 | 推理强度映射 |
| --- | --- | --- |
| DeepSeek / OpenAI / 自定义 | `/chat/completions` | `reasoning_effort`；`xhigh`/`max` → `high` |
| Anthropic | `/v1/messages` | `thinking.budget_tokens`：2k/4k/8k/16k/24k |
| Gemini | `:generateContent` | `thinkingConfig`：`thinkingBudget` 或 Gemini 3 的 `thinkingLevel` |

流式聊天通过 `chrome.runtime.Port`（名称 `ps-chat`）传递 SSE 增量；总结使用非流式请求，要求模型只输出 JSON。

### 已知边界

- 最低 Chrome / Edge 116（`chrome.sidePanel.open` 和点击图标打开侧栏）。
- 内容脚本会注入所有 HTTP/HTTPS 页面；这是为了按需读取当前文章，未做站点白名单。
- 浏览器内置页不能读取正文，只能手动摘录；扩展不会、也不能绕过浏览器限制。
- 网页改版后，旧记录的锚点可能失效，但大纲、总结和笔记仍保存在本地。
- Notion MVP 只支持写入父页面，不直接支持 database 属性。
- 本地 Markdown 写入依赖本机桥接；扩展本身没有文件系统权限。
- 自动同步不保证浏览器关闭瞬间完成，详见上文“自动同步与关闭浏览器”。
- 目前没有账号体系、云同步和多人协作。
- 扩展未在应用商店发布，使用“加载已解压”方式安装。

---

## 排错

**侧栏显示“无法读取页面正文”**

- 内置页或受限页会进入手动摘录模式；这是预期行为。
- 普通网页可以刷新后重试，或在扩展管理页重新加载扩展。
- 检查页面是否被浏览器内置 PDF 阅读器接管。

**模型请求失败**

- 检查 API Key、Base URL、模型名。
- 点击“拉取列表”确认接口可达。
- 429 通常是额度或频率限制；401/403 检查 Key 和权限。

**桥接连接失败**

```powershell
# 在项目目录启动
npm run bridge

# 另开终端检查
Invoke-WebRequest http://127.0.0.1:17373/health -UseBasicParsing
```

- 确认 `lark-cli` 在 PATH 中，或设置 `LARK_CLI` 指向可执行文件。
- 确认扩展设置里的地址/Token 与桥接一致。
- 查看桥接终端输出的错误信息；不要在公开渠道粘贴包含 Token 的完整日志。

**Notion 返回 404 / 找不到父页面**

- 确认页面已分享给 Integration。
- 确认父页面 ID 属于当前 Token 可访问的工作区。
- 当前不支持 database 作为 parent，请使用普通页面。

**本地 Markdown 写入失败**

- 确认 `PAGESTUDY_MARKDOWN_DIR` 存在并可写。
- 扩展里填写的子目录不能是绝对路径，也不能包含 `..` 越界。
- 如果文件被移动或删除，追加会失败；重新创建文档即可。

**同步一直失败**

- 在设置页点击“立即处理同步队列”查看错误。
- 检查桥接是否运行、目标 Token 是否有效。
- 自动同步队列是持久的；修复配置后重试会继续处理。

---

## 隐私说明

- 页面内容只在你主动提问、点击“记录并总结”或启用手动摘录保存时发送给当前配置的模型服务商。
- 发送内容包括页面标题、URL、大纲摘录、选中段落和对话；不会发送整页脚本或浏览器数据。
- API Key、记录、Wiki 和同步队列默认只存在本机浏览器。
- 文档写入只发送你保存的那条记录；桥接不保存长期正文副本，Feishu 临时文件请求结束后删除。
- Notion Token 和 Markdown 根目录只存在于桥接进程环境变量中，不写入扩展存储。
