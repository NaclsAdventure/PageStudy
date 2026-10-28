import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig } from '../shared/types';
import { requestChat } from './providers';

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function provider(patch: Partial<ProviderConfig> & Pick<ProviderConfig, 'id'>): ProviderConfig {
  return {
    label: patch.id,
    apiKey: 'test-key',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    reasoning: 'default',
    ...patch,
  };
}

function mockJson(payload: unknown): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestChat 推理强度映射', () => {
  it('OpenAI 兼容接口把 xhigh 映射为 high，并带 Bearer Key', async () => {
    const captured = mockJson({ choices: [{ message: { content: '回答' } }] });
    const result = await requestChat({
      provider: provider({ id: 'openai', reasoning: 'xhigh' }),
      system: '系统提示',
      messages: [{ role: 'user', content: '问题' }],
    });
    expect(result.text).toBe('回答');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe('https://api.example.com/v1/chat/completions');
    const headers = captured[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('high');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '问题' },
    ]);
  });

  it('Anthropic 使用 thinking budget，并把预算计入 max_tokens', async () => {
    const captured = mockJson({ content: [{ type: 'text', text: '回答' }] });
    await requestChat({
      provider: provider({ id: 'anthropic', reasoning: 'xhigh', baseUrl: 'https://api.anthropic.com' }),
      system: '系统提示',
      messages: [{ role: 'user', content: '问题' }],
    });
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(captured[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 16384 });
    expect(body.max_tokens).toBe(16384 + 4096);
    expect(body.temperature).toBeUndefined();
  });

  it('Gemini 使用 thinkingConfig，并去掉模型名中的 models/ 前缀', async () => {
    const captured = mockJson({ candidates: [{ content: { parts: [{ text: '回答' }] } }] });
    await requestChat({
      provider: provider({
        id: 'gemini',
        reasoning: 'high',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'models/gemini-test',
      }),
      system: '系统提示',
      messages: [{ role: 'user', content: '问题' }],
    });
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(captured[0].url).toContain('/models/gemini-test:generateContent');
    expect(body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingBudget: 8192 },
    });
  });

  it('default 不发送推理字段', async () => {
    const captured = mockJson({ choices: [{ message: { content: '回答' } }] });
    await requestChat({
      provider: provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }),
      system: '系统提示',
      messages: [{ role: 'user', content: '问题' }],
    });
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(captured[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('推理模型不发送 temperature，避免接口拒绝参数', async () => {
    const captured = mockJson({ choices: [{ message: { content: '回答' } }] });
    await requestChat({
      provider: provider({ id: 'deepseek', model: 'deepseek-reasoner', reasoning: 'high' }),
      system: '系统提示',
      messages: [{ role: 'user', content: '问题' }],
    });
    const body = JSON.parse(String(captured[0].init.body)) as Record<string, unknown>;
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBe('high');
  });

  it('缺少 API Key 时给出可读错误', async () => {
    await expect(
      requestChat({
        provider: provider({ id: 'deepseek', apiKey: '  ' }),
        system: '系统提示',
        messages: [{ role: 'user', content: '问题' }],
      }),
    ).rejects.toThrow('API Key');
  });
});
