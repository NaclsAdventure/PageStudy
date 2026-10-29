import { WIKI_ROOT_TITLE, WIKI_STATE_KEY } from './constants';
import type {
  FeishuWikiState,
  WikiCategoryKey,
  WikiCategoryRef,
  WikiNodeRef,
  WikiPageRef,
  WikiPublishCategory,
  WikiPublishPage,
  WikiPublishRequest,
} from './types';
import { formatDate, hashString, truncate } from './utils';
import { wikiTopicPageId, type WikiIndex, type WikiPage } from './wiki';

export const WIKI_ROOT_PAGE_ID = '__root__';
export const WIKI_ROOT_CATEGORY: WikiCategoryKey[] = ['records', 'tags', 'concepts'];

export const WIKI_CATEGORY_TITLES: Record<WikiCategoryKey, string> = {
  records: '学习记录',
  tags: '标签主题',
  concepts: '概念主题',
};

const CATEGORY_BY_KIND: Record<WikiPage['kind'], WikiCategoryKey> = {
  note: 'records',
  tag: 'tags',
  concept: 'concepts',
};

export function wikiPageLink(pageId: string): string {
  return `{{pagestudy:${pageId}}}`;
}

export function wikiRootLink(): string {
  return wikiPageLink(WIKI_ROOT_PAGE_ID);
}

/** 桥接在节点创建完成后，把占位符替换成真实的飞书 Wiki 链接。 */
export function replaceWikiLinks(markdown: string, urls: Map<string, string>): string {
  return markdown.replace(/\{\{pagestudy:([^}]+)\}\}/g, (_match, pageId: string) => {
    return urls.get(pageId) || '#';
  });
}

export function wikiPageCategory(page: WikiPage): WikiCategoryKey {
  return CATEGORY_BY_KIND[page.kind];
}

export function wikiPageDisplayTitle(page: WikiPage): string {
  if (page.kind === 'tag') return `标签 · ${page.title}`;
  if (page.kind === 'concept') return `概念 · ${page.title}`;
  return page.title.trim() || '未命名记录';
}

function uniqueTitle(title: string, id: string, used: Set<string>): string {
  const base = title.trim().slice(0, 180) || '未命名页面';
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const suffix =
    id.slice(-6).replace(/[^A-Za-z0-9_-]/g, '') || hashString(id).slice(0, 6);
  const candidate = `${base} · ${suffix || '重复'}`.slice(0, 200);
  used.add(candidate);
  return candidate;
}

function nodeLink(pageId: string, title: string): string {
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
  return `[${safeTitle}](${wikiPageLink(pageId)})`;
}

function pageSummaryLine(page: WikiPage): string {
  return page.overview.trim() ? truncate(page.overview.trim(), 180) : page.subtitle;
}

