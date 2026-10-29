# Conversation Wiki

把一次对话从“聊天记录”变成可回看、可检索、可链接的知识资产。

这个包同时提供：

- **Pi 原生扩展**：自动捕获会话、注册 `conversation_wiki` 工具和 `/conversation-wiki` 命令。
- **DeepSeek Harness（DSH）原生插件**：自动捕获、工具、运行时技能和飞书发布。
- **共享核心**：两个宿主共用同一份配置、记录格式和 Markdown Wiki，不依赖第三方运行时库。

## 能力

- 会话结束自动保存转录；默认只写本地。
- 人工 `record` 可补充标题、概览、会话脉络、决策、行动项、开放问题、标签和概念。
- 生成 `sessions / topics / concepts` 三类页面，标签页和概念页自动反链到相关会话。
- 同一主题跨会话聚合，中文标题和中文标签可用。
- 可选发布到飞书**个人文档库**；默认关闭，必须显式启用。
- 对 API Key、Bearer token、私钥等做基础脱敏。
- 内容哈希去重：没有变化时不重复写本地文件，也不重复覆盖云端文档。

## 安装

### Pi

```bash
# 本地目录安装
pi install /absolute/path/to/agent/conversation-wiki

# 或从 GitHub 安装（替换为实际仓库地址）
pi install git:github.com/NaclsAdventure/PageStudy
```

安装后：

```bash
pi list
```

包声明了：

```json
{
  "pi": {
    "extensions": ["./pi.js"],
    "skills": ["./skills"]
  }
}
```

Pi 会自动加载扩展和 `skills/conversation-wiki/SKILL.md`。也可以不安装，直接用：

```bash
pi --extension /absolute/path/to/agent/conversation-wiki/pi.js
```

### DeepSeek Harness

把本地包目录作为 bundle 安装：

```text
plugin_manager install_bundle /absolute/path/to/agent/conversation-wiki
```

包内 `cordis.patch.yml` 会插入：

```yaml
- insert:
    - id: conversation-wiki
      name: 'pagestudy-conversation-wiki'
```

安装后可用 `plugin_manager set_bundle` 启用/停用；也可以在 Web 设置的插件管理里操作。

## 配置

默认目录：

```text
~/.conversation-wiki/
  config.json
  vault/
    index.md
    sessions/
    topics/
    concepts/
    .conversation-wiki/
      records/*.json
      wiki-state.json
      feishu-state.json
```

可用环境变量 `CONVERSATION_WIKI_HOME` 指向其他目录。

`config.json` 示例：

```json
{
  "schemaVersion": 1,
  "vault": "C:\\Users\\you\\.conversation-wiki\\vault",
  "autoCapture": true,
  "autoPublish": false,
  "captureSubagents": false,
  "includeToolMessages": false,
  "maxMessages": 400,
  "maxChars": 120000,
  "feishu": {
    "enabled": false,
    "space": "my_library",
    "rootTitle": "会话知识库",
    "origin": ""
  }
}
```

建议：

- 首次使用先把 `autoCapture` 设为 `false`，确认目录和隐私边界后再打开。
- `autoPublish` 默认 `false`；即使设为 `true`，也需要 `feishu.enabled=true` 才会发布。
- `captureSubagents` 默认 `false`，避免把子代理的临时推理写进知识库。
- `includeToolMessages` 默认 `false`；开启后会保存工具输出，可能包含敏感内容。

## 使用

### 自动捕获

开启 `autoCapture` 后：

- Pi：在 `agent_settled` 后保存当前会话。
- DSH：在 `agent/turn-stopping` 时保存当前会话。

自动捕获只更新转录和来源；已经人工整理过的摘要不会被覆盖。

### Agent 工具

两个宿主都提供同一个工具：

```text
conversation_wiki
```

常用调用：

```json
{
  "action": "record",
  "title": "会话知识库插件设计",
  "overview": "把 Pi/DSH 会话转换成共享核心的本地 Wiki。",
  "tags": ["知识管理", "Pi", "DSH"],
  "concepts": [
    { "term": "会话知识库", "explanation": "从对话派生出的结构化 Markdown Wiki。" }
  ],
  "sections": [
    {
      "title": "目标与范围",
      "summary": "本地优先，飞书可选。",
      "keyPoints": ["默认不自动发布", "Pi/DSH 共用核心"]
    }
  ],
  "decisions": ["共享 core，宿主各自提供原生入口"],
  "actionItems": ["补充真实飞书发布回归"],
  "openQuestions": ["是否支持多语言标题"],
  "notes": "默认只保存在本机。",
  "publish": false
}
```

