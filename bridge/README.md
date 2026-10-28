# PageStudy 飞书桥接服务

浏览器扩展不能直接调用宿主机的 MCP 或 `lark-cli`，所以用一个只监听本机的 Node 服务做桥接：

```text
Chrome/Edge 扩展
  └─ 后台 Service Worker
       └─ http://127.0.0.1:17373
            └─ lark-cli docs +create / docs +update
                 └─ 飞书云文档
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

服务默认监听 `127.0.0.1:17373`。确认飞书 CLI 已登录：

```powershell
lark-cli auth status
```

## 可选环境变量

| 变量 | 说明 |
| --- | --- |
| `PAGE_STUDY_BRIDGE_PORT` | 监听端口，默认 `17373` |
| `PAGE_STUDY_BRIDGE_HOST` | 监听地址，默认 `127.0.0.1` |
| `PAGE_STUDY_BRIDGE_TOKEN` | 可选的共享 Token；设置后扩展请求必须带 `x-pagestudy-token` |
| `LARK_CLI` | 自定义 CLI 命令路径，默认 Windows 使用 `lark-cli.cmd` |

示例：

```powershell
$env:PAGE_STUDY_BRIDGE_TOKEN = "请换成一个随机字符串"
$env:PAGE_STUDY_BRIDGE_PORT = "17373"
npm run bridge
```

然后在扩展设置页填写同一个桥接地址和 Token。Token 不要提交到代码仓库。

## 接口

### `GET /health`

检查服务和 CLI 是否可用：

```json
{ "ok": true, "larkCli": true, "version": "lark-cli version 1.0.94" }
```

### `POST /api/feishu/docs`

创建新文档：

```json
{
  "title": "学习记录 · 文章标题 · 10/28",
  "markdown": "# 文章标题\n\n...",
  "parentToken": "可选：文件夹 token 或知识库节点 token"
}
```

返回：

```json
{
  "ok": true,
  "documentId": "docx_token",
  "url": "https://xxx.feishu.cn/docx/docx_token"
}
```

### `POST /api/feishu/docs/:documentId/append`

在文档末尾追加 Markdown：

```json
{ "markdown": "## 追加更新\n\n..." }
```

扩展当前在“追加到飞书”按钮中使用这个接口。

## 安全边界

- 服务只绑定本机回环地址，不接受任意来源的 CORS 请求。
- 不把网页内容或用户标题拼进 shell 命令；正文写入临时文件，通过 `@file` 传给 CLI。
- 父节点 token、文档 token 会做字符格式校验。
- 写入动作必须由扩展侧用户点击触发，模型不能自行发布。
- 临时 Markdown 文件在请求结束后删除。
