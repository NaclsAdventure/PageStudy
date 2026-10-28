import {
  WIKI_QUEUE_KEY,
  WIKI_SYNC_ALARM,
} from '../shared/constants';
import { listRecords } from '../shared/db';
import { loadSettings } from '../shared/settings';
import type { FeishuWikiState, WikiPublishResponse } from '../shared/types';
import { asErrorMessage } from '../shared/utils';
import { buildWiki } from '../shared/wiki';
import {
  buildWikiPublishRequest,
  loadWikiState,
  normalizeWikiState,
  saveWikiState,
} from '../shared/wiki-documents';
import { fetchBridge, parseBridgeResponse } from './bridge';

interface WikiQueueJob {
  requestedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}

let wikiDraining = false;
let wikiInFlight: Promise<WikiPublishResponse> | null = null;

async function loadQueue(): Promise<WikiQueueJob | null> {
  const stored = await chrome.storage.local.get(WIKI_QUEUE_KEY);
  const raw = stored[WIKI_QUEUE_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  return {
    requestedAt: typeof value.requestedAt === 'number' ? value.requestedAt : Date.now(),
    attempts: typeof value.attempts === 'number' ? value.attempts : 0,
    nextAttemptAt: typeof value.nextAttemptAt === 'number' ? value.nextAttemptAt : Date.now(),
    lastError: typeof value.lastError === 'string' ? value.lastError : undefined,
  };
}

async function saveQueue(queue: WikiQueueJob | null): Promise<void> {
  if (!queue) {
    await chrome.storage.local.remove(WIKI_QUEUE_KEY);
    await chrome.alarms.clear(WIKI_SYNC_ALARM);
    return;
  }
  await chrome.storage.local.set({ [WIKI_QUEUE_KEY]: queue });
  await chrome.alarms.create(WIKI_SYNC_ALARM, {
    when: Math.max(Date.now() + 500, queue.nextAttemptAt),
  });
}

async function saveBridgeState(response: WikiPublishResponse): Promise<FeishuWikiState | null> {
  const state = normalizeWikiState(response.state);
  if (!state) return null;
  const next: FeishuWikiState = {
    ...state,
    lastError: response.ok ? undefined : response.error,
  };
  await saveWikiState(next);
  return next;
}

async function doPublishWiki(): Promise<WikiPublishResponse> {
  const settings = await loadSettings();
  const records = await listRecords();
  if (records.length === 0) {
    return { ok: false, error: '还没有学习记录，暂时不能发布 Wiki。' };
  }
  const index = buildWiki(records);
  if (index.pages.length === 0) {
    return { ok: false, error: '本地 Wiki 还没有可发布的页面。' };
  }
  const state = await loadWikiState();
  const request = buildWikiPublishRequest(index, state);
  try {
    const response = await fetchBridge(settings.feishu, '/api/feishu/wiki/publish', {
      method: 'POST',
      body: JSON.stringify(request),
    });
    const data = (await parseBridgeResponse(response)) as unknown as WikiPublishResponse;
    if (!response.ok) {
      const result: WikiPublishResponse = {
        ok: false,
        state: data.state,
        error: data.error || `桥接返回 HTTP ${response.status}`,
      };
      await saveBridgeState(result);
      return result;
    }
    const result: WikiPublishResponse = {
      ok: data.ok !== false,
      state: data.state,
      created: data.created,
      updated: data.updated,
      skipped: data.skipped,
      error: data.error,
    };
    await saveBridgeState(result);
    return result;
  } catch (error) {
    return { ok: false, error: `飞书 Wiki：${asErrorMessage(error)}` };
  }
}

export async function publishWikiNow(): Promise<WikiPublishResponse> {
  if (wikiInFlight) return wikiInFlight;
  wikiInFlight = doPublishWiki().finally(() => {
    wikiInFlight = null;
  });
  return wikiInFlight;
}

export async function requestWikiPublish(): Promise<{ ok: boolean; queued: boolean }> {
  const settings = await loadSettings();
  if (!settings.documents.wikiAutoSync) return { ok: true, queued: false };
  const records = await listRecords();
  if (records.length === 0) return { ok: true, queued: false };
  const previous = await loadQueue();
  const now = Date.now();
  await saveQueue({
    requestedAt: now,
    attempts: previous?.attempts ?? 0,
    nextAttemptAt: now + 8000,
    lastError: previous?.lastError,
  });
  return { ok: true, queued: true };
}

export async function flushWikiQueue(force = false): Promise<number> {
  if (wikiDraining) return 0;
  wikiDraining = true;
  try {
    const queue = await loadQueue();
    if (!queue) return 0;
    if (!force && queue.nextAttemptAt > Date.now()) {
      // 闹钟偶尔会早于 when 触发；重新挂上下一次，避免队列停住。
      await saveQueue(queue);
      return 0;
    }
    const result = await publishWikiNow();
    if (result.ok) {
      await saveQueue(null);
      return result.updated ?? result.created ?? 0;
    }
    const attempts = queue.attempts + 1;
    const delay = 15_000 * 2 ** Math.min(attempts - 1, 5);
    await saveQueue({
      requestedAt: queue.requestedAt,
      attempts,
      nextAttemptAt: Date.now() + delay,
      lastError: result.error,
    });
    return 0;
  } catch (error) {
    const attempts = 1;
    await saveQueue({
      requestedAt: Date.now(),
      attempts,
      nextAttemptAt: Date.now() + 15_000,
      lastError: asErrorMessage(error),
    });
    return 0;
  } finally {
    wikiDraining = false;
  }
}

export async function getWikiPublishState(): Promise<FeishuWikiState | null> {
  return loadWikiState();
}

export async function wikiQueueStatus(): Promise<{ pending: number; error: number }> {
  const queue = await loadQueue();
  return {
    pending: queue && !queue.lastError ? 1 : 0,
    error: queue?.lastError ? 1 : 0,
  };
}

export async function clearWikiQueue(): Promise<void> {
  await saveQueue(null);
}
