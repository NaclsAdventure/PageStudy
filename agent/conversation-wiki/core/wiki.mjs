/** 从会话记录派生本地 Markdown Wiki，并生成可替换成飞书 URL 的占位链接。 */
import { dirname, join, relative } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import {
  escapeLinkLabel,
  escapeMarkdownInline,
  formatDate,
  isPathInside,
  readJson,
  sha256,
  shortHash,
  slugify,
  writeJsonAtomic,
  writeTextIfChanged,
} from './util.mjs';
import { recordSlug, recordPageId } from './records.mjs';
import { vaultPaths } from './config.mjs';

export const ROOT_PAGE_ID = '__root__';
export const ROOT_TITLE = '会话知识库';
export const CATEGORY_DEFS = [
  { key: 'records', title: '会话记录', directory: 'sessions' },
  { key: 'tags', title: '标签主题', directory: 'topics' },
  { key: 'concepts', title: '概念主题', directory: 'concepts' },
];
const GENERATED_MARKER = '<!-- conversation-wiki:generated -->';
const MAX_PAGE_TRANSCRIPT = 30;

function pageLink(pageId, label, pages) {
  const target = pages.get(pageId);
  const text = escapeLinkLabel(label || target?.title || pageId);
  return `[${text}]({{cw:${pageId}}})`;
}

function renderList(items, fallback = '暂无。') {
  return items.length ? items.map((item) => `- ${item}`).join('\n') : fallback;
}

function renderSessionPage(record, pages) {
  const category = CATEGORY_DEFS[0];
  const meta = [
    formatDate(record.createdAt),
    `${record.messages.length} 条消息`,
    record.transcript?.truncated ? '已截断' : '',
    record.source.agent === 'pi' ? 'Pi' : record.source.agent === 'dsh' ? 'DeepSeek Harness' : '',
    record.source.model || '',
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `# ${escapeMarkdownInline(record.title)}`,
    '',
    `> ${meta}`,
    '',
    `${pageLink(ROOT_PAGE_ID, `返回${ROOT_TITLE}`, pages)} · ${pageLink(
      'category:records',
      category.title,
      pages,
    )}`,
    '',
    '## 概览',
    '',
    record.overview || '暂无概览。',
    '',
  ];
  if (record.sections.length) {
    lines.push('## 会话脉络', '');
    for (const section of record.sections) {
      lines.push(`### ${escapeMarkdownInline(section.title)}`, '', section.summary || '');
      if (section.keyPoints.length) {
        lines.push('', ...section.keyPoints.map((point) => `- ${point}`));
      }
      lines.push('');
    }
  }
  if (record.decisions.length) {
    lines.push('## 决策', '', ...record.decisions.map((item) => `- ${item}`), '');
  }
  if (record.actionItems.length) {
    lines.push('## 行动项', '', ...record.actionItems.map((item) => `- ${item}`), '');
  }
  if (record.openQuestions.length) {
    lines.push('## 待解决问题', '', ...record.openQuestions.map((item) => `- ${item}`), '');
  }
  if (record.tags.length) {
    lines.push(
      '## 标签',
      '',
      ...record.tags.map((tag) => `- ${pageLink(topicPageId('tag', tag), `标签 · ${tag}`, pages)}`),
      '',
    );
  }
  if (record.concepts.length) {
    lines.push(
      '## 概念',
      '',
      ...record.concepts.map(
        (concept) => `- ${pageLink(topicPageId('concept', concept.term), `概念 · ${concept.term}`, pages)}`,
      ),
      '',
    );
  }
  if (record.notes) {
    lines.push('## 我的笔记', '', record.notes, '');
  }
  const visible = record.messages.slice(-MAX_PAGE_TRANSCRIPT);
  lines.push('## 原始会话', '');
  if (record.messages.length > visible.length) {
    lines.push(`> 页面只展示最近 ${visible.length} 条消息；完整转录保存在本地记录中。`, '');
  }
  if (!visible.length) {
    lines.push('暂无消息。');
  } else {
    for (const message of visible) {
      const role = message.role === 'user' ? '我' : message.role === 'assistant' ? '助手' : '工具';
      lines.push(`**${role}**：`, '', message.text, '');
    }
  }
  lines.push('');
  if (record.source.sessionFile) {
    lines.push(`> 来源文件：${escapeMarkdownInline(record.source.sessionFile)}`, '');
  }
  return lines.join('\n');
}

function renderTopicPage(kind, label, records, pages) {
  const title = `${kind === 'tag' ? '标签' : '概念'} · ${label}`;
  const category = kind === 'tag' ? CATEGORY_DEFS[1] : CATEGORY_DEFS[2];
  const lines = [
    `# ${escapeMarkdownInline(title)}`,
    '',
    `> ${kind === 'tag' ? '标签主题' : '概念主题'} · ${records.length} 条会话`,
    '',
    `${pageLink(ROOT_PAGE_ID, `返回${ROOT_TITLE}`, pages)} · ${pageLink(
      `category:${category.key}`,
      category.title,
      pages,
    )}`,
    '',
    '## 相关会话',
    '',
  ];
  lines.push(
    ...records.map(
      (record) => `- ${pageLink(recordPageId(record), record.title, pages)} · ${formatDate(record.createdAt)}`,
    ),
    '',
  );
  return lines.join('\n');
}

