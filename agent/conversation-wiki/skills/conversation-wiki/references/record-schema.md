# Conversation Wiki 记录格式

本地记录是事实来源；`sessions/*.md`、`topics/*.md`、`concepts/*.md` 都由记录派生。

## 记录文件

位置：

```text
~/.conversation-wiki/vault/.conversation-wiki/records/<id>.json
```

示例：

```json
{
  "version": 1,
  "id": "pi-20261028-120000",
  "title": "会话知识库插件设计",
  "overview": "把 Pi/DSH 会话转换为本地 Markdown Wiki，并保留可选的飞书发布。",
  "createdAt": 1793190000000,
  "updatedAt": 1793190500000,
  "enriched": true,
  "source": {
    "agent": "dsh",
    "sessionId": "pi-20261028-120000",
    "sessionFile": "",
    "model": "deepseek-v4.1-flash",
    "cwd": "D:\\work\\project"
  },
  "messages": [
    { "role": "user", "text": "我想把会话整理成知识库。", "timestamp": 1793190000000 },
    { "role": "assistant", "text": "可以先落成本地 Markdown。", "timestamp": 1793190001000 }
  ],
  "transcript": {
    "truncated": false,
    "originalCount": 2,
    "charCount": 26
  },
  "sections": [
    {
      "title": "目标",
      "summary": "把对话变成可回看的知识资产。",
      "keyPoints": ["本地优先", "发布可选"]
    }
  ],
  "decisions": ["共享核心，Pi/DSH 各自提供入口"],
  "actionItems": ["补充发布重试"],
  "openQuestions": ["是否支持英文标题"],
  "tags": ["知识管理", "Pi"],
  "concepts": [
    { "term": "会话知识库", "explanation": "从会话派生出的结构化 Wiki。" }
  ],
  "notes": "用户强调默认不上传。"
}
```

## 字段约束

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `id` | string | 稳定标识；默认取会话 ID，只保留字母、数字、`.`、`_`、`-` |
| `title` | string | 200 字符内；不要为空 |
| `overview` | string | 1200 字符内 |
| `messages` | array | 每项 `{role, text, timestamp?}`；`role` 为 `user/assistant/tool/system` |
| `sections` | array | 最多 50 节；每节 `title`、`summary`、`keyPoints[]` |
| `decisions` | string[] | 最多 30 条，每条 500 字符内 |
| `actionItems` | string[] | 最多 30 条 |
| `openQuestions` | string[] | 最多 30 条 |
| `tags` | string[] | 最多 40 个，每个 80 字符内 |
| `concepts` | array | 最多 80 个；`{term, explanation}` |
| `notes` | string | 6000 字符内 |

## 合并规则

- 自动捕获只更新 `messages`、`transcript` 和 `source`。
- 如果记录尚未 `enriched`，自动捕获可以替换标题和概览。
- 如果已经 `enriched`，自动捕获不会覆盖 `title/overview/sections/decisions/actionItems/openQuestions/tags/concepts/notes`。
- `record` 工具会设置 `enriched: true`；再次 `record` 时只覆盖显式传入的字段。

## 页面与 ID

- 会话页：`session:<recordId>` → `sessions/<slug>-<hash>.md`
- 标签页：`tag:<slug>-<hash>` → `topics/<slug>-<hash>.md`
- 概念页：`concept:<slug>-<hash>` → `concepts/<slug>-<hash>.md`
- 根页：`__root__` → `index.md`
- 分类页：`category:records|tags|concepts` → 对应目录的 `index.md`

Markdown 内部链接先写成 `{{cw:<pageId>}}`，本地落盘时替换为相对路径，发布飞书时替换为 Wiki URL。

## 脱敏

保存前会处理常见的：

- `sk-...`、`Bearer ...`、`Authorization: ...`
- 私钥块
- GitHub / Slack token
- 长 base64 形态的疑似密钥

脱敏只做基础防护，不能替代发布前的人工检查。
