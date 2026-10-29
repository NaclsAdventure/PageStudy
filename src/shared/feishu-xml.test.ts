import { describe, expect, it } from 'vitest';
import type { StudyRecord } from './types';
import { recordToFeishuAppendXml, recordToFeishuXml } from './feishu-xml';

function buildRecord(notes = '我自己的笔记'): StudyRecord {
  return {
    id: 'record-1',
    page: {
      url: 'https://example.com/blog/post?a=1&b=2',
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
          title: '引言 & 目标',
          text: '原文摘录',
          anchor: 'intro',
          children: [
            {
              id: 'ps-outline-2',
              level: 2,
              title: '小节',
              text: '小节原文',
              anchor: 'sub',
              children: [],
            },
          ],
        },
      ],
      capturedAt: 1,
      contentHash: 'abc123',
      wordCount: 1200,
      images: [
        {
          id: 'img-1',
          src: 'https://example.com/diagram.png?a=1&b=2',
          alt: '示意图',
          caption: '图 1：主动阅读流程',
          anchor: 'intro',
          headingPath: ['引言 & 目标'],
          width: 800,
          height: 400,
        },
        {
          id: 'img-2',
          src: 'https://example.com/unused.png',
          alt: '未选中',
          caption: '未选中图片',
          anchor: 'sub',
          headingPath: ['引言 & 目标'],
          width: 300,
          height: 200,
        },
      ],
    },
    summary: {
      overview: '整篇文章的概览。',
      thesis: '主动阅读比被动接收更有效。',
      quickRead: ['先提问再阅读。'],
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
      argumentMap: [
        {
          claim: '提问能提高理解。',
          evidence: '文中的对照实验。',
          assumptions: '读者愿意先思考。',
          boundary: '只适用于说明文。',
        },
      ],
      dialogueInsights: [
        {
          question: '主动阅读和精读有什么区别？',
          insight: '主动阅读强调先形成问题，再用原文修正判断。',
          evidence: ['[§intro]'],
          concepts: ['主动阅读'],
        },
      ],
      generatedAt: 1,
      model: 'test-model',
    },
    messages: [
      { id: 'm1', role: 'user', content: '原始对话不应导出', createdAt: 1 },
      { id: 'm2', role: 'assistant', content: '原始回答不应导出', createdAt: 2 },
    ],
    selections: [
      { text: '选中的原文不应导出', paragraph: '选中的原文不应导出', headingPath: ['引言'], anchor: 'intro' },
    ],
    selectedImageIds: ['img-1'],
    notes,
    tags: ['我的标签'],
    status: 'ready',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    feishu: null,
    error: null,
  };
}

describe('recordToFeishuXml', () => {
  it('输出原生飞书块、选中图片和知识卡结构', () => {
    const xml = recordToFeishuXml(buildRecord());
    expect(xml).toContain('<title>学习记录 · 把文章变成自己的理解');
    expect(xml).toContain('<callout emoji="📚"');
    expect(xml).toContain('<h2>30 秒速读</h2>');
    expect(xml).toContain('主动阅读比被动接收更有效。');
    expect(xml).toContain('<h2>核心论证</h2>');
    expect(xml).toContain('文中的对照实验。');
    expect(xml).toContain('<h2>概念卡</h2>');
    expect(xml).toContain('<h2>章节笔记</h2>');
    expect(xml).toContain('<h3>引言 &amp; 目标</h3>');
    expect(xml).toContain('<h4>小节</h4>');
    expect(xml).toContain('<h2>图表与图片</h2>');
    expect(xml).toContain('<img href="https://example.com/diagram.png?a=1&amp;b=2" caption="图 1：主动阅读流程"/>');
    expect(xml).not.toContain('unused.png');
    expect(xml).toContain('<h2>问答沉淀</h2>');
    expect(xml).toContain('<h2>我的判断</h2>');
    expect(xml).toContain('#我的标签');
  });

  it('不导出原始对话和选段', () => {
    const xml = recordToFeishuXml(buildRecord());
    expect(xml).not.toContain('原始对话不应导出');
    expect(xml).not.toContain('原始回答不应导出');
    expect(xml).not.toContain('选中的原文不应导出');
  });

  it('转义正文中的 XML 特殊字符', () => {
    const xml = recordToFeishuXml(buildRecord('笔记里有 <script>alert("x")</script> & 符号'));
    expect(xml).toContain('&lt;script&gt;alert("x")&lt;/script&gt; &amp; 符号');
    expect(xml).not.toContain('<script>');
  });

  it('没有任何知识卡时仍然输出可用的标题和笔记', () => {
    const record = buildRecord('只有笔记');
    record.summary = null;
    const xml = recordToFeishuXml(record);
    expect(xml).toContain('<title>');
    expect(xml).toContain('（还没有生成知识卡）');
    expect(xml).toContain('只有笔记');
    expect(xml).toContain('原文摘录');
    expect(xml).toContain('小节原文');
  });
});

describe('recordToFeishuAppendXml', () => {
  it('只输出更新，不带文档标题和图片', () => {
    const xml = recordToFeishuAppendXml(buildRecord('新的理解'), 1700000000000);
    expect(xml).toContain('<h2>追加更新');
    expect(xml).toContain('<h3>30 秒速读</h3>');
    expect(xml).toContain('<h3>我的判断</h3>');
    expect(xml).toContain('新的理解');
    expect(xml).not.toContain('<title>');
    expect(xml).not.toContain('<img ');
  });
});