function renderCategoryPage(def, pageEntries, pages) {
  const lines = [
    `# ${def.title}`,
    '',
    `> ${pageEntries.length} 个页面`,
    '',
    pageLink(ROOT_PAGE_ID, `返回${ROOT_TITLE}`, pages),
    '',
  ];
  if (!pageEntries.length) {
    lines.push('暂无内容。');
  } else {
    for (const page of pageEntries) {
      lines.push(`- ${pageLink(page.id, page.title, pages)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderRootPage(wiki, pages) {
  const latest = wiki.records[0];
  const lines = [
    `# ${ROOT_TITLE}`,
    '',
    `> 从 Pi / DeepSeek Harness 会话自动派生 · ${wiki.counts.sessions} 条会话 · ${wiki.counts.tags} 个标签 · ${wiki.counts.concepts} 个概念`,
    '',
    latest ? `最近更新：${formatDate(latest.updatedAt)}` : '还没有捕获会话。',
    '',
    '## 分类',
    '',
    ...CATEGORY_DEFS.map((def) => {
      const count =
        def.key === 'records' ? wiki.counts.sessions : def.key === 'tags' ? wiki.counts.tags : wiki.counts.concepts;
      return `- ${pageLink(`category:${def.key}`, def.title, pages)} · ${count}`;
    }),
    '',
    '## 最近会话',
    '',
  ];
  if (!wiki.records.length) {
    lines.push('在一个会话里对 Agent 说“把这次会话整理进知识库”，或让插件自动捕获。');
  } else {
    for (const record of wiki.records.slice(0, 20)) {
      lines.push(
        `- ${pageLink(recordPageId(record), record.title, pages)} · ${formatDate(record.createdAt)}`,
      );
    }
  }
  lines.push('', '## 说明', '', '本目录由 Conversation Wiki 生成；页面顶部带有生成标记。', '');
  return lines.join('\n');
}

export function topicPageId(kind, label) {
  const normalized = String(label || '').normalize('NFKC').trim().toLowerCase();
  return `${kind}:${slugify(normalized, kind)}-${shortHash(`${kind}:${normalized}`, 6)}`;
}

/**
 * 构建 Wiki 页面集合。所有内部链接先使用 {{cw:<pageId>}} 占位，
 * 本地落盘时替换为相对路径，飞书发布时替换为 Wiki URL。
 */
export function buildWiki(records, options = {}) {
  const sorted = [...(Array.isArray(records) ? records : [])].sort(
    (left, right) => right.createdAt - left.createdAt,
  );
  const tagGroups = new Map();
  const conceptGroups = new Map();

  for (const record of sorted) {
    for (const tag of record.tags || []) {
      const key = tag.normalize('NFKC').trim().toLowerCase();
      if (!key) continue;
      const id = topicPageId('tag', tag);
      const group = tagGroups.get(id) || { id, label: tag, records: [] };
      if (!group.records.includes(record.id)) group.records.push(record.id);
      tagGroups.set(id, group);
    }

    for (const concept of record.concepts || []) {
      const key = concept.term.normalize('NFKC').trim().toLowerCase();
      if (!key) continue;
      const id = topicPageId('concept', concept.term);
      const group = conceptGroups.get(id) || { id, label: concept.term, records: [] };
      if (!group.records.includes(record.id)) group.records.push(record.id);
      conceptGroups.set(id, group);
    }
  }

  const pages = new Map();
  const rootPlaceholder = {
    id: ROOT_PAGE_ID,
    kind: 'root',
    category: 'root',
    title: options.rootTitle || ROOT_TITLE,
    localPath: 'index.md',
  };
  pages.set(rootPlaceholder.id, rootPlaceholder);
  for (const def of CATEGORY_DEFS) {
    const id = `category:${def.key}`;
    pages.set(id, {
      id,
      kind: 'category',
      category: def.key,
      title: def.title,
      localPath: `${def.directory}/index.md`,
    });
  }

  const sessionPages = [];
  for (const record of sorted) {
    const page = {
      id: recordPageId(record),
      kind: 'session',
      category: 'records',
      title: record.title,
      localPath: `${CATEGORY_DEFS[0].directory}/${recordSlug(record)}.md`,
      record,
    };
    pages.set(page.id, page);
    sessionPages.push(page);
  }

  const tagPages = [];
  for (const group of [...tagGroups.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))) {
    const page = {
      id: group.id,
      kind: 'tag',
      category: 'tags',
      title: `标签 · ${group.label}`,
      localPath: `${CATEGORY_DEFS[1].directory}/${slugify(group.label, 'tag')}-${shortHash(group.id, 6)}.md`,
      label: group.label,
      records: group.records,
    };
    pages.set(page.id, page);
    tagPages.push(page);
  }

  const conceptPages = [];
  for (const group of [...conceptGroups.values()].sort((left, right) =>
    left.label.localeCompare(right.label, 'zh-CN'),
  )) {
    const page = {
      id: group.id,
      kind: 'concept',
      category: 'concepts',
      title: `概念 · ${group.label}`,
      localPath: `${CATEGORY_DEFS[2].directory}/${slugify(group.label, 'concept')}-${shortHash(group.id, 6)}.md`,
      label: group.label,
      records: group.records,
    };
    pages.set(page.id, page);
    conceptPages.push(page);
  }

  const byRecordId = new Map(sorted.map((record) => [record.id, record]));
  for (const page of sessionPages) {
    page.markdown = renderSessionPage(page.record, pages);
  }
  for (const page of tagPages) {
    page.markdown = renderTopicPage(
      'tag',
      page.label,
      page.records.map((id) => byRecordId.get(id)).filter(Boolean),
      pages,
    );
  }
  for (const page of conceptPages) {
    page.markdown = renderTopicPage(
      'concept',
      page.label,
      page.records.map((id) => byRecordId.get(id)).filter(Boolean),
      pages,
    );
  }

  const categoryEntries = {
    records: sessionPages,
    tags: tagPages,
    concepts: conceptPages,
  };
  for (const def of CATEGORY_DEFS) {
    const page = pages.get(`category:${def.key}`);
    page.markdown = renderCategoryPage(def, categoryEntries[def.key], pages);
  }

  const wiki = {
    rootTitle: options.rootTitle || ROOT_TITLE,
    records: sorted,
    pages,
    root: pages.get(ROOT_PAGE_ID),
    categories: CATEGORY_DEFS.map((def) => pages.get(`category:${def.key}`)),
    sessionPages,
    tagPages,
    conceptPages,
    counts: {
      sessions: sessionPages.length,
      tags: tagPages.length,
      concepts: conceptPages.length,
    },
  };
  wiki.root.markdown = renderRootPage(wiki, pages);
  const allPages = [wiki.root, ...wiki.categories, ...sessionPages, ...tagPages, ...conceptPages];
  for (const page of allPages) {
    page.hash = sha256(`${page.title}\n${page.markdown}`).slice(0, 16);
  }
  wiki.allPages = allPages;
  return wiki;
}

export function replaceWikiLinks(markdown, urls) {
  return String(markdown || '').replace(/\{\{cw:([^}]+)\}\}/g, (_match, pageId) => urls.get(pageId) || '#');
}

