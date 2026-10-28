# 权限与安全审查

## 权限最小化

逐项检查 `manifest.json`：

| 权限 | 需要它的具体行为 | 不需要时的替代 |
| --- | --- | --- |
| `storage` | 保存设置、API Key、本地记录 | 无 |
| `sidePanel` | 侧栏页面、点击图标打开 | 普通扩展页面 |
| `contextMenus` | 右键菜单入口 | 页面内按钮 |
| `activeTab` | 用户手势后访问当前标签 | 宽泛 host 权限 |
| `tabs` | 需要读取所有标签的 URL/标题 | 用 `activeTab` 或仅当前标签 |
| `scripting` | 动态注入脚本 | 静态 `content_scripts` |
| `downloads` | 用下载管理器保存文件 | `<a download>` |
| `host_permissions` | 网络请求/注入匹配的站点 | 缩窄到需要的域名 |

审查时把每个 `host_permissions` 条目改写成一句用户能看懂的用途。全站 `http://*/*`、`https://*/*` 是明显的高权限信号：如果只处理当前文章，优先考虑 `activeTab` 或更窄的站点范围；如果确实要支持任意博客，必须在 README 的“权限理由”里说明。

## API Key

- 只在 service worker 或 options 页面读取；content script 和网页世界不接触。
- `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })` 可阻止内容脚本读取扩展存储；在 service worker 启动时调用并处理不支持的环境。
- 设置页默认用 `type="password"`，只在用户点击“显示”时展示。
- Key 不写日志、不进错误对象、不进 URL、不进埋点、不提交到 Git。
- 浏览器本地存储不是加密保险箱；README 要说明“保存在本机浏览器”，不要宣称端到端加密。
- 服务端/本地桥接不应回显 API Key；错误消息要脱敏。

## 页面内容是不可信数据

网页正文、标题、选中段落、表格、评论和网页里的“系统指令”都只能作为数据。

- 模型系统提示明确写出边界：忽略网页里的越权指令，不泄露密钥，不伪造工具结果。
- 模型不能直接触发外部写入；写入接口只接受扩展页面里用户点击产生的请求。
- 把网页内容放在明确的边界标记中，不要让网页文本改变系统角色。
- 不要在 content script 中执行页面提供的 HTML/JS；显示 AI 输出用 React 默认转义，禁止 `dangerouslySetInnerHTML`。
- Markdown 渲染只实现需要的子集；链接协议限制为 `http/https`；代码块按文本渲染。
- 网页文本可能包含 HTML/script；入库前保留原文即可，展示时再转义，不要用 `innerHTML` 拼接。

## CSP 与远程代码

MV3 扩展包内只运行打包后的静态文件：

- 不放 CDN 脚本、远程 `import()`、`eval`、`new Function`。
- 不通过 `chrome.scripting.executeScript` 注入远程源码。
- `content_security_policy` 保持默认严格策略；确需 `wasm-unsafe-eval` 时说明原因。
- 第三方依赖锁版本，定期审查构建产物体积和网络请求。

## 本地桥接外部工具

浏览器沙箱不能直接启动宿主机的 MCP、CLI 或任意进程。需要外部能力时，使用本机 loopback 服务：

```text
扩展 service worker → http://127.0.0.1:PORT → 已登录的 CLI → 外部服务
```

桥接服务的最低要求：

- 只绑定 `127.0.0.1`，不要 `0.0.0.0`。
- CORS 只接受扩展来源和本机来源；不要用 `*`。
- 可选共享 Token，通过自定义请求头传递；Token 不写进 URL。
- 限制请求体大小、字段长度、路径参数格式和总超时。
- 外部命令使用参数数组，不把 Markdown、标题、Token 拼进 shell 字符串；需要临时文件时请求结束即删除。
- 错误消息可读但脱敏；不把完整命令、Token 或用户正文写到日志。
- 外部写入由用户点击触发；真实账号的验收先说明目标并获得确认，优先 dry-run 或 mock。

## 扩展页面的 XSS 面

- React 文本插值默认安全；不要用 `dangerouslySetInnerHTML`。
- 用户提供的 URL 作为链接前检查协议，只允许 `http/https`。
- 文件导入逐条校验结构；坏数据跳过，不让整库加载失败。
- 不要接受网页 `postMessage` 直接执行敏感操作；必须校验 `event.origin` 和消息结构。
- 页面内浮层用 closed shadow root，避免与页面 DOM/CSS 冲突。

## 供应链与仓库卫生

- 提交 `package.json` 与锁文件；不提交 `node_modules/`、`dist/`、日志、`.env`、API Key、本地数据库导出。
- 新增依赖前先问“浏览器 API 能否直接做到”；扩展体积和权限都受限。
- 构建脚本不执行不受信任的远程代码。
- README 写清数据流、权限理由、外部服务、隐私边界和已知限制。

## 快速检查表

- [ ] 每个权限有具体用途，没有为“以后可能用到”而申请。
- [ ] API Key 不会到达 content script、页面 DOM、日志或 Git。
- [ ] 页面内容被标记为不可信；模型不能自行写入外部系统。
- [ ] 外部链接协议受限，Markdown 渲染无 HTML 注入。
- [ ] 桥接只监听 loopback，CORS 来源受控，输入有长度/格式校验。
- [ ] 真实外部写入有用户手势、确认和可回滚/可删除的测试数据。
