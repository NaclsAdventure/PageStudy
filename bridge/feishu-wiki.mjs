/**
 * 飞书个人文档库 Wiki 发布器。
 *
 * 只由本地桥接调用；所有 lark-cli 参数都通过 argv 数组传入，不拼接 shell 命令。
 * 首次发布创建“PageStudy Wiki”根节点、三个分类节点和每个 Wiki 页面对应的 docx；
 * 之后按内容哈希覆盖更新，避免重复追加。
 */
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

const MAX_PAGES = 60;
const MAX_MARKDOWN = 300_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,200}$/;
const PAGE_ID_RE = /^[\p{L}\p{N}:_-]{1,240}$/u;
const CATEGORY_KEYS = ['records', 'tags', 'concepts'];

function asString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text) {
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

function safeTitle(value, fallback) {
  const title = asString(value, fallback).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
  return title || fallback;
}

function validateToken(value, label) {
  const token = asString(value);
  if (!TOKEN_RE.test(token)) throw new Error(`${label}格式不正确。`);
  return token;
}

function validatePageId(value) {
  const id = asString(value);
  if (!PAGE_ID_RE.test(id)) throw new Error('Wiki 页面 ID 格式不正确。');
  return id;
}

function validateNodeRef(raw) {
  if (!isRecord(raw)) return null;
  const nodeToken = asString(raw.nodeToken);
  const objToken = asString(raw.objToken);
  const url = asString(raw.url);
  if (!TOKEN_RE.test(nodeToken) || !TOKEN_RE.test(objToken)) return null;
  if (url && !/^https?:\/\//i.test(url)) return null;
  return { nodeToken, objToken, url };
}

function originFromUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function wikiUrl(nodeToken, origin) {
  return origin ? `${origin.replace(/\/$/, '')}/wiki/${nodeToken}` : '';
}

function normalizeRef(node, origin) {
  const nodeToken = asString(node.node_token);
  const objToken = asString(node.obj_token);
  const url = asString(node.url) || wikiUrl(nodeToken, origin);
  if (!nodeToken || !objToken || !url) return null;
  return { nodeToken, objToken, url };
}

function normalizeState(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.target !== 'feishu') return null;
  const spaceId = asString(raw.spaceId);
  const root = validateNodeRef(raw.root);
  if (!spaceId || !root) return null;
  const categories = {};
  if (isRecord(raw.categories)) {
    for (const key of CATEGORY_KEYS) {
      const node = validateNodeRef(raw.categories[key]);
      if (node) {
        categories[key] = {
          ...node,
          title: asString(raw.categories[key].title),
          hash: asString(raw.categories[key].hash),
        };
      }
    }
  }
  const pages = {};
  if (isRecord(raw.pages)) {
    for (const [id, value] of Object.entries(raw.pages)) {
      const node = validateNodeRef(value);
      if (!node || !PAGE_ID_RE.test(id) || !isRecord(value)) continue;
      const kind = asString(value.kind);
      if (kind !== 'note' && kind !== 'tag' && kind !== 'concept') continue;
      pages[id] = {
        ...node,
        pageId: asString(value.pageId) || id,
        title: asString(value.title),
        kind,
        hash: asString(value.hash),
      };
    }
  }
  return {
    schemaVersion: 1,
    target: 'feishu',
    spaceId,
    root: {
      ...root,
      title: asString(raw.root.title) || 'PageStudy Wiki',
      hash: asString(raw.root.hash),
    },
    categories,
    pages,
  };
}

function replaceLinks(markdown, urls) {
  return markdown.replace(/\{\{pagestudy:([^}]+)\}\}/g, (_match, pageId) => urls.get(pageId) || '#');
}

function makeState(spaceId, root, categories, pages) {
  return {
    schemaVersion: 1,
    target: 'feishu',
    spaceId,
    root,
    categories,
    pages,
    lastPublishedAt: Date.now(),
  };
}

/**
 * @param {object} options
 * @param {(args: string[], cwd: string) => Promise<string>} options.runLark
 * @param {object} options.payload
 * @param {string} [options.webOrigin]
 */
