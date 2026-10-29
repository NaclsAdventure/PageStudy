import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DistillRequest, PageContext, ProviderConfig } from '../shared/types';
import {
  buildDistillPrompt,
  distillDiscussion,
  normalizeDistillResult,
} from './distill';

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
    url: 'https://example.com/queue',
    title: '事件队列与解耦',
    canonicalUrl: 'https://example.com/queue',
    site: 'example.com',
    author: '作者',
    publishedAt: '',
    lang: 'zh-CN',
    description: '',
    outline: [
      {
        id: 'n1',
        level: 1,
        title: '队列的作用',
        text: '队列用于解耦生产者与消费者。',
        anchor: 'n1',
        children: [],
      },
    ],
    capturedAt: 1,
    contentHash: 'hash',
    wordCount: 300,
  };
}

function request(): DistillRequest {
  return {
    page: page(),
    section: {
      outlineId: 'n1',
      title: '队列的作用',
      anchor: 'n1',
      summary: '本节解释队列如何解耦。',
      keyPoints: ['削峰'],
      questions: ['代价是什么？'],
    },
    messages: [
      { role: 'user', content: '它和普通队列有什么区别？' },
      { role: 'assistant', content: '事件队列把事件作为一等公民，关注解耦和异步。' },
    ],
    selection: null,
    language: '中文',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildDistillPrompt', () => {
  it('带上本节已有笔记、原文选段和这一轮讨论', () => {
    const prompt = buildDistillPrompt({
      ...request(),
      selection: {
        text: '事件队列用于解耦。',
        paragraph: '事件队列用于解耦。',
        headingPath: ['队列的作用'],
        anchor: 'n1',
      },
    });
    expect(prompt).toContain('章节：队列的作用');
    expect(prompt).toContain('本节解释队列如何解耦。');
    expect(prompt).toContain('事件队列用于解耦。');
    expect(prompt).toContain('读者：它和普通队列有什么区别？');
    expect(prompt).toContain('助教：事件队列把事件作为一等公民');
    expect(prompt).toContain('"skip": false');
  });
});

describe('normalizeDistillResult', () => {
  it('把结论绑定到当前章节并清理空数组', () => {
    const insight = normalizeDistillResult(
      {
        skip: false,
        question: '事件队列和普通队列有什么区别？',
        insight: '事件队列更强调解耦。',
        evidence: ['[§n1]', '对话补充', ''],
        concepts: ['解耦'],
      },
      request(),
    );
    expect(insight).toEqual({
      question: '事件队列和普通队列有什么区别？',
      insight: '事件队列更强调解耦。',
      evidence: ['[§n1]', '对话补充'],
      concepts: ['解耦'],
      outlineId: 'n1',
      sectionTitle: '队列的作用',
    });
  });

  it('允许模型判定没有新增理解', () => {
    expect(normalizeDistillResult({ skip: true, reason: '重复' }, request())).toBeNull();
  });

  it('拒绝缺少结论的 JSON', () => {
    expect(() => normalizeDistillResult({ question: '只有问题' }, request())).toThrow(
      '缺少 question 或 insight',
    );
  });
});

function mockOpenAi(content: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

describe('distillDiscussion', () => {
  it('返回可直接合并到章节的结论', async () => {
    mockOpenAi(
      JSON.stringify({
        skip: false,
        question: '事件队列的真正价值是什么？',
        insight: '把事件生产者和消费者解耦，代价是链路更难追踪。',
        evidence: ['[§n1] 对话补充'],
        concepts: ['解耦', '可观测性'],
      }),
    );
    const insight = await distillDiscussion(request(), provider);
    expect(insight?.outlineId).toBe('n1');
    expect(insight?.insight).toContain('链路更难追踪');
  });

  it('第一次返回坏 JSON 时自动重试一次', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ choices: [{ message: { content: '不是 JSON' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      skip: false,
                      question: '代价是什么？',
                      insight: '调试链路变长。',
                      evidence: ['对话补充'],
                      concepts: ['可观测性'],
                    }),
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    );
    const insight = await distillDiscussion(request(), provider);
    expect(insight?.insight).toBe('调试链路变长。');
  });
});
