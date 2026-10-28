/**
 * 桥接端到端验证：启动一个假的 Notion API，并让真实桥接进程写入它。
 * 该脚本不需要真实 Notion Token，也不访问外网。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const bridgeDir = path.resolve(import.meta.dirname, '..');
const bridgePath = path.join(bridgeDir, 'bridge', 'lark-bridge.mjs');
const notesDir = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-notes-'));
const mockPort = 18080;
const bridgePort = 17374;
const pageId = '1234567890abcdef1234567890abcdef';
const createdId = 'abcdef1234567890abcdef1234567890';
const requests = [];
let createdPage = null;
let appended = 0;

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const body = bodyText ? JSON.parse(bodyText) : {};
  requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  };

  if (req.method === 'POST' && req.url === '/v1/pages') {
    assert.equal(req.headers.authorization, 'Bearer secret_test');
    assert.equal(body.parent.page_id, pageId);
    assert.ok(body.properties.title.title[0].text.content);
    createdPage = { id: createdId, url: 'https://notion.example/mock-page-123', body };
    send(200, createdPage);
    return;
  }
  if (req.method === 'PATCH' && req.url === `/v1/blocks/${createdId}/children`) {
    appended += 1;
    send(200, { object: 'list', results: [] });
    return;
  }
  send(404, { message: 'mock route not found' });
});

await new Promise((resolve) => mock.listen(mockPort, '127.0.0.1', resolve));

const bridge = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    PAGE_STUDY_BRIDGE_PORT: String(bridgePort),
    LARK_CLI: 'nonexistent-lark-cli-for-test',
    NOTION_TOKEN: 'secret_test',
    NOTION_API_BASE: `http://127.0.0.1:${mockPort}/v1`,
    NOTION_PARENT_PAGE_ID: pageId,
    PAGESTUDY_MARKDOWN_DIR: notesDir,
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

const fail = async (error) => {
  console.error(error);
  console.error(logs);
  bridge.kill();
  mock.close();
  await rm(notesDir, { recursive: true, force: true });
  process.exit(1);
};

try {
  const health = await waitForBridge();
  assert.equal(health.notion, true);
  assert.equal(health.markdown, true);
  assert.equal(health.markdownDir, notesDir);

  const notionCreate = await fetch(`http://127.0.0.1:${bridgePort}/api/notion/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: '端到端测试',
      parentPageId: pageId,
      markdown: '# 端到端测试\n\n## 要点\n\n- 第一条\n- 第二条\n\n> 引用\n',
    }),
  });
  const created = await notionCreate.json();
  assert.equal(created.ok, true);
  assert.equal(created.documentId, createdId);
  assert.equal(created.url, 'https://notion.example/mock-page-123');
  assert.equal(createdPage.body.children[0].type, 'heading_2');

  const notionAppend = await fetch(
    `http://127.0.0.1:${bridgePort}/api/notion/pages/${createdId}/append`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown: '追加段落\n' }),
    },
  );
  const appendedResult = await notionAppend.json();
  assert.equal(appendedResult.ok, true);
  assert.equal(appended, 1);

  const markdownCreate = await fetch(`http://127.0.0.1:${bridgePort}/api/markdown/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '本地笔记', markdown: '# 本地笔记\n\n正文' }),
  });
  const note = await markdownCreate.json();
  assert.equal(note.ok, true);
  assert.ok(note.documentId.endsWith('.md'));
  const firstContent = await readFile(path.join(notesDir, note.documentId), 'utf8');
  assert.match(firstContent, /正文/);

  const markdownAppend = await fetch(`http://127.0.0.1:${bridgePort}/api/markdown/notes/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: '..\\..\\evil.md', markdown: '越权' }),
  });
  assert.equal(markdownAppend.status, 502);
  const evilResult = await markdownAppend.json();
  assert.equal(evilResult.ok, false);

  const validAppend = await fetch(`http://127.0.0.1:${bridgePort}/api/markdown/notes/append`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId: note.documentId, markdown: '追加内容' }),
  });
  assert.equal(validAppend.status, 200);
  assert.match(await readFile(path.join(notesDir, note.documentId), 'utf8'), /追加内容/);

  console.log('桥接验证通过：Notion 创建/追加、Markdown 创建/追加、路径越权拦截。');
  console.log(`Notion 请求数：${requests.length}；Markdown 目录：${notesDir}`);
} catch (error) {
  await fail(error);
  process.exitCode = 1;
} finally {
  bridge.kill();
  mock.close();
  await rm(notesDir, { recursive: true, force: true });
}
