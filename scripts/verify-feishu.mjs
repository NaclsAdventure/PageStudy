/**
 * 飞书 XML 桥接验证。
 *
 * 用临时目录里的假 lark-cli 启动真实桥接，验证：
 * 1. 扩展传入的 xml 会以 --doc-format xml 写入；
 * 2. 图片保留远程 http(s) 地址，交给 lark-cli 上传；
 * 3. 本地文件引用会被桥接拒绝；
 * 4. 追加请求走 append + xml。
 * 不访问真实飞书，不需要 lark-cli 登录。
 */
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-feishu-'));
const mockDir = path.join(root, 'mock-lark');
const runDir = path.join(mockDir, 'node_modules', '@larksuite', 'cli', 'scripts');
const logPath = path.join(root, 'lark-calls.jsonl');
const bridgePort = 17376;
const bridgePath = path.resolve(import.meta.dirname, '..', 'bridge', 'lark-bridge.mjs');

await mkdir(runDir, { recursive: true });
await writeFile(path.join(mockDir, 'lark-cli.cmd'), '@echo off\r\n', 'utf8');
await writeFile(
  path.join(runDir, 'run.js'),
  `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_LARK_LOG, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args.includes('--version')) {
  console.log('mock-lark 1.0.0');
  process.exit(0);
}
const contentIndex = args.indexOf('--content');
const formatIndex = args.indexOf('--doc-format');
const contentArg = contentIndex >= 0 ? args[contentIndex + 1] : '';
const format = formatIndex >= 0 ? args[formatIndex + 1] : 'xml';
if (!contentArg || !contentArg.startsWith('@')) {
  console.log(JSON.stringify({ ok: false, error: { message: 'missing @content' } }));
  process.exit(1);
}
const content = fs.readFileSync(path.resolve(process.cwd(), contentArg.slice(1)), 'utf8');
const isCreate = args.includes('+create');
const isAppend = args.includes('+update') && args.includes('append');
if (!isCreate && !isAppend) {
  console.log(JSON.stringify({ ok: false, error: { message: 'unexpected command' } }));
  process.exit(1);
}
if (format === 'xml') {
  if (isCreate && !/<title>[\\s\\S]*?<\\/title>/i.test(content)) {
    console.log(JSON.stringify({ ok: false, error: { message: 'missing title' } }));
    process.exit(1);
  }
  const images = content.match(/<img\\b[^>]*>/gi) || [];
  for (const image of images) {
    if (!/\\bhref\\s*=\\s*"https?:\\/\\//i.test(image)) {
      console.log(JSON.stringify({ ok: false, error: { message: 'bad image' } }));
      process.exit(1);
    }
  }
}
fs.appendFileSync(process.env.MOCK_LARK_LOG + '.content', JSON.stringify({ format, content }) + '\\n');
if (isCreate) {
  console.log(JSON.stringify({
    ok: true,
    data: {
      document: { document_id: 'docx_mock_create', url: 'https://feishu.example/docx/mock' },
      warnings: [],
    },
  }));
} else {
  console.log(JSON.stringify({ ok: true, data: { warnings: [] }, result: 'success' }));
}
`,
  'utf8',
);

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    PAGE_STUDY_BRIDGE_PORT: String(bridgePort),
    LARK_CLI: path.join(mockDir, 'lark-cli.cmd'),
    MOCK_LARK_LOG: logPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
bridge.stdout.on('data', (chunk) => {
  logs += chunk.toString();
});
bridge.stderr.on('data', (chunk) => {
  logs += chunk.toString();
});

async function waitForBridge() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`);
      if (response.ok) return response.json();
    } catch {
      // 等桥接启动
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`桥接未启动：${logs}`);
}

async function post(pathname, body) {
  const response = await fetch(`http://127.0.0.1:${bridgePort}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const fail = async (error) => {
  console.error(error);
  console.error(logs);
  bridge.kill();
  await rm(root, { recursive: true, force: true });
  process.exit(1);
};

try {
  const health = await waitForBridge();
  assert.equal(health.ok, true);
  assert.equal(health.larkCli, true);

  const xml = [
    '<title>学习记录 · XML 桥接测试</title>',
    '<callout emoji="📚" background-color="light-blue"><p>来源：<a href="https://example.com/post?a=1&amp;b=2">原文</a></p></callout>',
    '<h2>30 秒速读</h2>',
    '<p>正文 &amp; 结论。</p>',
    '<img href="https://example.com/diagram.png?a=1&amp;b=2" caption="图 1：流程图"/>',
  ].join('\n');
  const created = await post('/api/feishu/docs', {
    title: '学习记录 · XML 桥接测试',
    markdown: '# 不应使用的 Markdown 降级内容',
    xml,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.documentId, 'docx_mock_create');

  const callLines = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const createCall = callLines.find((line) => line.args.includes('+create'));
  assert.ok(createCall, '没有调用 docs +create');
  assert.equal(createCall.args[createCall.args.indexOf('--doc-format') + 1], 'xml');
  const contents = (await readFile(`${logPath}.content`, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(contents.some((entry) => entry.format === 'xml' && entry.content.includes('<img href="https://example.com/diagram.png?a=1&amp;b=2" caption="图 1：流程图"/>')));
  assert.ok(!contents.some((entry) => entry.content.includes('不应使用的 Markdown')));

  const appended = await post('/api/feishu/docs/docx_mock_create/append', {
    markdown: '## 旧 Markdown',
    xml: '<h2>追加更新</h2><p>新的理解。</p>',
  });
  assert.equal(appended.status, 200);
  assert.equal(appended.body.ok, true);

  const fallback = await post('/api/feishu/docs', {
    title: 'Markdown 兼容测试',
    markdown: '# 文章标题\n\n正文',
  });
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.ok, true);
  const fallbackContents = (await readFile(`${logPath}.content`, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(fallbackContents.some((entry) => entry.format === 'markdown' && entry.content.includes('# Markdown 兼容测试')));

  const bad = await post('/api/feishu/docs', {
    title: '本地文件测试',
    xml: '<title>本地文件测试</title><img path="@./secret.txt"/>',
  });
  assert.equal(bad.status, 502);
  assert.equal(bad.body.ok, false);
  assert.match(bad.body.error, /本地资源引用|远程 http/);

  console.log('飞书 XML 桥接验证通过：create/append 使用 xml，图片保留远程地址，本地文件引用被拒绝。');
} catch (error) {
  await fail(error);
  process.exitCode = 1;
} finally {
  bridge.kill();
  await rm(root, { recursive: true, force: true });
}
