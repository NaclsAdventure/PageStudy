import { describe, expect, it } from 'vitest';
import type { PageContext } from './types';
import { buildChatPageContext, buildSmartExcerpts, pageText } from './context';

function page(): PageContext {
  return {
    url: 'https://example.com/post',
    title: '测试文章',
    canonicalUrl: 'https://example.com/post',
    site: 'example.com',
    author: '',
    publishedAt: '',
    lang: 'zh-CN',
    description: '关于检索增强生成的说明。',
    wordCount: 120,
    capturedAt: 1,
    contentHash: 'hash',
    tokenEstimate: 60,
    extractionQuality: 'high',
    outline: [
      {
        id: 'n1',
        level: 1,
        title: '检索',
        text: '检索负责找到相关材料。',
        anchor: 'retrieval',
        children: [],
      },
    ],
    blocks: [
      {
        id: 'b1',
        kind: 'heading',
        text: '检索',
        anchor: 'retrieval',
        headingPath: ['检索'],
        level: 1,
      },
      {
        id: 'b2',
        kind: 'paragraph',
        text: '检索负责找到相关材料，并按相关度排序。',
        anchor: 'retrieval',
        headingPath: ['检索'],
      },
      {
        id: 'b3',
        kind: 'heading',
        text: '生成',
        anchor: 'generation',
        headingPath: ['生成'],
        level: 1,
      },
      {
        id: 'b4',
        kind: 'paragraph',
        text: '生成阶段把检索到的材料组织成可读答案。',
        anchor: 'generation',
        headingPath: ['生成'],
      },
    ],
    images: [
      {
        id: 'img1',
        src: 'https://example.com/rag.png',
        alt: '流程图',
        caption: '检索增强生成流程',
        anchor: 'retrieval',
        headingPath: ['检索'],
        width: 600,
        height: 300,
      },
    ],
  };
}

describe('PDF 小节上下文', () => {
  it('只发送聚焦小节，不发送其他小节或全文', () => {
    const pdf: PageContext = {
      ...page(),
      sourceType: 'pdf',
      pdfPageCount: 2,
      outline: [
        { id: 's1', level: 1, title: '第一节', text: '第一节正文内容。', anchor: 'pdf-p1', page: 1, children: [] },
        { id: 's2', level: 1, title: '第二节', text: '第二节正文内容。', anchor: 'pdf-p2', page: 2, children: [] },
      ],
      blocks: [
        { id: 'p1', kind: 'paragraph', text: '第一节正文内容。', anchor: 'pdf-p1', headingPath: ['第一节'], page: 1 },
        { id: 'p2', kind: 'paragraph', text: '第二节正文内容。', anchor: 'pdf-p2', headingPath: ['第二节'], page: 2 },
      ],
    };
    const context = buildChatPageContext(pdf, 'full', '问题', [], 's2');
    expect(context).toContain('第二节正文内容');
    expect(context).not.toContain('第一节正文内容');
    expect(context).not.toContain('FULL_TEXT');
  });

  it('没有选择小节时不发送 PDF 正文', () => {
    const pdf: PageContext = {
      ...page(),
      sourceType: 'pdf',
      pdfPageCount: 1,
      outline: [
        { id: 's1', level: 1, title: '第一节', text: '不应发送的正文。', anchor: 'pdf-p1', page: 1, children: [] },
      ],
    };
    const context = buildChatPageContext(pdf, 'smart', '问题', [], '');
    expect(context).not.toContain('不应发送的正文');
    expect(context).toContain('不会发送 PDF 全文');
  });
});

describe('pageText', () => {
  it('优先使用全文块而不是旧大纲', () => {
    const text = pageText(page());
    expect(text).toContain('检索负责找到相关材料');
    expect(text).toContain('生成阶段把检索到的材料');
  });
});

describe('buildChatPageContext', () => {
  it('始终全文包含正文和页面简报', () => {
    const context = buildChatPageContext(page(), 'full', '检索是什么？', []);
    expect(context).toContain('<<<FULL_TEXT>>>');
    expect(context).toContain('生成阶段把检索到的材料');
    expect(context).toContain('检索增强生成流程');
  });

  it('智能全文在短文时直接带入全文', () => {
    const context = buildChatPageContext(page(), 'smart', '生成阶段怎么组织答案？', []);
    expect(context).toContain('<<<FULL_TEXT>>>');
    expect(context).toContain('生成阶段把检索到的材料');
    expect(context).toContain('章节地图');
  });

  it('长文智能模式只带相关片段和页面简报', () => {
    const longPage = page();
    longPage.blocks = Array.from({ length: 40 }, (_, index) => ({
      id: `long-${index}`,
      kind: 'paragraph',
      text: `第 ${index} 段补充材料，用来让智能模式进入检索分支。${'补充说明。'.repeat(100)}`,
      anchor: `section-${index}`,
      headingPath: [`第 ${index} 节`],
    }));
    longPage.blocks.push({
      id: 'target',
      kind: 'paragraph',
      text: '生成阶段把检索到的材料组织成可读答案。',
      anchor: 'generation-target',
      headingPath: ['生成'],
    });
    const context = buildChatPageContext(longPage, 'smart', '生成阶段如何组织答案？', []);
    expect(context).toContain('<<<RELEVANT_EXCERPTS>>>');
    expect(context).toContain('生成阶段把检索到的材料');
    expect(context).not.toContain('<<<FULL_TEXT>>>');
  });

  it('仅选段不发送全文正文', () => {
    const context = buildChatPageContext(page(), 'selection', '解释一下', []);
    expect(context).toContain('章节地图');
    expect(context).not.toContain('检索负责找到相关材料');
    expect(context).not.toContain('<<<FULL_TEXT>>>');
  });

  it('关闭时不发送页面内容', () => {
    const context = buildChatPageContext(page(), 'off', '解释一下', []);
    expect(context).toBe('（当前未启用网页上下文）');
  });
});

describe('buildSmartExcerpts', () => {
  it('优先选择与问题相关的块', () => {
    const excerpts = buildSmartExcerpts(page(), '生成阶段如何组织答案？', []);
    expect(excerpts).toContain('生成阶段把检索到的材料');
  });
});