其他 action：

- `capture`：只保存转录。
- `publish`：发布到飞书。
- `status`：查看记录数、页面数、路径和发布状态。
- `init`：初始化目录和空白 Wiki。

Pi 还提供命令：

```text
/conversation-wiki status
/conversation-wiki publish
/conversation-wiki init
```

### 命令行

```bash
node cli.mjs init
node cli.mjs status --json
node cli.mjs build
node cli.mjs record --file record.json
node cli.mjs publish
```

`record` 的完整格式见
[`skills/conversation-wiki/references/record-schema.md`](skills/conversation-wiki/references/record-schema.md)。

## 飞书发布

发布依赖 `lark-cli` 已完成用户授权：

```bash
lark-cli auth status
```

配置：

```json
{
  "feishu": {
    "enabled": true,
    "space": "my_library",
    "rootTitle": "会话知识库",
    "origin": "https://your-tenant.feishu.cn"
  }
}
```

首次发布：

1. 解析个人文档库 `my_library`。
2. 查找或创建 `会话知识库` 根节点。
3. 创建 `会话记录 / 标签主题 / 概念主题` 三个分类节点。
4. 为每条记录、每个标签、每个概念创建页面。
5. 按内容哈希覆盖文档正文，链接替换为飞书 Wiki URL。

之后再次发布只更新变化页面；本地删除记录不会自动删除云端文档，只会裁剪本地状态映射，避免误删。

发布目标是个人文档库。不要添加成员、不要开启公开分享。发布前请确认会话中没有客户数据、凭据或个人信息。

## 目录结构

```text
agent/conversation-wiki/
  package.json
  dsh.js                 # DSH 插件入口
  pi.js                  # Pi 扩展入口
  cli.mjs                # 命令行
  cordis.patch.yml       # DSH bundle patch
  icon.svg
  locale/{en,zh}.json
  core/
    config.mjs
    redact.mjs
    transcript.mjs
    records.mjs
    wiki.mjs
    feishu-publisher.mjs
    lark.mjs
    feishu.mjs
    index.mjs
    util.mjs
  skills/conversation-wiki/
    SKILL.md
    references/record-schema.md
  test/
    core.test.mjs
    feishu.test.mjs
    dsh.test.mjs
```

## 开发与验证

```bash
node --test test/core.test.mjs test/feishu.test.mjs test/dsh.test.mjs
node --check dsh.js
node --check pi.js
```

测试覆盖：

- 转录归一化、脱敏、超长截断。
- 自动记录与人工摘要合并。
- 中文标签/概念页 ID、反链、幂等写入、旧页面清理。
- 飞书发布器的创建、复用、跳过、更新、失败重试、状态裁剪。
- DSH 插件注册、自动捕获、子会话跳过、结构化记录。
- DSH 工具 schema 必须使用标准 JSON Schema `required` 数组。

### 已验证环境

- Pi `0.85.1`：扩展加载，并通过模型实际调用 `conversation_wiki status`。
- DeepSeek Harness `0.2.1-rc.3`：bundle 安装并注册 `conversation_wiki` 工具与 `conversation-wiki` 技能。
- 飞书发布器：使用 fake `runLark` 做创建/更新/跳过/失败重放测试；真实发布前需要有效 `lark-cli` 授权。

## 设计说明

- **本地记录是事实来源**：`records/*.json` 保存完整转录和结构化字段；Markdown 和飞书页面都是派生视图。
- **内容哈希去重**：本地只在内容变化时写文件；云端只在页面哈希变化时覆盖。
- **保留人工整理**：自动捕获不会覆盖 `enriched` 记录的摘要字段。
- **链接占位符**：页面内部先写 `{{cw:<pageId>}}`，本地替换为相对路径，飞书替换为 Wiki URL。
- **安全边界**：默认 `autoCapture` 可关、`autoPublish` 默认关、发布前脱敏、只写个人文档库。

## License

MIT
