import type { ChatHistoryMessage, ProviderConfig } from '../shared/types';
import { asErrorMessage, truncate } from '../shared/utils';

interface RequestChatOptions {
  provider: ProviderConfig;
  system: string;
  messages: ChatHistoryMessage[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** 非流式生成时限制输出长度；知识卡需要比普通聊天更大的预算。 */
  maxTokens?: number;
}

interface ProviderResponse {
  text: string;
  finishReason?: string;
}

export class ProviderError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function openAiEndpoint(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function anthropicEndpoint(baseUrl: string): string {
  const base = trimBase(baseUrl);
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

function geminiEndpoint(baseUrl: string, model: string, stream: boolean): string {
  const base = trimBase(baseUrl);
  const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const modelId = model.trim().replace(/^models\//, '');
  return `${base}/models/${encodeURIComponent(modelId)}:${action}`;
}

function requireApiKey(provider: ProviderConfig): string {
  const key = provider.apiKey.trim();
  if (!key) throw new ProviderError('还没有配置 API Key，请先到设置页填写。');
  return key;
}

function requireModel(provider: ProviderConfig): string {
  const model = provider.model.trim();
  if (!model) throw new ProviderError('还没有配置模型名称，请先到设置页选择或填写模型。');
  return model;
}

function reasoningEffort(provider: ProviderConfig): string | null {
  if (provider.reasoning === 'default') return null;
  if (provider.reasoning === 'xhigh' || provider.reasoning === 'max') return 'high';
  return provider.reasoning;
}

function anthropicBudget(provider: ProviderConfig): number | null {
  switch (provider.reasoning) {
    case 'low':
      return 2048;
    case 'medium':
      return 4096;
    case 'high':
      return 8192;
    case 'xhigh':
      return 16384;
    case 'max':
      return 24576;
    default:
      return null;
  }
}

function geminiThinking(provider: ProviderConfig): Record<string, unknown> | null {
  if (provider.reasoning === 'default') return null;
  const isGemini3 = provider.model.toLowerCase().includes('gemini-3');
  if (isGemini3) {
    const level =
      provider.reasoning === 'low'
        ? 'low'
        : provider.reasoning === 'medium'
          ? 'medium'
          : 'high';
    return { thinkingLevel: level };
  }
  const budget =
    provider.reasoning === 'low'
      ? 1024
      : provider.reasoning === 'medium'
        ? 4096
        : provider.reasoning === 'high'
          ? 8192
          : provider.reasoning === 'xhigh'
            ? 16384
            : 24576;
  return { thinkingBudget: budget };
}

async function readError(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const data = JSON.parse(text) as {
        error?: { message?: string };
        message?: string;
        msg?: string;
      };
      detail = data.error?.message ?? data.message ?? data.msg ?? text;
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  const suffix = detail ? `：${truncate(detail.replace(/\s+/g, ' '), 240)}` : '';
  if (response.status === 401) return `API Key 无效或未授权${suffix}`;
  if (response.status === 403) return `当前 API Key 没有访问该模型的权限${suffix}`;
  if (response.status === 404) return `接口地址或模型不存在，请检查 Base URL 和模型名称${suffix}`;
  if (response.status === 429) return `请求过于频繁或额度不足${suffix}`;
  if (response.status >= 500) return `模型服务暂时不可用（HTTP ${response.status}）${suffix}`;
  return `模型请求失败（HTTP ${response.status}）${suffix}`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new ProviderError(await readError(response), response.status);
  return response.json();
}

async function readSse(
  response: Response,
  onData: (payload: string) => void,
): Promise<void> {
  if (!response.ok) throw new ProviderError(await readError(response), response.status);
  if (!response.body) throw new ProviderError('模型没有返回可读取的流式响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data === '[DONE]') return;
    onData(data);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') {
        flushEvent();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
  flushEvent();
}

function isReasoningModel(model: string): boolean {
  const id = model.toLowerCase();
  return /(^|[/-])(o1|o3|o4)(-|$)/.test(id) || id.includes('reasoner') || id.includes('thinking');
}

function isOpenAiReasoningModel(model: string): boolean {
  return /(^|[/-])(o1|o3|o4)(-|$)/.test(model.toLowerCase());
}

function openAiBody(
  provider: ProviderConfig,
  system: string,
  messages: ChatHistoryMessage[],
  stream: boolean,
  maxTokens?: number,
) {
  const body: Record<string, unknown> = {
    model: requireModel(provider),
    messages: [{ role: 'system', content: system }, ...messages],
    stream,
  };
  if (maxTokens && !stream) {
    // OpenAI 的 o 系列推理模型改用 max_completion_tokens，仍发送 max_tokens 会被拒绝。
    if (isOpenAiReasoningModel(provider.model)) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }
  // 部分推理模型（o1/o3、deepseek-reasoner 等）不接受 temperature 参数。
  if (!isReasoningModel(provider.model)) body.temperature = 0.6;
  const effort = reasoningEffort(provider);
  if (effort) body.reasoning_effort = effort;
  return body;
}

async function requestOpenAi(options: RequestChatOptions): Promise<ProviderResponse> {
  const { provider, system, messages, signal, onDelta, maxTokens } = options;
  const key = requireApiKey(provider);
  const stream = Boolean(onDelta);
  const response = await fetch(openAiEndpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(openAiBody(provider, system, messages, stream, maxTokens)),
    signal,
  });

  if (!stream) {
    const data = (await fetchJsonFromResponse(response)) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content?.trim() ?? '';
    if (!text) throw new ProviderError('模型返回了空内容。');
    return { text, finishReason: choice?.finish_reason };
  }

  let text = '';
  await readSse(response, (payload) => {
    try {
      const data = JSON.parse(payload) as {
        choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
      };
      const delta = data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.message?.content ?? '';
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
    } catch {
      // 某些兼容接口会发送心跳或非 JSON 事件，跳过。
    }
  });
  if (!text.trim()) throw new ProviderError('模型返回了空内容。');
  return { text };
}

async function fetchJsonFromResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new ProviderError(await readError(response), response.status);
  return response.json();
}

async function requestAnthropic(options: RequestChatOptions): Promise<ProviderResponse> {
  const { provider, system, messages, signal, onDelta, maxTokens } = options;
  const key = requireApiKey(provider);
  const stream = Boolean(onDelta);
  const budget = anthropicBudget(provider);
  const outputLimit = Math.max(maxTokens ?? 0, budget ? budget + 4096 : 4096);
  const body: Record<string, unknown> = {
    model: requireModel(provider),
    system,
    messages: messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    })),
    max_tokens: outputLimit,
    stream,
  };
  if (budget) {
    body.thinking = { type: 'enabled', budget_tokens: budget };
  } else {
    body.temperature = 0.6;
  }

