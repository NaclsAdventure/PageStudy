# MV3 运行时手册

## 四个隔离的执行环境

| 环境 | 能做什么 | 不能假设什么 |
| --- | --- | --- |
| content script | 读写当前页面 DOM、转发选区 | 不能访问扩展页面 DOM，不能把密钥给页面 |
| service worker | 路由消息、发网络请求、访问扩展 API | 随时可能被回收；没有 DOM；内存状态不可靠 |
| side panel / options | React 界面、IndexedDB、`chrome.*` | 不是网页上下文；活动标签页不一定仍是打开时的那个 |
| 页面主世界 | 原网页脚本 | 看不到 content script 的隔离变量 |

## Service worker 生命周期

- 顶层同步注册所有事件监听器；异步工作放到事件回调内。
- 不把“当前选中段落”“待处理任务”只放在模块变量里。需要跨唤醒时写入 `chrome.storage.session/local` 或 IndexedDB。
- 长时间流式生成要有 `AbortController`，并在端口断开时中止该端口所属请求。
- `onInstalled` 里做幂等初始化：`removeAll()` 后重建右键菜单、设置默认设置、创建数据库升级。

```ts
chrome.runtime.onInstalled.addListener(() => {
  void setupSidePanel();
  void setupContextMenu();
});
```

## Side Panel

- `side_panel.default_path` 指向构建后的 HTML。
- 点击扩展图标打开侧栏：

```ts
await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
```

- 从右键菜单或代码打开：

```ts
await chrome.sidePanel.open({ tabId });
```

`open()` 和 `setPanelBehavior()` 需要 Chromium 116+。把最低版本写进 manifest，并给不支持的环境一个 action 点击兜底。

侧栏读取当前页时：

```ts
const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
if (!tab?.id || !/^https?:\/\//.test(tab.url ?? '')) {
  throw new Error('请在普通网页中使用扩展。');
}
```

同时监听 `tabs.onActivated` 和 `tabs.onUpdated`。用递增序号或 `AbortController` 丢弃过期请求，避免用户快速切换标签时旧网页覆盖新网页。

## Content script

- 用 `run_at: "document_idle"`，等 DOM 基本稳定；对 SPA 再配合 `MutationObserver` 防抖重扫。
- 只注入一次：入口用 `window.__MY_EXTENSION_LOADED__` 保护，避免重新加载扩展后重复挂 UI。
- 页面内 UI 用 **closed shadow root**，样式不污染页面，也不被页面 CSS 污染。
- 给标题/段落写入唯一属性（如 `data-ext-anchor`）便于回跳；不要依赖易变的 nth-child 路径。
- 选区读取 `window.getSelection()` 后做 `normalizeWhitespace`，保留 `anchorNode` 所在的标题路径和段落文本。

正文抽取的稳健顺序：

1. `article`、`[role="article"]`、`main`；
2. 可见文本量最大的候选容器；
3. `body` 回退。

排除 `nav`、`aside`、`footer`、`[role="navigation"]`、评论区、广告、目录、分享按钮、`[aria-hidden="true"]` 和扩展自己的 UI。每节截断原文，整页设总上限，避免一次请求把上下文撑爆。

## 消息模型

### 一次性消息

```ts
type Request =
  | { type: 'GET_PAGE_CONTEXT' }
  | { type: 'SUMMARIZE'; request: SummaryRequest };

chrome.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
  void (async () => {
    try {
      sendResponse({ ok: true, data: await handle(message, sender) });
    } catch (error) {
      sendResponse({ ok: false, error: toMessage(error) });
    }
  })();
  return true; // 异步响应必须返回 true
});
```

- 请求和响应都使用可辨识联合类型。
- 校验 `sender.tab` / `sender.url`，不要接受任意页面伪造的敏感操作。
- 响应尽量是 `{ ok, data?, error? }`，不要同时有多个 `ok` 字段。

### 流式连接

```ts
const port = chrome.runtime.connect({ name: 'chat' });
port.postMessage({ type: 'chat.start', payload });
```

- 每个请求生成 `requestId`；事件统一带 `requestId`。
- 每个端口维护自己的活动请求集合；`port.onDisconnect` 只中止本端口请求。
- 处理 `delta`、`done`、`error`、`abort` 四种事件；用户停止后保留已生成的部分内容。
- 端口断开后忽略 `postMessage` 异常。

## 存储

### `chrome.storage.local`

适合设置、API Key、开关、小型缓存：

```ts
await chrome.storage.local.set({ 'myext.settings.v1': settings });
```

- 设置对象带版本号；读取时做归一化，兼容旧字段。
- 对 API Key 使用 `setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`，让内容脚本读不到扩展存储。
- 不要用 `storage.sync` 存密钥；同步范围通常比用户预期大。

### IndexedDB

适合学习记录、历史列表、大文本。使用 `idb` 时明确 schema、keyPath 和索引：

```ts
const db = await openDB('myext', 1, {
  upgrade(db) {
    const store = db.createObjectStore('records', { keyPath: 'id' });
    store.createIndex('by-updated', 'updatedAt');
    store.createIndex('by-url', 'page.url');
  },
});
```

读取列表时在应用层排序；导入数据时逐条校验 `id`、`page.url`、大纲数组等必要字段，坏记录跳过而不是让整个库崩掉。

## SSE 流式请求

```ts
const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
  body: JSON.stringify(body),
  signal,
});
if (!response.ok) throw new Error(await readError(response));
if (!response.body) throw new Error('没有可读取的流式响应。');

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let dataLines: string[] = [];

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') {
      if (dataLines.length) {
        const data = dataLines.join('\n');
        dataLines = [];
        if (data !== '[DONE]') onData(data);
      }
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
}
```

按 provider 解析不同事件：OpenAI `choices[0].delta.content`、Anthropic `content_block_delta.delta.text`、Gemini `candidates[0].content.parts[].text`。兼容接口可能发心跳或非 JSON 行，跳过而不是让整个生成失败。

## 模型适配

把 provider 差异集中在 `src/background/providers.ts` 一类模块：

- Base URL 去掉尾部斜杠，允许用户填到 `/v1` 或完整 `/chat/completions`。
- OpenAI 兼容：`Authorization: Bearer`；`reasoning_effort` 只给支持的模型；o1/o3 和 reasoner 类模型不要发送 `temperature`。
- Anthropic：`x-api-key`、`anthropic-version`；thinking 预算计入 `max_tokens`。
- Gemini：`x-goog-api-key`；模型名去掉 `models/` 前缀；`thinkingConfig` 放在 `generationConfig`。
- 对 401/403/404/429/5xx 给不同中文提示，不要把原始 Key 写进错误。

## 常见故障

| 现象 | 先查 |
| --- | --- |
| `Could not establish connection` | content script 是否注入；扩展是否刚刷新；URL 是否匹配 |
| 侧栏打开自己的页面当成网页 | 测试时把 sidepanel 当标签；真实侧栏不是标签页，改用心跳/激活标签处理 |
| 服务 worker 一会儿就失效 | 把状态只存在模块变量；改存 storage/IDB |
| 流式一直不结束 | SSE 事件没有空行分隔；`[DONE]` 未处理；端口被回收 |
| 构建后扩展白屏 | HTML 入口未纳入 Vite input；asset 路径错误 |
| 侧栏按钮无反应 | 最低版本低于 116；`open()` 不在用户手势里 |
