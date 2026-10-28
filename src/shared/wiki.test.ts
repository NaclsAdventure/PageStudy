import { describe, expect, it } from 'vitest';
import type { StudyRecord } from './types';
import { buildWiki, filterWikiPages, recordWikiPageId } from './wiki';
import { createManualPage } from './page';
import { getDocumentRef, mergeDocumentRefs, withDocumentRef } from './documents';

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
    summary: null,
    messages: [],
    selections: [],
    notes: '',
    tags: [],
    status: 'captured',
    createdAt: 1,
    updatedAt: 1,
    feishu: null,
    error: null,
    ...overrides,
  };
}

describe('buildWiki', () => {
  it('从记录派生标签页、概念页和双向反链', () => {
    const record = buildRecord({
      tags: ['阅读'],
      summary: {
        overview: '概览',
        tags: ['总结'],
        sections: [],
        keyConcepts: [{ term: '主动阅读', explanation: '带着问题读。' }],
        generatedAt: 1,
        model: 'test',
      },
    });
    const wiki = buildWiki([record]);
    expect(wiki.noteCount).toBe(1);
    expect(wiki.tagCount).toBe(2);
    expect(wiki.conceptCount).toBe(1);

    const note = wiki.byId.get(recordWikiPageId(record.id));
    expect(note).toBeTruthy();
    expect(note?.backlinks.length).toBe(3);
    const tag = [...wiki.byId.values()].find((page) => page.kind === 'tag' && page.title === '阅读');
    expect(tag?.backlinks).toContain(recordWikiPageId(record.id));
    expect(note?.outbound).toContain(tag?.id);
    const concept = [...wiki.byId.values()].find((page) => page.kind === 'concept');
    expect(concept?.backlinks).toContain(recordWikiPageId(record.id));
  });

  it('同一标签跨记录聚合，不重复建页', () => {
    const first = buildRecord({ id: 'a', tags: ['阅读'] });
    const second = buildRecord({ id: 'b', tags: ['阅读'] });
    const wiki = buildWiki([first, second]);
    const tags = [...wiki.byId.values()].filter((page) => page.kind === 'tag');
    expect(tags).toHaveLength(1);
    expect(tags[0].recordCount).toBe(2);
    expect(tags[0].outbound).toHaveLength(2);
  });

  it('支持按关键词和类型过滤', () => {
    const wiki = buildWiki([
      buildRecord({
        tags: ['阅读'],
        summary: {
          overview: '主动阅读的方法',
          tags: [],
          sections: [],
          keyConcepts: [],
          generatedAt: 1,
          model: 'test',
        },
      }),
    ]);
    expect(filterWikiPages(wiki.pages, '主动阅读')).toHaveLength(1);
    expect(filterWikiPages(wiki.pages, '', 'tag')).toHaveLength(1);
    expect(filterWikiPages(wiki.pages, '不存在')).toHaveLength(0);
  });
});

describe('手动摘录', () => {
  it('把粘贴内容构造成可总结的最小页面上下文', () => {
    const page = createManualPage({
      url: 'chrome://extensions',
      title: '扩展管理页',
      text: '第一段\n第二段',
    });
    expect(page.manual).toBe(true);
    expect(page.title).toBe('扩展管理页');
    expect(page.outline).toHaveLength(1);
    expect(page.outline[0].text).toBe('第一段 第二段');
    expect(page.canonicalUrl).toBe('chrome://extensions');
  });
});

describe('文档引用迁移', () => {
  it('从旧 feishu 字段读取引用，并保留较新的文档 ID', () => {
    const record = buildRecord({
      feishu: { url: 'https://feishu.example/doc', documentId: 'old', writtenAt: 10 },
    });
    expect(getDocumentRef(record, 'feishu')?.documentId).toBe('old');

    const merged = mergeDocumentRefs(
      { feishu: { target: 'feishu', documentId: 'old', url: '', writtenAt: 10 } },
      { feishu: { target: 'feishu', documentId: 'new', url: '', writtenAt: 20 } },
    );
    expect(merged?.feishu?.documentId).toBe('new');

    const next = withDocumentRef(record, {
      target: 'markdown',
      documentId: 'notes/a.md',
      url: '',
      writtenAt: 30,
    });
    expect(next.documents?.markdown?.documentId).toBe('notes/a.md');
    expect(next.sync?.markdown?.status).toBe('synced');
  });

  it('追加接口不返回 URL 时保留已有文档链接', () => {
    const record = buildRecord({
      documents: {
        notion: {
          target: 'notion',
          documentId: 'page-id',
          url: 'https://notion.so/page-id',
          writtenAt: 10,
        },
      },
      feishu: { url: 'https://feishu.example/doc', documentId: 'feishu-id', writtenAt: 5 },
    });
    const next = withDocumentRef(record, {
      target: 'notion',
      documentId: 'page-id',
      url: '',
      writtenAt: 20,
    });
    expect(next.documents?.notion?.url).toBe('https://notion.so/page-id');

    const legacyFeishu = withDocumentRef(record, {
      target: 'feishu',
      documentId: 'feishu-id',
      url: '',
      writtenAt: 21,
    });
    expect(legacyFeishu.documents?.feishu?.url).toBe('https://feishu.example/doc');
    expect(legacyFeishu.feishu?.url).toBe('https://feishu.example/doc');
  });
});
