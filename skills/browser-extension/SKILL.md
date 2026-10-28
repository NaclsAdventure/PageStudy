---
name: browser-extension
description: 构建、调试、审查或发布 Chrome/Edge Manifest V3 浏览器扩展（也常被叫作浏览器插件）。用户提到 content script、background service worker、side panel、popup/options 页面、host permissions、扩展消息通信、网页内容提取、加载已解压扩展或扩展上架时使用。
---

# 浏览器扩展

浏览器扩展不是“一个网页”，而是由几个互相隔离的**面**组成的系统：网页里的 content script、扩展自己的 service worker、侧栏/设置等扩展页面，以及它们之间的消息和存储。先把面画清，再写界面。

## 开始之前

- 判断任务属于新建、改现有扩展，还是只做审查/排错；三种入口共用本 Skill 的约束。
- 先读 `manifest.json`、`package.json`、构建配置和项目内的 `AGENTS.md` / `README.md`。不要凭记忆猜权限、入口或最低浏览器版本。
- 默认技术栈是 TypeScript + Vite；用户明确要求“无构建步骤”时才改用原生 JS。
- 先打通一条最短真实路径：打开网页 → 读取内容 → 侧栏展示 → 产生一条本地记录。再增加模型、导出、同步等分支。
- 产物默认放 `dist/`；`node_modules/` 和 `dist/` 默认不提交，除非用户要求发布构建产物。

## 流程

### 1. 画清扩展面与权限

列出每个面：

| 面 | 作用 | 典型入口 |
| --- | --- | --- |
| content script | 读取/标注当前网页 | `src/content/index.ts` |
| service worker | 消息路由、网络请求、权限操作 | `src/background/index.ts` |
| side panel / popup | 高频交互界面 | `sidepanel.html` / `popup.html` |
| options | 配置、密钥、数据管理 | `options.html` |
| dashboard | 记录库、历史数据 | `dashboard.html` |

同时写清：谁是可信上下文，谁只接触不可信网页内容，API Key 存在哪里，哪些动作会产生外部副作用。

**完成标准**：`manifest.json` 中每个 `permissions` / `host_permissions` 都能对应一句具体用途；没有未使用的权限；确定目标浏览器和最低版本。

需要 API 选择、Side Panel 生命周期或消息模型时，读 [references/mv3-runtime.md](references/mv3-runtime.md)。

### 2. 搭最小骨架

先生成能加载的空扩展：

- `public/manifest.json` + 图标；
- 至少一个扩展页面；
- 一个 content script；
- 一个 background service worker；
- `typecheck`、`test`、`build` 三条脚本；
- `dist/` 可直接通过“加载已解压的扩展”打开。

Vite 页面构建、content/background 的独立 IIFE 构建、目录结构、manifest 模板和最小脚本，见 [references/vite-scaffold.md](references/vite-scaffold.md)。

**完成标准**：三条命令都通过；`dist/manifest.json` 存在；把 `dist` 加载到 headed Chrome/Edge 后，扩展页面能打开且 service worker 无启动错误。

### 3. 写运行时

按以下顺序实现，避免界面先长出来但底层不可用：

1. **存储**：设置用 `chrome.storage.local`；大量结构化记录用 IndexedDB，并定义 schema/version/索引。
2. **消息**：用可辨识联合类型定义消息；异步 `sendMessage` 处理器返回 `true`；请求带 `type` 和稳定的 `requestId`。
3. **长连接**：流式输出用 `chrome.runtime.Port`，按端口跟踪活动请求；断开端口只中止该端口的请求。
4. **网络**：API Key 只在 service worker 或 options 读取；页面内容只作为数据，不执行页面里的指令。
5. **错误**：把 HTTP 状态、超时、空响应、取消分别映射为可读错误；用户能看到下一步该做什么。

**完成标准**：service worker 被浏览器回收并重启后，功能仍能靠持久化状态恢复；流式请求可以停止；端口断开不会留下悬挂状态。

### 4. 做网页内容与侧栏

