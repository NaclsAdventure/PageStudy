# PageStudy · 阅读学习助手

PageStudy 是一个 Chrome / Edge 的 MV3 浏览器扩展，用来把网页阅读变成可复习、可检索的本地学习资产：

1. 读取网页标题层级、正文块和正文图片，生成大纲树与全文快照。
2. 打开普通网页后自动准备全文上下文；在侧栏切换“智能全文 / 始终全文 / 仅选段 / 关闭”。
3. 选中文字自动聚焦，不需要再点“加入上下文”；直接向大模型提问。
4. 一键“记录本页”，生成 30 秒速读、核心论证、概念卡、章节笔记和问答沉淀。
5. 对话只提炼为知识结论，原始对话保存在本地，不整段复制到记录或导出文档。
6. 记录中的图片保留原链接和图注，可以逐张选择；写入飞书时上传为原生图片块，Markdown / Notion 使用图片链接。
7. 把记录写入**飞书文档、Notion 页面或本地 Markdown**（Obsidian / Logseq）；写飞书时使用原生 XML 块，并上传选中的正文图片。
8. 每次保存自动派生**本地 Wiki**：记录页、标签页、概念页互相建立反链。
9. 把本地 Wiki 发布到**飞书个人文档库**，形成私有 PageStudy Wiki；保存后可按需自动覆盖更新。
10. 保存后自动同步文档；失败任务进入持久队列，退避重试并在扩展启动时补传。
11. 对 `chrome://`、`edge://`、扩展管理等浏览器内置页，提供手动摘录模式。

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
3. 侧栏会自动索引全文，选择“上下文范围”。默认“智能全文”：短文直接带全文，长文自动挑选相关段落。
4. 在网页中选中要研究的一节，再直接提问；选中文字会自动成为当前聚焦段，讨论也会记录章节锚点。
5. 点击“记录”标签页中的“仅保存原文”建立快照；有 API Key 时也可以直接生成全文总览。推荐先读、先讨论，最后再生成整篇总览。
6. 在对话回答下方点“收进本节”，检查问题、结论、依据和归属章节后点“并入本节笔记”。这只会追加一条讨论结论，不会重新生成全文。
7. 如果忘了逐条收进，点记录页的“更新本节笔记”，会整理最近一轮还没沉淀的讨论。
8. 整篇读完后，再点“重新生成全文总览”；它明确表示重新读取全文并替换整份知识卡。
9. 在记录库或本地 Wiki 中继续编辑标签，导出 Markdown 或写入文档。
10. 在设置页“文档与同步”中启用自动同步后，保存记录会自动上传到默认目标。

---

## 功能说明

### 全文与图片提取

内容脚本会：

- 优先在 `article`、`[role="article"]`、`main` 中找正文根节点。
- 按 H1–H6 的文档顺序构建大纲树。
- 按文档顺序提取标题、段落、列表、引用、代码和表格块，形成全文快照。
- 排除导航、侧栏、页脚、目录、评论、广告、分享按钮等 UI 区域。
- 每个块保留稳定锚点；整页最多约 60000 字。
- 提取正文图片的地址、图注、所在章节和尺寸，过滤图标、头像、像素追踪图和纯装饰图，最多 16 张。
- 为标题生成稳定锚点，点击大纲标题可以跳回原文。

网页没有标题时，会回退为一个“全文”根节点；没有 `p`/`li` 等常见块级元素时，会从大纲文本构造一个可总结的根块。

### 讨论如何进入本节笔记

PageStudy 把“全文总览”和“讨论沉淀”分开：

- 一条回答下方出现“收进本节”，点击后只提炼**这一轮提问和回答**，不会重新发送全文，也不会重新生成整份知识卡。
- 弹窗会先显示问题和结论草稿；可以修改，确认后才“并入本节笔记”。并入成功后 8 秒内可在提示条上点“撤销”。
- 章节默认取提问时选中文字所在的一节；没有选中时可在弹窗里手动选择。
- 已整理的对话会标记为“已收进本节”；按问题和结论文本去重，避免重复追加同一张卡片。
- “更新本节笔记”用于补收最近一轮还没整理的讨论；“重新生成全文总览”才会重新读取全文并替换整份知识卡。
- 讨论结论在章节树里显示为“讨论沉淀”，导出的 Markdown、飞书文档和本地 Wiki 会带上“归属：章节名”。

当前“重新生成全文总览”仍会替换原有 `dialogueInsights`。如果之前的重要讨论已经超出最近 12 条消息，建议先把最终结论收进本节，再做全文总览。

### 浏览器内置页与手动摘录

内容脚本不能注入 `chrome://`、`edge://`、`chrome-extension://`、Web Store 等浏览器内置页面，这是浏览器的安全限制，不是扩展能绕过的。

