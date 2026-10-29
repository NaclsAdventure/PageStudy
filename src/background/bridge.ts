import type { BridgeConfig, BridgeHealth } from '../shared/types';
import { asErrorMessage, truncate } from '../shared/utils';

interface BridgeHealthPayload {
  ok?: boolean;
  url?: string;
  documentId?: string;
  path?: string;
  error?: string;
  version?: string;
  larkCli?: boolean;
  wiki?: boolean;
  notion?: boolean;
  markdown?: boolean;
  markdownDir?: string;
  warnings?: unknown;
}

export function bridgeBase(config: BridgeConfig): string {
  const url = config.url.trim().replace(/\/+$/, '');
  if (!url) throw new Error('还没有配置本地文档桥接服务地址。');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('本地文档桥接服务地址格式不正确。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('本地文档桥接服务地址必须使用 http 或 https。');
  }
  return url;
}

export async function fetchBridge(
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
      throw new Error('本地文档桥接服务响应超时。请检查桥接是否在运行。');
    }
    throw new Error(
      `无法连接本地文档桥接服务。请先在项目目录运行 npm run bridge。原始错误：${asErrorMessage(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function parseBridgeResponse(response: Response): Promise<BridgeHealthPayload> {
  const text = await response.text();
  try {
    return JSON.parse(text) as BridgeHealthPayload;
  } catch {
    throw new Error(`文档桥接返回了非 JSON 内容：${truncate(text, 200)}`);
  }
}

export async function checkBridge(config: BridgeConfig): Promise<BridgeHealth> {
  try {
    const response = await fetchBridge(config, '/health', { method: 'GET' }, 10_000);
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return {
        ok: false,
        larkCli: Boolean(data.larkCli),
        wiki: Boolean(data.wiki),
        notion: Boolean(data.notion),
        markdown: Boolean(data.markdown),
        markdownDir: data.markdownDir,
        error: data.error ?? `HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      larkCli: Boolean(data.larkCli),
      wiki: Boolean(data.wiki),
      notion: Boolean(data.notion),
      markdown: Boolean(data.markdown),
      markdownDir: data.markdownDir,
      version: data.version,
    };
  } catch (error) {
    return { ok: false, larkCli: false, wiki: false, notion: false, markdown: false, error: asErrorMessage(error) };
  }
}