function renderLocalPage(page, wiki) {
  const target = join(wiki.vault, page.localPath);
  const urls = new Map();
  for (const candidate of wiki.allPages) {
    const relativePath = relative(dirname(target), join(wiki.vault, candidate.localPath))
      .split('\\')
      .join('/');
    urls.set(candidate.id, relativePath || candidate.localPath);
  }
  return `${GENERATED_MARKER}\n${replaceWikiLinks(page.markdown, urls)}\n`;
}

/** 写入本地 Markdown Wiki；只清理带生成标记的旧文件。 */
export async function writeWiki(config, wiki) {
  const paths = vaultPaths(config);
  wiki.vault = paths.vault;
  const previous = (await readJson(paths.wikiState)) || {};
  const previousPages = previous && typeof previous.pages === 'object' ? previous.pages : {};
  let written = 0;
  for (const page of wiki.allPages) {
    const file = join(paths.vault, page.localPath);
    if (await writeTextIfChanged(file, renderLocalPage(page, wiki))) written += 1;
  }

  const currentPages = Object.fromEntries(
    wiki.allPages.map((page) => [page.id, { path: page.localPath, title: page.title, hash: page.hash }]),
  );
  let pruned = 0;
  const allowedDirs = CATEGORY_DEFS.map((def) => join(paths.vault, def.directory));
  for (const [id, value] of Object.entries(previousPages)) {
    if (currentPages[id] || !value || typeof value.path !== 'string') continue;
    const file = join(paths.vault, value.path);
    if (!isPathInside(paths.vault, file)) continue;
    if (!allowedDirs.some((directory) => isPathInside(directory, file))) continue;
    try {
      const content = await readFile(file, 'utf8');
      if (content.startsWith(GENERATED_MARKER)) {
        await unlink(file);
        pruned += 1;
      }
    } catch {
      // 文件已不存在，不需要处理。
    }
  }

  await writeJsonAtomic(paths.wikiState, {
    schemaVersion: 1,
    generatedAt: Date.now(),
    pages: currentPages,
  });
  return { written, pruned, state: { pages: currentPages } };
}
