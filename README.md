# PageStudy · 阅读学习助手

PageStudy 是一个 Chrome / Edge 的 MV3 浏览器扩展，用来把博客阅读变成可复习的学习记录：

1. 读取网页标题层级，生成大纲树。
2. 在侧栏选中段落，加载 Skill，向大模型提问。
3. 一键记录本页，保存 URL、大纲、对话和总结。
4. 按大纲逐节生成结构化总结，形成可折叠的学习大纲树。
5. 通过本地 `lark-cli` 桥接，把记录写入飞书云文档；支持后续追加。

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
6. 在记录库中继续编辑笔记、标签，导出 Markdown 或写入飞书。

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

### Skill

内置 5 个只读 Skill：

| Skill | 用途 |
| --- | --- |
| 通用助读 | 解释、追问、梳理，不限定输出格式 |
| 逐段精读 | 论证、概念、例子和上下文关系 |
| 批判性阅读 | 区分主张、证据、假设和反例 |
| 概念拆解 | 定义、类比、边界和常见误区 |
| 学习卡片 | 生成可复习的问答卡片 |

设置页可以添加自定义 Skill（名称、描述、提示词），也可以导入 JSON 数组。Skill 只是提示词模板，不能执行代码，也不能自动调用写入工具。

### 聊天上下文

- 侧栏最多保留 4 段选中上下文。
- 发送给模型的内容包括页面标题、URL、站点、作者、大纲标题与摘录、选中段落，以及最近 20 条对话。
- 页面内容被明确标记为“不可信数据”，系统提示要求模型拒绝网页里的提示注入。
- 模型不能声称自己已经写入飞书；写入只能由用户点击按钮触发。

### 记录与总结

- “仅记录”不需要模型，保存页面快照、大纲、对话和选中段落。
- “记录并总结”会先立即保存记录，再调用当前模型生成严格 JSON 总结。
- 总结包含：整篇概览、标签、逐节摘要/要点/待思考问题、关键概念。
- 总结结果会按 `outlineId` 绑定到真实大纲节点；无法匹配的内容会被丢弃，缺失节点会补空，避免把幻觉内容塞进无关章节。
- 网页内容哈希变化后重新记录会清除旧总结，但保留原记录 id、笔记和标签。

### 记录库

独立页面 `dashboard.html`，功能包括：

- 搜索标题、URL、作者、笔记、标签。
- 按标签筛选、按最近更新或标题排序。
- 查看大纲树、概览、关键概念。
- 编辑笔记和标签。
- 复制/下载 Markdown。
- 创建或追加飞书文档。
- 删除记录。

### 数据存储

- 设置与 API Key：`chrome.storage.local`，键名 `pagestudy.settings.v1`。
- 学习记录：IndexedDB `pagestudy` / `records`，索引包括更新时间、URL、状态。
- 不包含任何云同步、统计或遥测。
- 设置页“数据与记录”可以导出/导入 JSON，或清空本地记录。

---

## 飞书文档

### 为什么不直接在扩展里调 MCP

浏览器扩展运行在沙箱中，不能直接调用宿主机的 MCP Server 或 Skill。PageStudy 采用：

```text
扩展后台 → 本地 Node 桥接 → 已登录的 lark-cli → 飞书
```

这样做的好处：

- 飞书 App Secret / 用户 Token 不进入浏览器扩展。
- 复用你机器上已经登录的 `lark-cli`。
- 写入动作只发生在本地回环地址。

### 前置条件

1. 已安装 Node.js 18+。
2. 已安装并登录 `lark-cli`：

```powershell
lark-cli auth status
```

3. 当前用户具备创建/编辑文档所需权限。至少需要：

- `docx:document:create`
- `docx:document:write_only`
- `docx:document:readonly`（检查/回查时）

### 启动桥接

```powershell
cd PageStudy
npm run bridge
```

或双击 `bridge\start-bridge.cmd`。

默认地址：`http://127.0.0.1:17373`。

详细接口和环境变量见 [bridge/README.md](bridge/README.md)。

### 扩展内配置

设置页 →“飞书桥接”：

- 桥接地址：`http://127.0.0.1:17373`
- 桥接 Token：如果启动时设置了 `PAGE_STUDY_BRIDGE_TOKEN`，填写同一个值；否则留空。
- 父文件夹 / 知识库节点 Token：可选；填写后新文档会创建到该位置。

点击“检测桥接”，看到“已连接”即可。

### 写入与追加

- 首次点击“写入飞书”会创建新文档，并把返回的 URL 保存到记录里。
- 已有文档时，侧栏显示“追加到飞书”和“新建文档”。
- 追加只写“本次更新”（概览、关键概念、笔记、标签），不重复整篇大纲。
- 写入必须由用户点击触发；模型不能调用写入接口。

> 目前扩展使用 Markdown 创建文档。飞书 CLI 的 Markdown 导入能力有限，复杂表格、图片或自定义块可能被降级；学习记录以标题、列表、引用和代码块为主。

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
```

项目结构：

```text
src/
  background/      Service Worker：消息路由、模型调用、总结、飞书
  content/         内容脚本：正文/大纲/选区提取、悬浮按钮
  dashboard/       记录库页面
  options/         设置页面
  shared/          类型、常量、设置、IndexedDB、Markdown、Skill 提示词
  sidepanel/       侧栏 React 应用与大纲树
bridge/
  lark-bridge.mjs  本地飞书桥接
  start-bridge.cmd
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
- 网页改版后，旧记录的锚点可能失效，但大纲、总结和笔记仍保存在本地。
- 目前没有账号体系、云同步和多人协作。
- 飞书写入依赖本机桥接；桥接未启动时只能复制/下载 Markdown。
- 扩展未在应用商店发布，使用“加载已解压”方式安装。

---

## 排错

**侧栏显示“无法读取页面正文”**

- 刷新网页后重试。
- 确认当前页面是普通 HTTP/HTTPS 页面，不是 `chrome://`、扩展页或 PDF 阅读器。
- 在扩展管理页重新加载扩展。

**模型请求失败**

- 检查 API Key、Base URL、模型名。
- 点击“拉取列表”确认接口可达。
- 429 通常是额度或频率限制；401/403 检查 Key 和权限。

**飞书桥接连接失败**

```powershell
# 在项目目录启动
npm run bridge

# 另开终端检查
Invoke-WebRequest http://127.0.0.1:17373/health -UseBasicParsing
```

- 确认 `lark-cli` 在 PATH 中，或设置 `LARK_CLI` 指向可执行文件。
- 确认扩展设置里的地址/Token 与桥接一致。
- 查看桥接终端输出的错误信息；不要在公开渠道粘贴包含 Token 的完整日志。

**写入成功但文档内容不完整**

- 飞书 Markdown 导入对部分语法有限制；优先保留标题、列表、引用、代码块。
- 可先用“复制 Markdown”检查内容，再决定是否调整飞书侧格式。

---

## 隐私说明

- 页面内容只在你主动提问或点击“记录并总结”时发送给当前配置的模型服务商。
- 发送内容包括页面标题、URL、大纲摘录、选中段落和对话；不会发送整页脚本或浏览器数据。
- API Key、记录和笔记默认只存在本机浏览器。
- 飞书写入只发送你点击写入的那条记录；桥接不保存正文副本，临时文件请求结束后删除。