PageStudy 的处理方式：

- 侧栏检测到受限 URL 时，自动切换到“记录”页的手动摘录模式。
- 可以填写标题、地址，并粘贴要学习的正文。
- 摘录会构造一个最小的页面上下文，标记为“手动摘录”，之后仍可生成知识卡、写入文档、进入 Wiki。
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

侧栏“上下文范围”有四档，选择会保存到设置：

| 模式 | 发送内容 | 适用 |
| --- | --- | --- |
| 智能全文（默认） | 页面简报 + 短文全文；长文自动挑选相关段落和相邻块 | 大多数阅读与提问 |
| 始终全文 | 页面简报 + 全文，最多约 60000 字 | 需要跨章节追问 |
| 仅选段 | 页面简报 + 当前聚焦段；不发送全文 | 精读一段、控制 token |
| 关闭 | 不发送网页内容；选中段仍可作为聚焦 | 隐私敏感页面 |

- 打开普通网页时自动读取并索引全文；切换模式不需要重新加载页面。
- 在网页中选中文字会自动成为“当前聚焦”，不需要手动“加入上下文”。
- 页面内容被明确标记为“不可信数据”，系统提示要求模型拒绝网页里的提示注入。
- 模型不能声称自己已经写入飞书/Notion/本地 Markdown；写入只能由用户点击按钮或启用明确的自动同步后触发。

### 记录与知识卡

- “仅保存原文”不需要模型，保存页面元数据、正文快照、图片、大纲和当前选中段。
- “记录本页”会先立即保存快照，再调用当前模型生成严格 JSON 知识卡；即使模型失败，原文也不会丢。
- 知识卡包含：
  - **30 秒速读**：一句话主张、3–5 条结论、标签；
  - **核心论证**：主张、证据、隐含假设、适用边界；
  - **概念卡**：术语和一句话解释；
  - **章节笔记**：按真实大纲节点绑定摘要、要点和待验证问题；
  - **问答沉淀**：只保留读者通过对话获得的新理解、纠正或判断；
  - **图表与图片**：图片原链接、图注和所在章节。
- 原始对话保存在 IndexedDB，用于下一次追问和生成知识卡，但**不会**整段复制到记录、Markdown、飞书/Notion 文档或本地 Wiki。
- 知识卡结果按 `outlineId` 绑定到真实大纲节点；无法匹配的内容会被丢弃，缺失节点会补空，避免把幻觉内容塞进无关章节。
- 网页内容哈希变化后重新记录会清除旧知识卡，但保留原记录 id、笔记、标签和图片选择。
- 文档引用采用合并写入：后台自动同步与侧栏编辑同时发生时，较新的文档 ID 不会被旧 UI 状态覆盖。

### 图片边界

当前版本把正文图片的**远程地址和图注**保存在记录中，IndexedDB 不存图片二进制。Markdown / Notion 使用图片链接；写入飞书时，扩展生成 `<img href="...">`，由 lark-cli 下载并上传为飞书图片块，因此飞书文档离线也能显示已上传的图片。图片下载仍受原图防盗链、登录态和有效期影响；上传失败的图片占位会被清理，并在写入结果中返回 warning。

### 记录库

独立页面 `dashboard.html`，功能包括：

- 搜索标题、URL、作者、笔记、标签。
- 按标签筛选、按最近更新或标题排序。
- 查看大纲树、30 秒速读、核心论证、概念卡、问答沉淀和图片。
- 编辑“我的判断”和标签。
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
- 可以在 Wiki 页点击“发布到飞书文档库”，把整套 Wiki 同步到飞书个人文档库；详见下文“飞书 Wiki 发布”。

本地 Wiki 始终从 IndexedDB 即时派生；飞书 Wiki 是它的云端镜像，不是数据源。

### 数据存储

- 设置与 API Key：`chrome.storage.local`，键名 `pagestudy.settings.v1`。
- 学习记录：IndexedDB `pagestudy` / `records`，包含正文块、图片链接、知识卡与本地对话；索引包括更新时间、URL、状态。
- 自动同步队列：`chrome.storage.local`，键名 `pagestudy.sync.queue.v1`。
- 飞书 Wiki 页面映射：`chrome.storage.local`，键名 `pagestudy.wiki.feishu.v1`。
- 飞书 Wiki 自动更新队列：`chrome.storage.local`，键名 `pagestudy.wiki.queue.v1`。
- 不包含云同步、统计或遥测。
- 设置页“数据与记录”可以导出/导入 JSON，或清空本地记录。

---

## 文档目标

### 架构

浏览器扩展不能直接调用宿主机的 MCP Server、lark-cli 或任意本地文件系统。PageStudy 采用：

