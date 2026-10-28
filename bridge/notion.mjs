/**
 * Notion API 与 Markdown → Notion blocks 的最小实现。
 *
 * 该模块只使用 Node 内置 fetch，不依赖第三方包。Token 只从桥接进程的环境变量读取，
 * 不返回给浏览器，也不写日志。
 */
const NOTION_VERSION = '2022-06-28';
const NOTION_API = (process.env.NOTION_API_BASE || 'https://api.notion.com/v1').replace(/\/+$/, '');
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const DEFAULT_PARENT = process.env.NOTION_PARENT_PAGE_ID || '';

export function notionEnabled() {
  return Boolean(NOTION_TOKEN);
}

export function notionStatus() {
  return {
    enabled: Boolean(NOTION_TOKEN),
    parentConfigured: Boolean(DEFAULT_PARENT),
  };
}

function truncate(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function normalizePageId(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  const withoutHyphens = value.replace(/-/g, '');
  const match = withoutHyphens.match(/[0-9a-f]{32}/i);
  return match ? match[0].toLowerCase() : '';
}

async function notionRequest(path, method, body, timeoutMs = 60_000) {
  if (!NOTION_TOKEN) {
    throw new Error('还没有配置 Notion Token。请在启动桥接前设置 NOTION_TOKEN。');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${NOTION_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.message || data?.error || `HTTP ${response.status}`;
      if (response.status === 401) {
        throw new Error('Notion Token 无效或已失效。请检查 NOTION_TOKEN。');
      }
      if (response.status === 404) {
        throw new Error('找不到 Notion 父页面。请确认页面已分享给该 Integration，且 page ID 正确。');
      }
      if (response.status === 429) {
        throw new Error('Notion API 限流，请稍后重试。');
      }
      throw new Error(`Notion API 错误（HTTP ${response.status}）：${String(message).slice(0, 800)}`);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Notion API 请求超时（60 秒）。');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 去掉 Markdown 行的简单格式标记，避免 Notion 中出现 **、` 等原样符号。 */
function plainInline(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1');
}

function richText(value) {
  const text = String(value || '');
  const chunks = [];
  // Notion rich_text 单个 text.content 最多 2000 字符。
  for (let offset = 0; offset < text.length; offset += 1900) {
    chunks.push({ type: 'text', text: { content: text.slice(offset, offset + 1900) } });
  }
  return chunks.length > 0 ? chunks : [{ type: 'text', text: { content: '' } }];
}

function textBlock(type, content) {
  return { object: 'block', type, [type]: { rich_text: richText(plainInline(content)) } };
}

function codeBlock(content, language) {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: richText(content),
      language: /^[a-z0-9+#.-]{1,30}$/i.test(language || '') ? language : 'plain text',
    },
  };
}

function isSpecialLine(line) {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(?:---+|\*\*\*+)\s*$/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line)
  );
}

/**
 * 将学习记录的 Markdown 转成 Notion 可接受的 block 数组。
 * 只追求内容结构可读，不实现完整的 Markdown/HTML 语义。
 */
export function markdownToNotionBlocks(markdown, options = {}) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  let skippedFirstH1 = false;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const language = line.replace(/^```/, '').trim();
      index += 1;
      const code = [];
      while (index < lines.length && !/^```/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const content = code.join('\n');
      if (content.trim()) {
        for (let offset = 0; offset < content.length || offset === 0; offset += 1900) {
          const part = content.slice(offset, offset + 1900);
          if (part) blocks.push(codeBlock(part, language));
          if (!part) break;
        }
      }
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(3, heading[1].length);
      if (level === 1 && !skippedFirstH1) {
        skippedFirstH1 = true;
        index += 1;
        continue;
      }
      blocks.push(textBlock(`heading_${level}`, heading[2]));
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(textBlock('quote', quote.join('\n')));
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        blocks.push(textBlock('bulleted_list_item', lines[index].replace(/^\s*[-*+]\s+/, '')));
        index += 1;
      }
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        blocks.push(textBlock('numbered_list_item', lines[index].replace(/^\s*\d+\.\s+/, '')));
        index += 1;
      }
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ object: 'block', type: 'divider', divider: {} });
      index += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        const row = lines[index].trim();
        index += 1;
        if (/^\|?[\s:|-]+\|?$/.test(row)) continue;
        const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        blocks.push(textBlock('paragraph', cells.join(' · ')));
      }
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isSpecialLine(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length > 0) {
      blocks.push(textBlock('paragraph', paragraph.join('\n')));
    } else {
      // 未识别的行也必须前进，避免异常输入造成死循环。
      index += 1;
    }
  }

  return blocks.slice(0, 2000);
}

async function appendBlocks(pageId, blocks) {
  for (let offset = 0; offset < blocks.length; offset += 100) {
    await notionRequest(`/blocks/${encodeURIComponent(pageId)}/children`, 'PATCH', {
      children: blocks.slice(offset, offset + 100),
    });
  }
}

export async function createNotionPage({ title, markdown, parentPageId }) {
  const parent = normalizePageId(parentPageId || DEFAULT_PARENT);
  if (!parent) {
    throw new Error('缺少 Notion 父页面 ID。请在设置页填写 parentPageId，或设置 NOTION_PARENT_PAGE_ID。');
  }
  const pageTitle = truncate(String(title || '').trim() || 'PageStudy 学习记录', 2000);
  const blocks = markdownToNotionBlocks(markdown);
  const page = await notionRequest('/pages', 'POST', {
    parent: { type: 'page_id', page_id: parent },
    properties: {
      title: {
        type: 'title',
        title: [{ type: 'text', text: { content: pageTitle } }],
      },
    },
    children: blocks.slice(0, 100),
  });
  if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
  return { ok: true, documentId: page.id, url: page.url || '' };
}

export async function appendNotionPage({ pageId, markdown }) {
  const id = normalizePageId(pageId);
  if (!id) throw new Error('Notion page ID 格式不正确。');
  const blocks = markdownToNotionBlocks(markdown);
  await appendBlocks(id, blocks);
  return { ok: true, documentId: id };
}
