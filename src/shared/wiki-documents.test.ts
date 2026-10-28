import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudyRecord } from './types';
import {
  buildWikiPublishRequest,
  normalizeWikiState,
  replaceWikiLinks,
  wikiPageLink,
  WIKI_ROOT_PAGE_ID,
} from './wiki-documents';
import { buildWiki, recordWikiPageId } from './wiki';

function buildRecord(overrides: Partial<StudyRecord> = {}): StudyRecord {
  return {
    id: 'record-1',
    page: {
      url: 'https://example.com/blog/post',
      title: '把文章变成自己的理解',
      canonicalUrl: 'https://example.com/blog/post',
      site: 'example.com',
      author: '',
      publishedAt: '',
      lang: 'zh-CN',
      description: '',
      outline: [],
      capturedAt: 1,
      contentHash: 'abc123',
      wordCount: 100,
    },
    summary: {
      overview: '主动阅读的方法',
      tags: ['总结'],
      sections: [
        {
          outlineId: 'section-1',
          title: '第一步',
          summary: '先提出问题。',
          keyPoints: ['带着问题读'],
          questions: [],
        },
      ],
      keyConcepts: [{ term: '主动阅读', explanation: '带着问题读。' }],
      generatedAt: 1,
      model: 'test',
    },
    messages: [],
    selections: [],
    notes: '我的补充笔记',
    tags: ['阅读'],
    status: 'ready',
    createdAt: 1,
    updatedAt: 2,
    feishu: null,
    error: null,
    ...overrides,
  };
}

describe('buildWikiPublishRequest', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('生成根节点、分类、页面及内部链接占位符', () => {
    const record = buildRecord();
    const index = buildWiki([record]);
    const request = buildWikiPublishRequest(index, null);

    expect(request.root.title).toBe('PageStudy Wiki');
    expect(request.categories.map((item) => item.key)).toEqual(['records', 'tags', 'concepts']);
    expect(request.pages).toHaveLength(1 + 2 + 1);

    const note = request.pages.find((page) => page.id === recordWikiPageId(record.id));
    expect(note).toBeTruthy();
    expect(note?.markdown).toContain('我的补充笔记');
    expect(note?.markdown).toContain('第一步');
    expect(note?.markdown).toContain(wikiPageLink(WIKI_ROOT_PAGE_ID));

    const tag = request.pages.find((page) => page.kind === 'tag' && page.title === '标签 · 阅读');
    expect(tag?.markdown).toContain('相关记录（1）');
    expect(tag?.markdown).toContain(`(${wikiPageLink(note!.id)})`);

    expect(request.root.markdown).toContain('({{pagestudy:category:records}})');
    expect(request.root.markdown).toContain('学习记录：1');
    expect(request.root.markdown).toContain('标签主题：2');
    expect(request.root.markdown).toContain('概念主题：1');
    expect(request.root.hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('相同内容生成稳定哈希，内容变化后哈希变化', () => {
    const index = buildWiki([buildRecord()]);
    const first = buildWikiPublishRequest(index, null);
    const second = buildWikiPublishRequest(index, null);
    expect(first.pages[0].hash).toBe(second.pages[0].hash);

    const changed = buildWiki([buildRecord({ notes: '改过的笔记' })]);
    const third = buildWikiPublishRequest(changed, null);
    expect(third.pages[0].hash).not.toBe(first.pages[0].hash);
  });

  it('根节点和分类页哈希不随当前时间变化', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = buildWikiPublishRequest(buildWiki([buildRecord()]), null);
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const second = buildWikiPublishRequest(buildWiki([buildRecord()]), null);

    expect(second.root.hash).toBe(first.root.hash);
    expect(second.categories.map((item) => item.hash)).toEqual(
      first.categories.map((item) => item.hash),
    );
  });
});

describe('Wiki 发布链接与状态', () => {
  it('替换内部链接占位符，未知链接退回 #', () => {
    const markdown = `[首页](${wikiPageLink('__root__')}) [记录](${wikiPageLink('note:a')})`;
    const result = replaceWikiLinks(
      markdown,
      new Map([
        ['__root__', 'https://example.feishu.cn/wiki/root'],
        ['note:a', 'https://example.feishu.cn/wiki/a'],
      ]),
    );
    expect(result).toContain('https://example.feishu.cn/wiki/root');
    expect(result).toContain('https://example.feishu.cn/wiki/a');
    expect(replaceWikiLinks('[未知]({{pagestudy:missing}})', new Map())).toContain('](#)');
  });

  it('归一化飞书 Wiki 映射并拒绝错误版本', () => {
    const state = normalizeWikiState({
      schemaVersion: 1,
      target: 'feishu',
      spaceId: '7632138902416952284',
      root: {
        nodeToken: 'root-node',
        objToken: 'root-obj',
        url: 'https://example.feishu.cn/wiki/root-node',
        title: 'PageStudy Wiki',
        hash: 'abcd1234',
      },
      categories: {
        records: {
          nodeToken: 'cat-node',
          objToken: 'cat-obj',
          url: 'https://example.feishu.cn/wiki/cat-node',
          title: '学习记录',
          hash: 'efgh5678',
        },
      },
      pages: {
        'note:abc': {
          nodeToken: 'page-node',
          objToken: 'page-obj',
          url: 'https://example.feishu.cn/wiki/page-node',
          pageId: 'note:abc',
          title: '记录',
          kind: 'note',
          hash: 'hash',
        },
      },
    });
    expect(state?.spaceId).toBe('7632138902416952284');
    expect(state?.categories.records?.title).toBe('学习记录');
    expect(state?.pages['note:abc']?.kind).toBe('note');
    expect(normalizeWikiState({ schemaVersion: 2, target: 'feishu' })).toBeNull();
  });
});