```text
扩展后台 → 本地 Node 桥接（127.0.0.1:17373）
          ├─ 已登录的 lark-cli → 飞书文档 + 飞书个人文档库 Wiki
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
- `drive:file:upload`（把选中图片上传为飞书图片块）
- `wiki:wiki`、`wiki:wiki:readonly`、`wiki:space:read`
- `wiki:node:create`、`wiki:node:retrieve`、`wiki:node:read`
- `drive:drive.metadata:readonly`（更新标题/链接元数据时）

设置页 →“桥接与飞书”：

- 桥接地址：`http://127.0.0.1:17373`
- 桥接 Token：如果启动时设置了 `PAGE_STUDY_BRIDGE_TOKEN`，填写同一个值；否则留空。
- 父文件夹 / 知识库节点 Token：可选；填写后新文档会创建到该位置。

首次写入会创建新文档，并把返回的 URL 保存到记录里；已有文档时可以追加或新建一份。飞书正文使用 DocxXML 原生块：标题、列表、callout、章节和图片都是可编辑的飞书块，不是一整块 HTML 或 Markdown 文本。选中的图片会随首次写入上传；追加更新只写新增的速读、概念、问答和笔记，不重复上传图片。

### 飞书 Wiki 发布

“本地 Wiki”页面可以把整套 Wiki 发布到飞书**个人文档库**（`my_library`），云端结构为：

```text
我的文档库
└─ PageStudy Wiki
   ├─ 学习记录
   ├─ 标签主题
   └─ 概念主题
```

- 每个本地 Wiki 页面（记录页、标签页、概念页）对应一个飞书 docx 节点。
- 首次发布会创建根节点、三个分类节点和所有页面；映射 token 保存在 `pagestudy.wiki.feishu.v1`。
- 再次发布按内容哈希只覆盖有变化的文档，不重复创建节点；页面正文使用整篇覆盖更新。内容写入成功后才记录哈希，失败重试会真正补写，不会误判为“已是最新”。
- 本地记录或主题减少后，发布状态会裁剪掉不再出现的页面映射；云端旧页面不会自动删除，避免误删手工内容。
- 页面里的内部链接会在节点创建完成后替换成真实的飞书 Wiki URL，分类页和首页可互相跳转。
- 发布是**私有**行为：桥接只在当前用户的个人文档库内创建/更新节点，不添加协作者、不开启公开分享、不修改文档库可见性。
- 本地删除记录不会自动删除云端页面；需要时请在飞书手动清理。
- 如果本地映射丢失但云端已有同名 `PageStudy Wiki`，可以设置桥接环境变量 `FEISHU_WEB_ORIGIN`（例如 `https://your-tenant.feishu.cn`）后按标题复用根节点和分类；正常首次发布不需要该变量。

发布入口：记录库 → 本地 Wiki → “发布到飞书文档库”。

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

- 保存记录、生成知识卡、编辑笔记/标签（停顿约 2.5 秒）后，会把任务加入持久队列。
- 有已有文档引用时追加，没有时创建新文档。
- 失败按 15 秒、30 秒、1 分钟……递增退避，最长 30 分钟；刷新页面或扩展启动时继续补传。
- 侧栏/记录库的手动写入会移除同记录同目标的待处理任务，避免重复创建。
- 设置页可以点击“立即处理同步队列”。
- “保存后自动更新飞书 Wiki”是独立开关：启用后，保存记录或编辑笔记/标签会延迟约 8 秒重建 Wiki 并发布；失败按 15 秒、30 秒……退避，浏览器启动时补传。
- Wiki 自动更新只处理有变化的页面（内容哈希相同的页面跳过），不会重复创建飞书节点。

**边界说明**：Manifest V3 不能保证在关闭浏览器的瞬间完成异步网络请求。PageStudy 使用“保存后立即同步 + 持久队列 + 启动补偿 + `onSuspend` 尽力冲刷”，而不是承诺关闭时一定上传成功。看到记录中的“已自动同步”或 Wiki 页面显示“已发布”才代表云端写入成功。

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
npm run verify:feishu  # 用假 lark-cli 验证飞书 XML、图片地址和本地文件引用拦截
npm run verify:wiki    # 用假 lark-cli 验证 Wiki 创建、复用、幂等更新、失败重试与链接替换
```

项目结构：

```text
src/
  background/      Service Worker：消息路由、模型调用、知识卡生成、文档写入、文档与 Wiki 自动同步队列
  content/         内容脚本：正文/大纲/选区提取、悬浮按钮
  dashboard/       记录库 + 本地 Wiki + 飞书 Wiki 发布
  options/         设置页面：模型、文档与同步、桥接、Skills、数据
  shared/          类型、常量、设置、上下文拼装、IndexedDB、Markdown、飞书 DocxXML、文档引用、Wiki、Wiki 发布、Skill 提示词
  sidepanel/       侧栏 React 应用与大纲树