  const response = await fetch(anthropicEndpoint(provider.baseUrl), {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!stream) {
    const data = (await fetchJsonFromResponse(response)) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
    };
    const text = (data.content ?? [])
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('')
      .trim();
    if (!text) throw new ProviderError('模型返回了空内容。');
    return { text, finishReason: data.stop_reason };
  }

  let text = '';
  await readSse(response, (payload) => {
    try {
      const data = JSON.parse(payload) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta' && data.delta.text) {
        text += data.delta.text;
        onDelta?.(data.delta.text);
      }
    } catch {
      // 跳过非 JSON 事件。
    }
  });
  if (!text.trim()) throw new ProviderError('模型返回了空内容。');
  return { text };
}

async function requestGemini(options: RequestChatOptions): Promise<ProviderResponse> {
  const { provider, system, messages, signal, onDelta, maxTokens } = options;
  const key = requireApiKey(provider);
  const stream = Boolean(onDelta);
  const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens ?? 8192 };
  const thinking = geminiThinking(provider);
  if (thinking) {
    generationConfig.thinkingConfig = thinking;
  } else {
    generationConfig.temperature = 0.6;
  }

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    generationConfig,
  };

  const response = await fetch(geminiEndpoint(provider.baseUrl, requireModel(provider), stream), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!stream) {
    const data = (await fetchJsonFromResponse(response)) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('')
      .trim();
    if (!text) throw new ProviderError('模型返回了空内容。');
    return { text, finishReason: candidate?.finishReason };
  }

  let text = '';
  await readSse(response, (payload) => {
    try {
      const data = JSON.parse(payload) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const delta = (data.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? '')
        .join('');
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
    } catch {
      // 跳过非 JSON 事件。
    }
  });
  if (!text.trim()) throw new ProviderError('模型返回了空内容。');
  return { text };
}

export async function requestChat(options: RequestChatOptions): Promise<ProviderResponse> {
  try {
    switch (options.provider.id) {
      case 'anthropic':
        return await requestAnthropic(options);
      case 'gemini':
        return await requestGemini(options);
      case 'deepseek':
      case 'openai':
      case 'custom':
      default:
        return await requestOpenAi(options);
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError('已停止生成。');
    }
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`模型请求失败：${asErrorMessage(error)}`);
  }
}

export async function fetchModels(provider: ProviderConfig): Promise<Array<{ id: string; label: string }>> {
  const key = requireApiKey(provider);
  if (provider.id === 'anthropic') {
    const base = trimBase(provider.baseUrl);
    const response = await fetch(`${base.endsWith('/v1') ? base : `${base}/v1`}/models?limit=1000`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    const data = (await fetchJsonFromResponse(response)) as { data?: Array<{ id?: string; display_name?: string }> };
    return (data.data ?? [])
      .filter((item) => item.id)
      .map((item) => ({ id: item.id as string, label: item.display_name ?? (item.id as string) }));
  }

  if (provider.id === 'gemini') {
    const base = trimBase(provider.baseUrl);
    const response = await fetch(`${base}/models?pageSize=1000`, {
      headers: { 'x-goog-api-key': key },
    });
    const data = (await fetchJsonFromResponse(response)) as {
      models?: Array<{ name?: string; displayName?: string; supportedGenerationMethods?: string[] }>;
    };
    return (data.models ?? [])
      .filter((item) => item.name)
      .map((item) => ({
        id: (item.name as string).replace(/^models\//, ''),
        label: item.displayName ?? (item.name as string),
      }));
  }

  const base = trimBase(provider.baseUrl);
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = (await fetchJsonFromResponse(response)) as {
    data?: Array<{ id?: string }>;
    models?: Array<{ id?: string; name?: string }>;
  };
  const list = (data.data ?? data.models ?? []) as Array<{ id?: string; name?: string }>;
  return list
    .map((item) => ({
      id: item.id ?? item.name ?? '',
      label: item.id ?? item.name ?? '',
    }))
    .filter((item) => item.id);
}

export async function testProvider(provider: ProviderConfig): Promise<string> {
  const result = await requestChat({
    provider,
    system: '你是一个连接测试助手。',
    messages: [{ role: 'user', content: '只回复“连接成功”四个字。' }],
  });
  return truncate(result.text.trim(), 80);
}
