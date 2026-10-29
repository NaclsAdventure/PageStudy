import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContext, ProviderConfig, SectionSummaryRequest } from '../shared/types';
import { buildSectionSummaryPrompt, summarizeSection } from './section-summary';

const provider: ProviderConfig = {
  id: 'openai',
  label: 'OpenAI',
  apiKey: 'test-key',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  reasoning: 'medium',
};

function page(): PageContext {
  return {
    url: 'https://example.com/paper.pdf',
    title: '测试 PDF',
    canonicalUrl: 'https://example.com/paper.pdf',
    site: 'example.com',
    author: '',
    publishedAt: '',
    lang: 'zh-CN',
    description: '',
    outline: [
      {
        id: 's1',
        level: 1,
        title: '第一节',
        text: '第一节的正文，讨论检索。',
        anchor: 'pdf-p1',
        page: 1,
        children: [],
      },
      {
        id: 's2',
        level: 1,
        title: '第二节',
        text: '第二节的正文，讨论生成。',
        anchor: 'pdf-p2',
        page: 2,
        children: [],
      },
    ],
    capturedAt: 1,
    contentHash: 'hash',
    wordCount: 20,
    sourceType: 'pdf',
    pdfPageCount: 2,
  };
}

function request(): SectionSummaryRequest {
  return {
    page: page(),
    section: page().outline[0],
    language: '中文',
    model: 'test-model',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildSectionSummaryPrompt', () => {
  it('只包含当前小节，不包含其他小节正文', () => {
    const prompt = buildSectionSummaryPrompt(request());
    expect(prompt).toContain('第一节的正文');
    expect(prompt).not.toContain('第二节的正文');
    expect(prompt).toContain('只总结当前小节');
  });
});

describe('summarizeSection', () => {
  it('解析小节 JSON，并把结果绑定到当前 outlineId', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        messages?: Array<{ content?: string }>;
      };
      const content = body.messages?.map((message) => message.content ?? '').join('\n') ?? '';
      expect(content).not.toContain('第二节的正文');
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: '这一节解释了检索的作用。',
                  keyPoints: ['检索负责找材料'],
                  questions: ['检索质量如何评估？'],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const section = await summarizeSection(request(), provider);
    expect(section.outlineId).toBe('s1');
    expect(section.title).toBe('第一节');
    expect(section.summary).toContain('检索');
    expect(section.keyPoints).toEqual(['检索负责找材料']);
  });
});
