import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext, ProviderConfig, SummaryRequest } from '../shared/types';
import { generateSummary } from './summary';

const provider: ProviderConfig = {
  id: 'openai',
  label: 'OpenAI',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  reasoning: 'high',
};

function page(): PageContext {
  return {
    url: 'https://example.com/post',
    title: '测试文章',
    canonicalUrl: 'https://example.com/post',
    site: 'example.com',
    author: '作者',
    publishedAt: '',
    lang: 'zh-CN',
    description: '',
    outline: [
      {
        id: 'n1',
        level: 1,
        title: '第一章',
        text: '第一章原文',
        anchor: 'n1',
        children: [
          { id: 'n2', level: 2, title: '1.1', text: '子节原文', anchor: 'n2', children: [] },
        ],
      },
      { id: 'n3', level: 1, title: '第二章', text: '第二章原文', anchor: 'n3', children: [] },
    ],
    capturedAt: 1,
    contentHash: 'hash',
    wordCount: 500,
  };
}

function request(): SummaryRequest {
  return {
    page: page(),
    messages: [{ role: 'user', content: '我应该怎么理解第一章？' }],
    selections: [],
    language: '中文',
    model: 'test-model',
  };
}

function mockContent(content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

function mockSummary(payload: unknown): void {
  mockContent(JSON.stringify(payload));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateSummary', () => {
  it('解析 JSON，并把 section 绑定到真实大纲节点、补齐缺失节点', async () => {
    mockSummary({
      overview: '这篇文章讲了两章内容。',
      tags: ['测试', '结构'],
      sections: [
        {
          outlineId: 'n2',
          title: '被模型改写的标题',
          summary: '子节总结。',
          keyPoints: ['子节点要点'],
          questions: ['子节点问题'],
        },
        {
          outlineId: 'not-exist',
          title: '无匹配标题',
          summary: '不应该被使用。',
        },
      ],
      keyConcepts: [
        { term: '结构', explanation: '文章的组织方式。' },
        { term: '', explanation: '无效概念' },
      ],
    });

    const summary = await generateSummary(request(), provider);
    expect(summary.overview).toBe('这篇文章讲了两章内容。');
    expect(summary.tags).toEqual(['测试', '结构']);
    expect(summary.sections).toHaveLength(3);
    const child = summary.sections.find((section) => section.outlineId === 'n2');
    expect(child?.title).toBe('1.1');
    expect(child?.summary).toBe('子节总结。');
    const first = summary.sections.find((section) => section.outlineId === 'n1');
    expect(first?.summary).toBe('');
    expect(first?.keyPoints).toEqual([]);
    expect(summary.keyConcepts).toEqual([{ term: '结构', explanation: '文章的组织方式。' }]);
    expect(summary.model).toBe('test-model');
  });

  it('解析知识卡扩展字段并去重问答沉淀', async () => {
    mockSummary({
      overview: '全文概览。',
      thesis: '核心主张。',
      quickRead: ['结论一', '结论二'],
      tags: [],
      sections: [],
      keyConcepts: [],
      argumentMap: [
        { claim: '主张', evidence: '证据', assumptions: '假设', boundary: '边界' },
        { claim: '', evidence: '无效' },
      ],
      dialogueInsights: [
        {
          question: '问题一',
          insight: '结论一',
          evidence: ['[§n1]'],
          concepts: ['概念'],
        },
        {
          question: '问题一',
          insight: '结论一',
          evidence: [],
          concepts: [],
        },
      ],
    });
    const summary = await generateSummary(request(), provider);
    expect(summary.thesis).toBe('核心主张。');
    expect(summary.quickRead).toEqual(['结论一', '结论二']);
    expect(summary.argumentMap).toEqual([
      { claim: '主张', evidence: '证据', assumptions: '假设', boundary: '边界' },
    ]);
    expect(summary.dialogueInsights).toHaveLength(1);
    expect(summary.dialogueInsights?.[0].evidence).toEqual(['[§n1]']);
  });

  it('允许模型输出带 Markdown 代码围栏的 JSON', async () => {
    mockContent(
      ['```json', JSON.stringify({ overview: '概览。', tags: [], sections: [], keyConcepts: [] }), '```'].join(
        '\n',
      ),
    );
    const summary = await generateSummary(request(), provider);
    expect(summary.overview).toBe('概览。');
    expect(summary.sections).toHaveLength(3);
  });

  it('修复字符串内换行和尾逗号，避免合法知识卡被误判为无效 JSON', async () => {
    mockContent(
      '{"overview":"第一行\n第二行","tags":["测试"],"sections":[],"keyConcepts":[],}',
    );
    const summary = await generateSummary(request(), provider);
    expect(summary.overview).toBe('第一行\n第二行');
    expect(summary.tags).toEqual(['测试']);
  });

  it('输出被截断时自动用精简提示重试一次', async () => {
    const responses = [
      '{"overview":"这一次的输出被截断了',
      JSON.stringify({ overview: '重试后完整生成。', tags: [], sections: [], keyConcepts: [] }),
    ];
    let index = 0;
    const fetchMock = vi.fn(async () => {
      const current = index;
      index += 1;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: responses[Math.min(current, responses.length - 1)] },
              ...(current === 0 ? { finish_reason: 'length' } : {}),
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const summary = await generateSummary(request(), provider);
    expect(summary.overview).toBe('重试后完整生成。');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('JSON 结构损坏时也会自动重试一次', async () => {
    const responses = [
      '{"overview":"缺少结尾',
      JSON.stringify({ overview: '重试修复成功。', tags: [], sections: [], keyConcepts: [] }),
    ];
    let index = 0;
    const fetchMock = vi.fn(async () => {
      const current = index;
      index += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: responses[Math.min(current, responses.length - 1)] } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const summary = await generateSummary(request(), provider);
    expect(summary.overview).toBe('重试修复成功。');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('缺少 overview 时拒绝保存半成品', async () => {
    mockSummary({ tags: ['x'], sections: [] });
    await expect(generateSummary(request(), provider)).rejects.toThrow('overview');
  });

  it('没有正文时直接报错，不调用模型', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = request();
    input.page.outline = [];
    input.page.blocks = [];
    input.page.wordCount = 0;
    await expect(generateSummary(input, provider)).rejects.toThrow('正文');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
