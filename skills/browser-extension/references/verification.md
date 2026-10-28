# 验收、排错与发布

## 必跑命令

```powershell
npm run typecheck
npm test
npm run build
```

三条都通过，只能证明代码可编译、单测通过、打包成功；不能证明扩展能加载或 API 可用。

## 单测优先级

优先覆盖纯逻辑，避免为了测试启动浏览器：

- 正文/大纲抽取：article 优先、导航排除、无标题回退、锚点稳定。
- 选区上下文：文本归一化、标题路径、空选区。
- provider 请求体：鉴权头、Base URL 归一化、reasoning 字段、推理模型不发 `temperature`。
- 摘要归一化：严格匹配 `outlineId` 或标题；幻觉段落丢弃；缺失节点补空。
- Markdown 导出/追加：标题层级、空记录、标签、选区、对话。
- 设置归一化：缺字段、非法 URL、旧版本迁移。
- IndexedDB：put/get/list/find by URL/导入校验（用假 IndexedDB 或 jsdom 环境）。

不要单测真实付费模型；用 mock HTTP/SSE 响应验证解析和错误映射。

## 真实浏览器验收

1. `npm run build`。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开发者模式加载 `dist`。
3. 打开真实博客页面，确认内容脚本注入。
4. 打开侧栏：大纲、标题数、字数、选择 Skill、选区加入上下文。
5. 发送问题：首字流式出现，停止按钮能中止，刷新后记录仍在。
6. 记录本页：保存 URL、大纲、选区、对话；生成总结后大纲树出现逐节摘要。
7. 打开记录库：搜索、标签、笔记、复制/下载 Markdown。
8. 设置页：保存、模型列表/连接测试、桥接 health。
9. 重新构建并刷新扩展，重复最关键的一条路径，排除旧 bundle。

**完成标准**：每一步都能在 headed 浏览器中复现；控制台没有未解释的错误；真实外部副作用（如果有）单独记录。

## 自动化边界

扩展自动化比普通网页脆弱，浏览器版本和品牌差异很大：

- 使用 Playwright `launchPersistentContext` 时，默认参数会禁用扩展；需要 `ignoreDefaultArgs: ['--disable-extensions']` 并显式传 `--load-extension=<dist>`。
- 自动化优先跑 **headed** 模式；headless 在不少 Chromium 版本不加载扩展，不能据此判断扩展有问题。
- 某些 Chrome 品牌版本会限制命令行 `--load-extension`；Edge/Chromium/Chrome for Testing 可能可用。手动加载始终是最终基准。
- 不要在无头环境里断言 service worker 一定存在；先等 `serviceworker` 事件并设超时。
- 侧栏在真实浏览器中是 side panel，不是标签页。把 `sidepanel.html` 当标签打开时，它会把自己当成活动页，从而读不到文章；验收要区分这两种模式。
- 截图只能证明布局，不证明权限、存储和外部写入；关键路径要读回数据或调用接口验证。

## 本地桥接验收

```powershell
npm run bridge

# 另一个终端
Invoke-RestMethod http://127.0.0.1:17373/health
```

期望至少包含 `ok: true` 和 `larkCli: true`。

顺序：

1. 用 mock CLI 或 mock HTTP 验证创建/追加的参数和返回。
2. 对真实 CLI 做 dry-run，确认鉴权、目标 token、参数格式。
3. 真实写入前向用户说明目标（文档标题、位置、内容范围）并取得确认。
4. 创建后回读文档，确认标题、正文、追加段都存在。
5. 测试结束停止桥接，清理临时文件；测试文档是否删除由用户决定。

扩展端要验证：桥接未启动时给出可读错误；写入成功把文档 URL/ID 持久化；再次点击走追加；写入失败不破坏原记录。

## 常见故障表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 扩展加载后侧栏空白 | HTML 未打进 dist / 入口路径错误 | 检查 Vite input 与 manifest |
| content script 不运行 | matches 不包含当前 URL；扩展刚刷新 | 刷新网页，重新加载扩展 |
| `Receiving end does not exist` | 页面没有 content script | 检查 URL、权限、注入时机 |
| service worker 状态丢失 | 内存变量被回收 | 写入 storage/IDB；事件驱动恢复 |
| 流式回答不动 | SSE 事件分隔/解析错误；端口断开 | 检查空行、`[DONE]`、端口生命周期 |
| 模型 400 参数错误 | 推理模型不接受 `temperature` 等字段 | 按模型能力裁剪请求体 |
| 点击侧栏没反应 | 低于 Chromium 116；无用户手势 | 提高最低版本，检查 `open()` 调用链 |
| 桥接 401/403 | Token 不一致；CORS 来源被拒 | 对齐环境变量；检查 Origin 规则 |
| Windows 下 CLI `EINVAL` | 直接 `execFile` 执行 `.cmd` | 用 `spawn` + shell，或直接调用底层 JS |
| 构建后仍是旧界面 | 没刷新扩展/浏览器缓存 | 重新构建并在扩展页点刷新 |

## 发布检查

- [ ] `manifest.json` 和 `package.json` 版本一致。
- [ ] 最低浏览器版本与使用的 API 一致（侧栏打开行为按 116+）。
- [ ] 权限逐项有 README 说明；无未使用权限。
- [ ] 无 API Key、真实用户数据、日志、本地绝对路径。
- [ ] 图标齐全；名称/描述/截图与功能一致。
- [ ] `npm run typecheck && npm test && npm run build` 通过。
- [ ] dist 在干净浏览器配置中加载成功。
- [ ] 压缩包根目录直接是 `manifest.json`（不要再套一层 dist）。
- [ ] 商店隐私说明覆盖：收集哪些页面内容、发送给谁、保存多久、如何删除。
- [ ] 已知限制和外部依赖（如本地桥接）写清楚。