bridge/
  lark-bridge.mjs      本地桥接 HTTP 服务
  feishu-wiki.mjs      飞书个人文档库 Wiki 创建/复用/覆盖更新
  notion.mjs           Notion API 与 Markdown → block 转换
  markdown-store.mjs   Obsidian/Logseq 本地文件写入
  start-bridge.cmd
scripts/
  verify-bridge.mjs    桥接端到端验证（假 Notion）
  verify-wiki.mjs      飞书 Wiki 发布器验证（假 lark-cli）
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

流式聊天通过 `chrome.runtime.Port`（名称 `ps-chat`）传递 SSE 增量；知识卡生成使用非流式请求，要求模型只输出 JSON。知识卡请求会把输出预算提高到 8192 tokens；如果模型仍输出截断或结构损坏，会自动用精简提示重试一次。

### 已知边界

- 最低 Chrome / Edge 116（`chrome.sidePanel.open` 和点击图标打开侧栏）。
- 内容脚本会注入所有 HTTP/HTTPS 页面；这是为了按需读取当前文章，未做站点白名单。
- 浏览器内置页不能读取正文，只能手动摘录；扩展不会、也不能绕过浏览器限制。
- 网页改版后，旧记录的锚点可能失效，但正文快照、知识卡和笔记仍保存在本地。
- 图片在本地只保存远程链接和图注，不下载二进制；写入飞书时才会下载并上传为图片块。离线或原图失效时，本地记录中的图片仍无法显示。
- 飞书图片上传受原图防盗链、登录态、有效期和单图 20MB 限制，且只支持 lark-cli 能识别的 PNG / JPEG / GIF / WebP；SVG 等格式会跳过并返回 warning。
- 智能上下文目前是关键词/二元组检索，不是语义向量检索；长文可能漏掉同义表达的相关段落。
- Notion MVP 只支持写入父页面，不直接支持 database 属性。
- 飞书 Wiki 发布到当前用户的个人文档库（`my_library`），不会选择团队知识空间；云端文档权限跟随个人文档库，扩展不会主动改为公开。
- 飞书 Wiki 的页面身份依赖本地映射；清空浏览器数据后，若云端已有同名根节点，需要 `FEISHU_WEB_ORIGIN` 才能按标题复用，否则会新建一套根节点。
- 本地删除记录不会自动删除飞书 Wiki 页面，避免误删用户手工整理的内容。
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

**飞书 Wiki 发布失败**

- 确认 `lark-cli auth status` 已登录，且 scope 包含 `wiki:wiki`、`wiki:space:read`、`wiki:node:create`、`wiki:node:retrieve`。
- 确认桥接版本是当前版本；`/health` 应返回 `wiki: true`。
- 如果提示“无法解析飞书个人文档库”，先在飞书网页端打开一次“我的文档库”，确认当前账号可见。
- 发布是覆盖更新：不要手工把 PageStudy 生成的 Wiki 文档改造成其他用途，否则下一次发布会被整篇替换。
- 如果本地映射丢失，优先在扩展设置中导出数据备份；需要复用旧根节点时设置 `FEISHU_WEB_ORIGIN`，否则发布会新建根节点。

---

## Agent 会话知识库（Pi / DSH）

浏览器扩展之外，仓库还提供一个独立的 Agent 原生插件：

`agent/conversation-wiki/`

它把 **Pi / DeepSeek Harness 会话**作为输入，生成同一套“会话 / 标签 / 概念”本地 Wiki，并可选发布到飞书个人文档库。Pi 和 DSH 共用同一份无第三方依赖的 ESM 核心。

- Pi：`pi install ./agent/conversation-wiki`
- DSH：在插件管理器中安装 `./agent/conversation-wiki` bundle
- 默认只写本地；`autoPublish` 和 `feishu.enabled` 默认关闭
- 完整说明见 [agent/conversation-wiki/README.md](agent/conversation-wiki/README.md)

---

## 隐私说明

- 页面内容只在你主动提问、点击“记录本页”生成知识卡或手动摘录保存时发送给当前配置的模型服务商。
- 发送内容包括页面标题、URL、大纲摘录、选中段落和对话；不会发送整页脚本或浏览器数据。
- API Key、记录、Wiki 和同步队列默认只存在本机浏览器。
- 文档写入只发送你保存的那条记录；桥接不保存长期正文副本，Feishu 临时文件请求结束后删除。
- Notion Token 和 Markdown 根目录只存在于桥接进程环境变量中，不写入扩展存储。