function renderRecordPage(page: WikiPage, index: WikiIndex): string {
  const lines: string[] = [];
  const source =
    page.sourceUrl && /^https?:\/\//i.test(page.sourceUrl)
      ? `[${page.sourceUrl}](${page.sourceUrl})`
      : '手动摘录';
  lines.push(`> 来源：${source}`);
  lines.push(`> 记录时间：${formatDate(page.updatedAt)}`);
  lines.push('');
  lines.push('## 30 秒速读');
  lines.push('');
  lines.push((page.thesis || page.overview).trim() || '还没有内容概览。');
  if (page.quickRead && page.quickRead.length > 0) {
    lines.push('');
    for (const point of page.quickRead) lines.push(`- ${point}`);
  }

  if (page.tags.length > 0) {
    lines.push('');
    lines.push('## 标签');
    lines.push('');
    for (const tag of page.tags) {
      const topic = index.byId.get(wikiTopicPageId('tag', tag));
      lines.push(`- ${topic ? nodeLink(topic.id, `#${tag}`) : `#${tag}`}`);
    }
  }

  if (page.argumentMap && page.argumentMap.length > 0) {
    lines.push('');
    lines.push('## 核心论证');
    page.argumentMap.forEach((argument, index) => {
      lines.push('');
      lines.push(`### ${index + 1}. ${argument.claim}`);
      if (argument.evidence) lines.push(`- 证据：${argument.evidence}`);
      if (argument.assumptions) lines.push(`- 隐含假设：${argument.assumptions}`);
      if (argument.boundary) lines.push(`- 适用边界：${argument.boundary}`);
    });
  }

  if (page.concepts.length > 0) {
    lines.push('');
    lines.push('## 概念卡');
    lines.push('');
    for (const concept of page.concepts) {
      const topic = index.byId.get(wikiTopicPageId('concept', concept.term));
      const term = topic ? nodeLink(topic.id, concept.term) : concept.term;
      lines.push(`- **${term}**：${concept.explanation || '暂无解释。'}`);
    }
  }

  if (page.dialogueInsights && page.dialogueInsights.length > 0) {
    lines.push('');
    lines.push('## 问答沉淀');
    for (const insight of page.dialogueInsights) {
      lines.push('');
      lines.push(`### ${insight.question}`);
      lines.push('');
      lines.push(insight.insight);
      if (insight.evidence.length > 0) lines.push('', `依据：${insight.evidence.join('；')}`);
      if (insight.concepts.length > 0) lines.push('', `相关概念：${insight.concepts.join('、')}`);
    }
  }

  if (page.sections.length > 0) {
    lines.push('');
    lines.push('## 章节笔记');
    for (const section of page.sections) {
      lines.push('');
      lines.push(`### ${section.title || '未命名章节'}`);
      lines.push('');
      if (section.summary.trim()) lines.push(section.summary.trim());
      if (section.keyPoints.length > 0) {
        lines.push('');
        for (const point of section.keyPoints) lines.push(`- ${point}`);
      }
    }
  }

  if (page.notes.trim()) {
    lines.push('');
    lines.push('## 我的判断');
    lines.push('');
    lines.push(page.notes.trim());
  }

  const backlinks = page.backlinks
    .map((id) => index.byId.get(id))
    .filter((item): item is WikiPage => Boolean(item));
  if (backlinks.length > 0) {
    lines.push('');
    lines.push('## 反向链接');
    lines.push('');
    for (const item of backlinks) lines.push(`- ${nodeLink(item.id, wikiPageDisplayTitle(item))}`);
  }

  lines.push('');
  lines.push('---');
  lines.push(`[返回 PageStudy Wiki 首页](${wikiRootLink()})`);
  return `${lines.join('\n').trim()}\n`;
}

function renderTopicPage(
  page: WikiPage,
  index: WikiIndex,
  links: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push('> 这是 PageStudy 自动维护的主题聚合页；相关记录来自本地学习记录。');
  lines.push('');
  lines.push('## 概览');
  lines.push('');
  lines.push(page.overview.trim() || '还没有内容概览。');
  lines.push('');
  lines.push(`## 相关记录（${page.recordCount}）`);
  lines.push('');
  if (page.outbound.length === 0) {
    lines.push('还没有关联记录。');
  } else {
    const records = page.outbound
      .map((id) => index.byId.get(id))
      .filter((item): item is WikiPage => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const record of records) {
      const title = links.get(record.id) ?? record.title;
      lines.push(`- ${nodeLink(record.id, title)}：${pageSummaryLine(record)}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(`[返回 PageStudy Wiki 首页](${wikiRootLink()})`);
  return `${lines.join('\n').trim()}\n`;
}

function renderCategoryPage(
  key: WikiCategoryKey,
  pages: WikiPage[],
  links: Map<string, string>,
): string {
  const title = WIKI_CATEGORY_TITLES[key];
  const lines: string[] = [
    `> 本页由 PageStudy 自动维护，收录 ${pages.length} 个${title}页面。`,
    '',
    `## ${title}`,
    '',
  ];
  if (pages.length === 0) {
    lines.push('还没有页面。保存学习记录后会自动出现在这里。');
  } else {
    for (const page of pages) {
      lines.push(`- ${nodeLink(page.id, links.get(page.id) ?? page.title)}`);
      lines.push(`  ${pageSummaryLine(page)}`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push(`[返回 PageStudy Wiki 首页](${wikiRootLink()})`);
  return `${lines.join('\n').trim()}\n`;
}

function renderRootPage(
  notes: WikiPage[],
  tags: WikiPage[],
  concepts: WikiPage[],
  links: Map<string, string>,
): string {
  // 用最近一条记录的时间，而不是当前时间；否则每次重建首页都会变化，
  // 内容哈希永远不同，幂等发布会退化成每次都覆盖首页。
  const latestUpdatedAt = [...notes, ...tags, ...concepts].reduce(
    (latest, page) => Math.max(latest, page.updatedAt),
    0,
  );
  const lines: string[] = [
    '> 这是 PageStudy 的个人学习 Wiki，由本地记录自动生成并覆盖更新。',
    '',
    '## 知识库概览',
    '',
    `- 学习记录：${notes.length}`,
    `- 标签主题：${tags.length}`,
    `- 概念主题：${concepts.length}`,
    `- 最近更新：${formatDate(latestUpdatedAt || Date.now())}`,
    '',
    '## 分类',
    '',
  ];
  for (const key of WIKI_ROOT_CATEGORY) {
    lines.push(`- [${WIKI_CATEGORY_TITLES[key]}](${wikiPageLink(`category:${key}`)})`);
  }
  lines.push('', '## 最近记录', '');
  if (notes.length === 0) {
    lines.push('还没有学习记录。');
  } else {
    for (const page of notes.slice(0, 12)) {
      const title = links.get(page.id) ?? page.title;
      lines.push(`- ${nodeLink(page.id, title)} · ${formatDate(page.updatedAt)}`);
    }
  }
  lines.push('', '## 使用说明', '');
  lines.push('本 Wiki 与本地 PageStudy 记录对应；本地删除记录不会自动删除这里的云端页面。');
  return `${lines.join('\n').trim()}\n`;
}

/**
 * 把派生 Wiki 转成发往桥接的页面清单。
 * 页面内部链接使用占位符，桥接创建完节点后统一替换成真实 URL。
 */
export function buildWikiPublishRequest(
  index: WikiIndex,
  state: FeishuWikiState | null,
): WikiPublishRequest {
  const grouped: Record<WikiCategoryKey, WikiPage[]> = {
    records: [],
    tags: [],
    concepts: [],
  };
  for (const page of index.pages) grouped[wikiPageCategory(page)].push(page);

  const usedTitles: Record<WikiCategoryKey, Set<string>> = {
    records: new Set(),
    tags: new Set(),
    concepts: new Set(),
  };
  const pageEntries: WikiPublishPage[] = [];
  const links = new Map<string, string>();

  for (const key of WIKI_ROOT_CATEGORY) {
    for (const page of grouped[key]) {
      const title = uniqueTitle(wikiPageDisplayTitle(page), page.id, usedTitles[key]);
      links.set(page.id, title);
      const markdown =
        page.kind === 'note'
          ? renderRecordPage(page, index)
          : renderTopicPage(page, index, links);
      pageEntries.push({
        id: page.id,
        kind: page.kind,
        category: key,
        title,
        markdown,
        hash: hashString(`${title}\n${markdown}`),
      });
    }
  }

  // 主题页的“相关记录”标题需要先知道所有页面标题；上一步已经收集完，重算一次
  // 只影响展示文案，不影响节点身份。这里按最终标题重新生成主题页正文。
  for (const entry of pageEntries) {
    if (entry.kind === 'note') continue;
    const page = index.byId.get(entry.id);
    if (!page) continue;
    entry.markdown = renderTopicPage(page, index, links);
    entry.hash = hashString(`${entry.title}\n${entry.markdown}`);
  }

  const categories: WikiPublishCategory[] = WIKI_ROOT_CATEGORY.map((key) => {
    const markdown = renderCategoryPage(key, grouped[key], links);
    return {
      key,
      title: WIKI_CATEGORY_TITLES[key],
      markdown,
      hash: hashString(`${WIKI_CATEGORY_TITLES[key]}\n${markdown}`),
    };
  });

  const rootMarkdown = renderRootPage(grouped.records, grouped.tags, grouped.concepts, links);
  if (state?.root?.url) links.set(WIKI_ROOT_PAGE_ID, state.root.url);

  return {
    root: {
      title: WIKI_ROOT_TITLE,
      markdown: rootMarkdown,
      hash: hashString(`${WIKI_ROOT_TITLE}\n${rootMarkdown}`),
    },
    categories,
    pages: pageEntries,
    state,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseNode(raw: unknown): WikiNodeRef | null {
  if (!isRecord(raw)) return null;
  const nodeToken = asString(raw.nodeToken);
  const objToken = asString(raw.objToken);
  const url = asString(raw.url);
  if (!nodeToken || !objToken || !url) return null;
  return { nodeToken, objToken, url };
}

function parseCategory(raw: unknown, fallbackTitle: string): WikiCategoryRef | null {
  const node = parseNode(raw);
  if (!node) return null;
  return {
    ...node,
    title: asString((raw as Record<string, unknown>).title) || fallbackTitle,
    hash: asString((raw as Record<string, unknown>).hash),
  };
}

export function normalizeWikiState(raw: unknown): FeishuWikiState | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.target !== 'feishu') return null;
  const spaceId = asString(raw.spaceId);
  const root = parseCategory(raw.root, WIKI_ROOT_TITLE);
  if (!spaceId || !root) return null;

  const categories: FeishuWikiState['categories'] = {};
  if (isRecord(raw.categories)) {
    for (const key of WIKI_ROOT_CATEGORY) {
      const parsed = parseCategory(raw.categories[key], WIKI_CATEGORY_TITLES[key]);
      if (parsed) categories[key] = parsed;
    }
  }

  const pages: Record<string, WikiPageRef> = {};
  if (isRecord(raw.pages)) {
    for (const [id, value] of Object.entries(raw.pages)) {
      const node = parseNode(value);
      if (!node || !isRecord(value)) continue;
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
    root,
    categories,
    pages,
    lastPublishedAt:
      typeof raw.lastPublishedAt === 'number' ? raw.lastPublishedAt : undefined,
    lastError: asString(raw.lastError) || undefined,
  };
}

export async function loadWikiState(): Promise<FeishuWikiState | null> {
  const stored = await chrome.storage.local.get(WIKI_STATE_KEY);
  return normalizeWikiState(stored[WIKI_STATE_KEY]);
}

export async function saveWikiState(state: FeishuWikiState): Promise<void> {
  await chrome.storage.local.set({ [WIKI_STATE_KEY]: state });
}

export function wikiPageNodeUrl(
  state: FeishuWikiState | null,
  pageId: string,
): string | undefined {
  if (!state) return undefined;
  if (pageId === WIKI_ROOT_PAGE_ID) return state.root.url;
  return state.pages[pageId]?.url;
}
