---
name: conversation-wiki
description: 把当前会话整理成结构化知识页，保存到本地 Conversation Wiki（会话、标签、概念互相反链），并可按需发布到飞书个人文档库。
---

# 会话知识库

把一次对话从“聊天记录”变成可回看、可检索、可链接的知识资产。

## 何时使用

- 用户说“把这次会话整理进知识库 / 保存这次讨论 / 建一个会话笔记 / 做成 Wiki”。
- 用户希望从长对话里提炼决策、行动项、概念和主题标签。
- 用户要求把会话知识发布到飞书个人文档库。
- 需要查看本地会话知识库状态或手动触发发布。

不需要使用的场景：临时问答、一次性代码修改、用户明确说“不要保存”。

## 工具

Pi 和 DSH 都提供同一个工具：

```text
conversation_wiki
```

`action` 的取值：

| action | 用途 |
| --- | --- |
| `record` | 用结构化摘要保存/更新当前会话（最常用） |
| `capture` | 只保存原始转录，不写摘要 |
| `publish` | 把本地 Wiki 发布到飞书个人文档库 |
| `status` | 查看记录数、页面数、飞书状态和路径 |
| `init` | 初始化本地目录和空白 Wiki |

### record 的推荐参数

```json
{
  "action": "record",
  "title": "会话知识库插件设计",
  "overview": "讨论如何把 Pi/DSH 会话转换为本地 Wiki，并保留飞书发布能力。",
  "tags": ["知识管理", "Pi", "DSH"],
  "concepts": [
    { "term": "会话知识库", "explanation": "从对话派生出的结构化 Markdown Wiki。" }
  ],
  "sections": [
    {
      "title": "目标与范围",
      "summary": "把对话转为可检索的知识页，而不是保存网页。",
      "keyPoints": ["本地优先", "飞书可选", "默认不自动发布"]
    }
  ],
  "decisions": ["共享核心，Pi/DSH 各自提供原生入口"],
  "actionItems": ["补充发布失败重试"],
  "openQuestions": ["是否支持多语言标题"],
  "notes": "用户特别强调隐私，默认只保存在本机。",
  "publish": false
}
```

字段要求：

- `title`：短而具体；不要用“对话记录”“聊天”这种无信息标题。
- `overview`：2–4 句，说明谈了什么、结论是什么。
- `sections`：按问题/阶段拆 2–6 节，不要按消息顺序逐条复述。
- `tags`：3–8 个稳定主题词，优先名词；不要写“讨论”“问题”这类空标签。
- `concepts`：只收可复用的术语，并给一句话解释；普通名词不要收。
- `decisions`：已经做出的选择，写“选了什么 + 为什么”。
- `actionItems`：可执行的下一步；不要写“继续讨论”。
- `openQuestions`：确实未决的问题；没有就省略。
- `notes`：只放用户明确补充的内容，不要编造。
- `publish`：默认 `false`；只有用户明确要求发布时才设为 `true`。

## 工作流程

1. 先读当前会话，识别主题、决策、行动项和概念。
2. 调用 `conversation_wiki`，`action: "record"`，填入上面的字段。
3. 如果用户要求发布，再调用 `action: "publish"`，或在同一次 record 中传 `publish: true`。
4. 把工具返回的本地路径和页面数告诉用户；不要声称“已发布”除非工具返回 `published: true`。

自动捕获开启时，插件会在每轮结束时保存原始转录；人工 `record` 的价值是补充结构化摘要。人工摘要不会被后续自动捕获覆盖。

## 本地结构

默认位置：

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

配置项：

- `autoCapture`：默认 `true`，每轮自动保存转录。
- `autoPublish`：默认 `false`；即使为 `true`，也必须 `feishu.enabled` 为 `true`。
- `captureSubagents`：默认 `false`。
- `includeToolMessages`：默认 `false`。
- `feishu.enabled`：默认 `false`。
- `feishu.origin`：租户地址，例如 `https://your-tenant.feishu.cn`。
- `feishu.space`：默认 `my_library`（个人文档库）。
- `feishu.rootTitle`：默认 `会话知识库`。

## 隐私

- 默认只写本地；不会因为执行 `record` 就上传。
- 发布目标是个人文档库，不要添加成员、不要开启公开分享。
- 插件会对 API Key、token、密码、私钥等做基础脱敏，但不能替代人工检查。
- 发布前确认会话中没有客户数据、密钥或个人信息。
- 不要打印 `lark-cli` 凭据、token 或完整配置。

## 飞书发布

发布依赖 `lark-cli` 已完成用户授权：

```bash
lark-cli auth status
```

首次发布会创建 `会话知识库` 根节点和 `会话记录 / 标签主题 / 概念主题` 三个分类；后续按内容哈希覆盖更新，不会重复追加。发布状态保存在 `.conversation-wiki/feishu-state.json`。

如果返回 `缺少 feishu.origin`，让用户填写租户地址；如果返回未启用，先确认用户是否真的希望上传。

## 失败处理

- 本地写入失败：报告具体路径和错误，不要静默重试。
- 飞书发布失败：保留本地记录；说明失败原因和已发布/未发布范围。
- 未配置飞书：明确告诉用户“只保存在本地”，不要暗示已经发布。
- 会话太长：`record` 会截断到配置上限；摘要仍应覆盖整体结论，不要只总结最后几条消息。

更多细节见 `references/record-schema.md`。