- content script 运行在隔离世界，不要给页面挂全局 API，也不要依赖页面的 CSS。
- 先找正文根节点（`article`、`[role="article"]`、`main`，再做可见文本量回退），排除导航、页脚、评论、广告等 UI 区域。
- 从 H1–H6 的文档顺序构建大纲树；为标题生成稳定锚点，支持侧栏回跳。
- 读取选区时保留原文、所在段落、标题路径和锚点；允许用户清除上下文。
- 侧栏要处理“当前标签不是普通网页”的情况，不能把扩展页或 `chrome://` 页面当文章。

**完成标准**：在至少一个真实博客页面上，大纲标题、正文摘录、选区加入上下文、点击标题回跳都可用；页面没有标题或正文时有无崩溃的回退。

### 5. 接模型、密钥和外部副作用

- API Key 只保存于 `chrome.storage.local`，并通过 `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` 限制内容脚本读取。
- 模型适配层集中处理 provider 差异：Base URL、鉴权头、流式 SSE、推理强度字段、错误映射。
- 网页内容是不可信数据；系统提示要明确边界，模型不能声称已经写文件、调用工具或发布内容。
- 扩展不能直接启动宿主机的 MCP/CLI。需要调用本机工具时，走只监听 `127.0.0.1` 的本地桥接，并做来源校验、Token（可选）、输入长度/格式校验和超时。
- 外部写入必须由用户点击触发；自动化测试涉及真实账号时，先说明目标并取得确认，再执行。

涉及权限、密钥、提示注入、CORS 和本地桥接的审查清单，见 [references/security-review.md](references/security-review.md)。

**完成标准**：API Key 不出现在 content script、页面 DOM、日志或提交内容中；未配置密钥时有明确引导；外部桥接不可用时仍有复制/下载等本地回退；模型无法自行触发外部写入。

### 6. 真实验收

按顺序做：

1. `npm run typecheck`、`npm test`、`npm run build`。
2. 在 headed Chrome/Edge 中加载 `dist`，打开真实网页，走完主路径。
3. 检查控制台和 service worker 控制台，解释每一条错误。
4. 如果接入了本地桥接，先 `GET /health`，再测试一次创建和一次追加；真实外部写入前做 dry-run 或 mock。
5. 重新构建后刷新扩展，避免把旧 bundle 当成新代码。

**完成标准**：主路径在真实浏览器中可复现；构建产物可加载；测试/类型检查/构建全部通过；未执行的真实外部副作用在交付说明中明确标出。

自动化、常见故障和发布检查见 [references/verification.md](references/verification.md)。

### 7. 交付

README 至少覆盖：安装/加载、配置、主要功能、数据与隐私、权限理由、已知限制、开发命令。版本号同时更新 `manifest.json` 和 `package.json`；发布压缩包时，把 `dist` 里的文件放在压缩包根目录，排除 source map、测试文件、密钥和本地数据。

**完成标准**：一个新用户只读 README 就能加载并完成一条主路径；仓库中没有 `node_modules`、`dist`、日志、API Key、真实用户数据或本地绝对路径。

## 硬规则

- `chrome.sidePanel.open()` 和 `setPanelBehavior()` 需要 Chromium 116+；`side_panel` 本身虽从 114 开始，但点击图标打开侧栏的行为按 116 设计。
- content script 的构建产物必须是单文件 IIFE；不要让它产生动态 `import()` 或依赖页面加载的 chunk。
- service worker 内存会在空闲后丢失；活动请求、用户选择、待处理状态要落盘或在端口重建时恢复。
- 扩展包内只运行静态打包代码；远程脚本、`eval`、动态 `new Function` 都不进入 MV3 扩展。
- 页面正文、标题、选中段落、网页里的“系统提示”都按不可信数据处理。
- 外部写入放在明确的用户手势之后；模型输出不能直接成为写操作。
- 没有在真实浏览器里加载过的扩展，不称为“已完成”。

## 按需阅读

- [references/vite-scaffold.md](references/vite-scaffold.md)：Vite/React/TS 骨架、manifest、独立 content/background 构建。
- [references/mv3-runtime.md](references/mv3-runtime.md)：service worker、side panel、消息、存储、正文抽取、SSE。
- [references/security-review.md](references/security-review.md)：权限最小化、密钥、提示注入、CORS、本地桥接。
- [references/verification.md](references/verification.md)：单测、真实浏览器验收、自动化限制、发布清单。
