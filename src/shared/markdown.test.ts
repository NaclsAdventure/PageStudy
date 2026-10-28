import { describe, expect, it } from 'vitest';
import type { StudyRecord } from './types';
import { recordToFeishuAppendMarkdown, recordToFeishuTitle, recordToMarkdown } from './markdown';

function buildRecord(notes = '我自己的笔记'): StudyRecord {
  return {
    id: 'record-1',
    page: {
      url: 'https://example.com/blog/post',
      title: '把文章变成自己的理解',
      canonicalUrl: 'https://example.com/blog/post',
      site: 'example.com',
      author: '作者',
      publishedAt: '2026-01-02',
      lang: 'zh-CN',
      description: '摘要',
      outline: [
        {
          id: 'ps-outline-1',
          level: 1,
          title: '引言',
          text: '原文摘录',
          anchor: 'intro',
          children: [
            { id: 'ps-outline-2', level: 2, title: '小节', text: '小节原文', anchor: 'sub', children: [] },
          ],
        },
      ],
      capturedAt: 1,
      contentHash: 'abc123',
      wordCount: 1200,
    },
    summary: {
      overview: '整篇文章的概览。',
      tags: ['阅读', '总结'],
      sections: [
        {
          outlineId: 'ps-outline-1',
          title: '引言',
          summary: '引言总结。',
          keyPoints: ['要点一'],
          questions: ['是否成立？'],
        },
      ],
      keyConcepts: [{ term: '主动阅读', explanation: '带着问题读。' }],
      generatedAt: 1,
      model: 'test-model',
    },
    messages: [
      { id: 'm1', role: 'user', content: '这段话什么意思？', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '可以理解为……', createdAt: 2 },
    ],
    selections: [
      { text: '被选中的原文', paragraph: '被选中的原文', headingPath: ['引言'], anchor: 'intro' },
    ],
    notes,
    tags: ['我的标签'],
    status: 'ready',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    feishu: null,
    error: null,
  };
}

describe('recordToMarkdown', () => {
  it('保留来源、概览、大纲树、对话和笔记', () => {
    const markdown = recordToMarkdown(buildRecord());
    expect(markdown).toContain('# 把文章变成自己的理解');
    expect(markdown).toContain('https://example.com/blog/post');
    expect(markdown).toContain('## 内容概览');
    expect(markdown).toContain('整篇文章的概览。');
    expect(markdown).toContain('### 引言');
    expect(markdown).toContain('#### 小节');
    expect(markdown).toContain('**我：**');
    expect(markdown).toContain('**助教：**');
    expect(markdown).toContain('## 选中的原文');
    expect(markdown).toContain('#我的标签');
  });

  it('笔记只输出一次', () => {
    const markdown = recordToMarkdown(buildRecord('只出现一次的笔记'));
    const occurrences = markdown.split('只出现一次的笔记').length - 1;
    expect(occurrences).toBe(1);
  });

  it('没有大纲时仍然包含笔记', () => {
    const record = buildRecord('无大纲笔记');
    record.page.outline = [];
    record.summary = null;
    const markdown = recordToMarkdown(record);
    expect(markdown).toContain('## 我的笔记');
    expect(markdown).toContain('无大纲笔记');
  });
});

describe('recordToFeishuAppendMarkdown', () => {
  it('追加内容只包含更新，不重复网页标题与原文链接', () => {
    const markdown = recordToFeishuAppendMarkdown(buildRecord('新的理解'), 1700000000000);
    expect(markdown).toContain('## 追加更新');
    expect(markdown).toContain('### 内容概览');
    expect(markdown).toContain('### 我的笔记');
    expect(markdown).toContain('新的理解');
    expect(markdown).not.toContain('# 把文章变成自己的理解');
    expect(markdown).not.toContain('原文：');
  });
});

describe('recordToFeishuTitle', () => {
  it('包含标题和日期', () => {
    const title = recordToFeishuTitle(buildRecord());
    expect(title).toContain('学习记录');
    expect(title).toContain('把文章变成自己的理解');
    expect(title).toMatch(/\d{2}\/\d{2}/);
  });
});