export async function publishWiki({ runLark, payload, webOrigin = '' }) {
  if (!isRecord(payload)) throw new Error('Wiki 发布参数必须是对象。');
  const rootInput = isRecord(payload.root) ? payload.root : {};
  if (!isRecord(payload.root) || typeof rootInput.markdown !== 'string') {
    throw new Error('缺少 Wiki 首页内容。');
  }
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.pages)) {
    throw new Error('Wiki 分类或页面清单格式不正确。');
  }
  if (payload.pages.length > MAX_PAGES) {
    throw new Error(`一次最多发布 ${MAX_PAGES} 个页面，请减少记录数量后重试。`);
  }

  let origin = asString(webOrigin);
  const previous = normalizeState(payload.state);
  if (!origin && previous?.root?.url) origin = originFromUrl(previous.root.url);
  let spaceId = previous?.spaceId || '';

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-wiki-'));
  let fileIndex = 0;
  const categoryRefs = previous ? { ...previous.categories } : {};
  const previousPages = previous?.pages ?? {};
  // 只保留本次清单中的页面，避免本地删除记录后旧映射一直留在状态里。
  const pageRefs = {};
  let rootRef = previous?.root ?? null;
  let created = 0;
  let updated = 0;
  let skipped = 0;

  const larkJson = async (args) => {
    const stdout = await runLark(args, tempDir);
    const parsed = parseJson(stdout);
    if (!parsed?.ok) {
      throw new Error(parsed?.error?.message || 'lark-cli 没有返回成功结果。');
    }
    return parsed.data;
  };

  const writeMarkdown = async (markdown) => {
    fileIndex += 1;
    const name = `page-${fileIndex}.md`;
    await writeFile(path.join(tempDir, name), markdown, 'utf8');
    return name;
  };

  const updateDoc = async (objToken, markdown) => {
    const content = markdown.trim() || '（暂无内容）';
    const name = await writeMarkdown(content);
    const data = await larkJson([
      'docs',
      '+update',
      '--doc',
      validateToken(objToken, '文档 token'),
      '--command',
      'overwrite',
      '--doc-format',
      'markdown',
      '--content',
      `@${name}`,
      '--as',
      'user',
      '--format',
      'json',
    ]);
    const url = asString(data?.document?.url);
    if (url && !origin) origin = originFromUrl(url);
    return url;
  };

  const createNode = async (title, parentNodeToken) => {
    const args = [
      'wiki',
      '+node-create',
      '--space-id',
      spaceId,
      '--title',
      safeTitle(title, 'PageStudy Wiki'),
      '--as',
      'user',
      '--format',
      'json',
    ];
    if (parentNodeToken) args.push('--parent-node-token', validateToken(parentNodeToken, '父节点 token'));
    const data = await larkJson(args);
    const ref = normalizeRef(data, origin);
    if (!ref) throw new Error('飞书没有返回 Wiki 节点 token 或 URL。');
    if (!origin) origin = originFromUrl(ref.url);
    return ref;
  };

  const listNodes = async (parentNodeToken) => {
    const nodes = [];
    let pageToken = '';
    for (let page = 0; page < 20; page += 1) {
      const args = [
        'wiki',
        '+node-list',
        '--space-id',
        spaceId,
        '--as',
        'user',
        '--format',
        'json',
        '--page-size',
        '50',
      ];
      if (parentNodeToken) args.push('--parent-node-token', validateToken(parentNodeToken, '父节点 token'));
      if (pageToken) args.push('--page-token', pageToken);
      const data = await larkJson(args);
      if (Array.isArray(data?.nodes)) nodes.push(...data.nodes);
      if (!data?.has_more || !data.page_token) break;
      pageToken = data.page_token;
    }
    return nodes;
  };

  const findChild = (nodes, title) => {
    return nodes.find((node) => asString(node.title) === title) ?? null;
  };

  const ensureNode = async ({ ref, parentNodeToken, title }) => {
    if (ref) return { ref, isNew: false };
    if (parentNodeToken) {
      const existing = findChild(await listNodes(parentNodeToken), title);
      if (existing) {
        const adopted = normalizeRef(existing, origin);
        if (adopted) return { ref: adopted, isNew: false };
      }
    }
    return { ref: await createNode(title, parentNodeToken), isNew: true };
  };

  try {
    if (!spaceId) {
      const data = await larkJson([
        'wiki',
        'spaces',
        'get',
        '--space-id',
        'my_library',
        '--lang',
        'zh',
        '--as',
        'user',
        '--format',
        'json',
      ]);
      const resolved = asString(data?.space?.space_id);
      if (!resolved) throw new Error('无法解析飞书个人文档库。');
      spaceId = resolved;
    }

    // 根节点：优先复用本地映射；其次按标题查找；最后创建。
    if (!rootRef) {
      const rootNodes = await listNodes('');
      const existing = findChild(rootNodes, safeTitle(rootInput.title, 'PageStudy Wiki'));
      if (existing) {
        const adopted = normalizeRef(existing, origin);
        if (adopted) rootRef = adopted;
      }
    }
    if (!rootRef) {
      rootRef = await createNode(safeTitle(rootInput.title, 'PageStudy Wiki'), '');
      created += 1;
    }

    // 分类节点必须先全部存在，页面正文里的分类链接才有目标。
    for (const category of payload.categories) {
      const key = asString(category.key);
      if (!CATEGORY_KEYS.includes(key)) throw new Error(`未知 Wiki 分类：${key}`);
      const title = safeTitle(category.title, key);
      const ensured = await ensureNode({
        ref: categoryRefs[key],
        parentNodeToken: rootRef.nodeToken,
        title,
      });
      categoryRefs[key] = {
        ...ensured.ref,
        title,
        // 先保留上一次成功写入的哈希；本次写入成功后再更新。
        hash: previous?.categories?.[key]?.hash || '',
      };
      if (ensured.isNew) created += 1;
    }

    // 页面节点也先全部创建/复用，再统一更新正文，保证反链 URL 可用。
    for (const page of payload.pages) {
      const id = validatePageId(page.id);
      const title = safeTitle(page.title, '未命名页面');
      const category = asString(page.category);
      if (!CATEGORY_KEYS.includes(category)) throw new Error(`未知 Wiki 分类：${category}`);
      const parent = categoryRefs[category];
      if (!parent) throw new Error(`分类“${category}”尚未创建。`);
      const ensured = await ensureNode({
        ref: pageRefs[id] ?? previousPages[id],
        parentNodeToken: parent.nodeToken,
        title,
      });
      pageRefs[id] = {
        ...ensured.ref,
        pageId: id,
        title,
        kind: page.kind,
        // 先保留上一次成功写入的哈希；本次写入成功后再更新。
        hash: previousPages[id]?.hash || '',
      };
      if (ensured.isNew) created += 1;
    }

    const urls = new Map();
    urls.set('__root__', rootRef.url);
    for (const [key, ref] of Object.entries(categoryRefs)) {
      urls.set(`category:${key}`, ref.url);
    }
    for (const [id, ref] of Object.entries(pageRefs)) urls.set(id, ref.url);

    const applyContent = async (nodeRef, markdown, hash, previousHash) => {
      if (previousHash && previousHash === hash) {
        skipped += 1;
        return;
      }
      const url = await updateDoc(nodeRef.objToken, replaceLinks(markdown, urls));
      if (!nodeRef.url && url) nodeRef.url = wikiUrl(nodeRef.nodeToken, origin) || url;
      updated += 1;
    };

    const rootPreviousHash = rootRef.hash || '';
    const rootNextHash = asString(rootInput.hash);
    const rootWithHash = {
      ...rootRef,
      title: safeTitle(rootInput.title, 'PageStudy Wiki'),
      hash: rootPreviousHash,
    };
    rootRef = rootWithHash;
    await applyContent(rootWithHash, rootInput.markdown, rootNextHash, rootPreviousHash);
    rootRef.hash = rootNextHash;

    for (const category of payload.categories) {
      const key = category.key;
      const ref = categoryRefs[key];
      if (!ref) continue;
      const markdown = typeof category.markdown === 'string' ? category.markdown : '';
      const hash = asString(category.hash);
      const previousHash = previous?.categories?.[key]?.hash || '';
      await applyContent(ref, markdown, hash, previousHash);
      ref.hash = hash;
    }

    for (const page of payload.pages) {
      const id = page.id;
      const ref = pageRefs[id];
      if (!ref) continue;
      const markdown = typeof page.markdown === 'string' ? page.markdown : '';
      if (!markdown.trim()) throw new Error(`页面“${page.title}”没有内容。`);
      if (markdown.length > MAX_MARKDOWN) throw new Error(`页面“${page.title}”内容过大。`);
      const hash = asString(page.hash);
      const previousHash = previousPages[id]?.hash || '';
      await applyContent(ref, markdown, hash, previousHash);
      ref.hash = hash;
    }

    return {
      ok: true,
      state: makeState(spaceId, rootRef, categoryRefs, pageRefs),
      created,
      updated,
      skipped,
    };
  } catch (error) {
    const partial = rootRef
      ? makeState(spaceId || previous?.spaceId || '', rootRef, categoryRefs, pageRefs)
      : null;
    return {
      ok: false,
      error: String(error?.message || error).slice(0, 1200),
      state: partial || undefined,
      created,
      updated,
      skipped,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
