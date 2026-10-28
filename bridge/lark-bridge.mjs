#!/usr/bin/env node
/**
 * PageStudy 飞书桥接服务
 *
 * 浏览器扩展运行在沙箱中，不能直接调用宿主机器的 MCP / lark-cli。
 * 这个服务只监听 127.0.0.1，复用当前用户已经登录的 lark-cli 创建飞书文档。
 * 不保存飞书 App Secret，也不允许任意命令执行。
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

const HOST = process.env.PAGE_STUDY_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.PAGE_STUDY_BRIDGE_PORT || 17373);
const TOKEN = process.env.PAGE_STUDY_BRIDGE_TOKEN || '';
const LARK_CLI = process.env.LARK_CLI || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
const MAX_BODY = 8 * 1024 * 1024;

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function originAllowed(origin) {
  if (!origin) return true;
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://localhost')
  );
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-pagestudy-token',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function authorized(req) {
  if (!TOKEN) return true;
  const provided = req.headers['x-pagestudy-token'];
  return typeof provided === 'string' && provided === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求内容超过 8MB 限制。'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function runLark(args, cwd) {
  return new Promise((resolve, reject) => {
    // Windows 的 npm 全局命令是 .cmd，直接 execFile 会报 EINVAL；
    // 这里交给 cmd.exe 解析，所有可变参数在进入本函数前都已做格式校验。
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(LARK_CLI);
    const child = spawn(LARK_CLI, args, {
      cwd,
      shell: useShell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 12 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(error.message));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error('lark-cli 执行超时（120 秒）。'));
        return;
      }
      if (code !== 0) {
        const parsed = parseJsonObject(stdout);
        const message =
          parsed?.error?.message ||
          parsed?.message ||
          stderr.trim() ||
          `lark-cli 退出码 ${code}`;
        reject(new Error(String(message).slice(0, 1200)));
        return;
      }
      resolve(stdout);
    });
  });
}

async function getLarkVersion() {
  try {
    const stdout = await runLark(['--version'], process.cwd());
    return { ok: true, version: stdout.trim().split(/\r?\n/)[0] || 'lark-cli' };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function validateParentToken(token) {
  if (!token) return '';
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) {
    throw new Error('父节点 token 格式不正确。');
  }
  return token;
}

function validateDocumentToken(token) {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) {
    throw new Error('文档 token 格式不正确。');
  }
  return token;
}

async function createDoc({ title, markdown, parentToken }) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new Error('Markdown 内容不能为空。');
  }
  if (markdown.length > 6 * 1024 * 1024) {
    throw new Error('Markdown 内容超过 6MB。');
  }
  const safeTitle = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const heading = safeTitle || 'PageStudy 学习记录';
  // 用传入标题替换 Markdown 的 H1，让飞书文档标题与学习记录标题一致；
  // 不把 title 作为 shell 参数传入，避免网页标题中的特殊字符影响命令。
  const content = /^#\s+/m.test(markdown)
    ? markdown.replace(/^#\s+.*$/m, `# ${heading}`)
    : `# ${heading}\n\n${markdown}`;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-feishu-'));
  try {
    await writeFile(path.join(dir, 'document.md'), content, 'utf8');
    const args = [
      'docs',
      '+create',
      '--doc-format',
      'markdown',
      '--content',
      '@document.md',
      '--as',
      'user',
    ];
    const parent = validateParentToken(parentToken);
    if (parent) args.push('--parent-token', parent);
    const stdout = await runLark(args, dir);
    const parsed = parseJsonObject(stdout);
    const document = parsed?.data?.document;
    if (!parsed?.ok || !document?.document_id) {
      throw new Error(parsed?.error?.message || '飞书 CLI 没有返回 document_id。');
    }
    return {
      ok: true,
      documentId: document.document_id,
      url: document.url || '',
      warnings: parsed?.data?.warnings ?? [],
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function appendDoc({ documentId, markdown }) {
  if (typeof markdown !== 'string' || !markdown.trim()) {
    throw new Error('Markdown 内容不能为空。');
  }
  const token = validateDocumentToken(documentId);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-feishu-'));
  try {
    await writeFile(path.join(dir, 'document.md'), markdown, 'utf8');
    const args = [
      'docs',
      '+update',
      '--doc',
      token,
      '--command',
      'append',
      '--doc-format',
      'markdown',
      '--content',
      '@document.md',
      '--as',
      'user',
    ];
    const stdout = await runLark(args, dir);
    const parsed = parseJsonObject(stdout);
    if (!parsed?.ok) {
      throw new Error(parsed?.error?.message || '飞书 CLI 追加失败。');
    }
    return { ok: true, documentId: token };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const headers = corsHeaders(req);

  if (!originAllowed(origin)) {
    sendJson(res, 403, { ok: false, error: '不接受该来源的请求。' }, headers);
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: '桥接 Token 不正确。' }, headers);
    return;
  }

  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      const version = await getLarkVersion();
      sendJson(
        res,
        200,
        {
          ok: true,
          larkCli: version.ok,
          version: version.version,
          error: version.error,
        },
        headers,
      );
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/api/feishu/docs') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error('请求体必须是 JSON。');
      }
      const result = await createDoc({
        title: body.title,
        markdown: body.markdown,
        parentToken: body.parentToken,
      });
      sendJson(res, 200, result, headers);
      return;
    }

    const appendMatch = requestUrl.pathname.match(/^\/api\/feishu\/docs\/([^/]+)\/append$/);
    if (req.method === 'POST' && appendMatch) {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error('请求体必须是 JSON。');
      }
      const result = await appendDoc({
        documentId: decodeURIComponent(appendMatch[1]),
        markdown: body.markdown,
      });
      sendJson(res, 200, result, headers);
      return;
    }

    sendJson(res, 404, { ok: false, error: '接口不存在。' }, headers);
  } catch (error) {
    sendJson(res, 502, { ok: false, error: String(error?.message || error) }, headers);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PageStudy 飞书桥接已启动：http://${HOST}:${PORT}`);
  console.log(`使用命令：${LARK_CLI}`);
  if (TOKEN) console.log('已启用 x-pagestudy-token 校验。');
  console.log('按 Ctrl+C 停止。');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
