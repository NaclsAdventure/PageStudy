import type { BridgeConfig, BridgeHealth, FeishuWriteResult } from '../shared/types';
import { asErrorMessage, truncate } from '../shared/utils';

interface BridgeResponse {
  ok?: boolean;
  url?: string;
  documentId?: string;
  error?: string;
  version?: string;
  larkCli?: boolean;
}

function bridgeBase(config: BridgeConfig): string {
  const url = config.url.trim().replace(/\/+$/, '');
  if (!url) throw new Error('还没有配置飞书桥接服务地址。');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('飞书桥接服务地址格式不正确。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('飞书桥接服务地址必须使用 http 或 https。');
  }
  return url;
}

async function fetchBridge(
  config: BridgeConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 150_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (config.token.trim()) headers.set('x-pagestudy-token', config.token.trim());
    return await fetch(`${bridgeBase(config)}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('飞书桥接服务响应超时。请检查本地桥接是否在运行。');
    }
    throw new Error(
      `无法连接飞书桥接服务。请先在项目目录运行 npm run bridge。原始错误：${asErrorMessage(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function parseBridgeResponse(response: Response): Promise<BridgeResponse> {
  const text = await response.text();
  try {
    return JSON.parse(text) as BridgeResponse;
  } catch {
    throw new Error(`飞书桥接返回了非 JSON 内容：${truncate(text, 200)}`);
  }
}

export async function checkBridge(config: BridgeConfig): Promise<BridgeHealth> {
  try {
    const response = await fetchBridge(config, '/health', { method: 'GET' }, 10_000);
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return { ok: false, larkCli: Boolean(data.larkCli), error: data.error ?? `HTTP ${response.status}` };
    }
    return { ok: true, larkCli: Boolean(data.larkCli), version: data.version };
  } catch (error) {
    return { ok: false, larkCli: false, error: asErrorMessage(error) };
  }
}

export async function appendFeishuDocument(
  config: BridgeConfig,
  input: { documentId: string; markdown: string },
): Promise<FeishuWriteResult> {
  try {
    const response = await fetchBridge(
      config,
      `/api/feishu/docs/${encodeURIComponent(input.documentId)}/append`,
      {
        method: 'POST',
        body: JSON.stringify({ markdown: input.markdown }),
      },
    );
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return { ok: false, error: data.error ?? `飞书追加失败（HTTP ${response.status}）` };
    }
    return { ok: true, documentId: data.documentId || input.documentId };
  } catch (error) {
    return { ok: false, error: asErrorMessage(error) };
  }
}

export async function writeFeishuDocument(
  config: BridgeConfig,
  input: { title: string; markdown: string; parentToken?: string },
): Promise<FeishuWriteResult> {
  try {
    const response = await fetchBridge(config, '/api/feishu/docs', {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        markdown: input.markdown,
        parentToken: input.parentToken?.trim() || config.parentToken.trim() || undefined,
      }),
    });
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return { ok: false, error: data.error ?? `飞书写入失败（HTTP ${response.status}）` };
    }
    if (!data.documentId) {
      return { ok: false, error: '飞书桥接没有返回 documentId。' };
    }
    return {
      ok: true,
      documentId: data.documentId,
      url: data.url ?? '',
    };
  } catch (error) {
    return { ok: false, error: asErrorMessage(error) };
  }
}
