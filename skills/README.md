# Agent Skills

本目录存放可复用的 Agent Skill，目前包含：

## browser-extension

构建、调试、审查或发布 Chrome/Edge Manifest V3 浏览器扩展。覆盖扩展面拆分、Vite 构建、side panel、content script、消息/存储、模型密钥、本地桥接和真实浏览器验收。

文件：

```text
browser-extension/
  SKILL.md
  references/
    mv3-runtime.md
    vite-scaffold.md
    security-review.md
    verification.md
```

安装到用户全局 Skill 目录（Windows）：

```powershell
$target = "$env:USERPROFILE\.agents\skills\browser-extension"
New-Item -ItemType Directory -Force $target | Out-Null
Copy-Item -Recurse -Force .\skills\browser-extension\* $target
```

安装后重启 Agent 会话，让 Skill 目录重新扫描。仓库中的 `skills/browser-extension/` 是源文件；全局目录是运行副本，修改后重新复制。
