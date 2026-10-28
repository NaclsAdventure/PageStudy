import { SYNC_ALARM, SYNC_QUEUE_KEY } from '../shared/constants';
import {
  getDocumentRef,
  withDocumentRef,
  withDocumentSyncState,
} from '../shared/documents';
import { getRecord, saveRecord } from '../shared/db';
import { recordToAppendMarkdown, recordToDocumentTitle, recordToMarkdown } from '../shared/markdown';
import { loadSettings } from '../shared/settings';
import type { DocumentTarget, StudyRecord } from '../shared/types';
import { asErrorMessage } from '../shared/utils';
import { appendDocument, writeDocument, type DocumentContext } from './documents';
import type { SyncEnqueueResponse } from '../shared/messages';

interface SyncJob {
  recordId: string;
  target: DocumentTarget;
  attempts: number;
  enqueuedAt: number;
  nextAttemptAt: number;
  lastError?: string;
}

type SyncQueue = Record<string, SyncJob>;

let draining = false;
let drainAgain = false;

function jobKey(recordId: string, target: DocumentTarget): string {
  return `${recordId}:${target}`;
}

async function loadQueue(): Promise<SyncQueue> {
  const stored = await chrome.storage.local.get(SYNC_QUEUE_KEY);
  const raw = stored[SYNC_QUEUE_KEY];
  return raw && typeof raw === 'object' ? (raw as SyncQueue) : {};
}

async function saveQueue(queue: SyncQueue): Promise<void> {
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
  await scheduleNextAlarm(queue);
}

function earliestDue(queue: SyncQueue): number | null {
  const times = Object.values(queue).map((job) => job.nextAttemptAt);
  return times.length > 0 ? Math.min(...times) : null;
}

async function scheduleNextAlarm(queue: SyncQueue): Promise<void> {
  const due = earliestDue(queue);
  if (due === null) {
    await chrome.alarms.clear(SYNC_ALARM);
    return;
  }
  await chrome.alarms.create(SYNC_ALARM, { when: Math.max(Date.now() + 500, due) });
}

async function mergeAndSaveQueue(
  localQueue: SyncQueue,
  processed: Map<string, number>,
): Promise<void> {
  const storedQueue = await loadQueue();
  const merged: SyncQueue = { ...localQueue };
  for (const [key, storedJob] of Object.entries(storedQueue)) {
    const localJob = merged[key];
    if (!localJob) {
      // 如果本地任务是刚刚成功删除的旧版本，不要从存储里复活；
      // 但同步期间新入队的版本必须保留。
      const processedAt = processed.get(key);
      if (processedAt !== undefined && storedJob.enqueuedAt <= processedAt) continue;
      merged[key] = storedJob;
    } else if (storedJob.enqueuedAt > localJob.enqueuedAt) {
      merged[key] = storedJob;
    }
  }
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: merged });
  await scheduleNextAlarm(merged);
}

async function contextForSettings(): Promise<DocumentContext> {
  const settings = await loadSettings();
  return { bridge: settings.feishu, documents: settings.documents };
}

async function markPending(recordId: string, target: DocumentTarget): Promise<void> {
  const current = await getRecord(recordId);
  if (!current) return;
  await saveRecord(
    withDocumentSyncState(current, target, {
      status: 'pending',
      attempts: 0,
      updatedAt: Date.now(),
    }),
  );
}

export async function enqueueRecordSync(
  recordId: string,
  requestedTarget?: DocumentTarget,
): Promise<SyncEnqueueResponse> {
  const settings = await loadSettings();
  if (!settings.documents.autoSync) {
    return { ok: true, queued: false };
  }
  const target = requestedTarget ?? settings.documents.defaultTarget;
  const queue = await loadQueue();
  const key = jobKey(recordId, target);
  const current = queue[key];
  queue[key] = {
    recordId,
    target,
    attempts: current?.attempts ?? 0,
    enqueuedAt: current?.enqueuedAt ?? Date.now(),
    nextAttemptAt: Date.now(),
    lastError: current?.lastError,
  };
  await saveQueue(queue);
  await markPending(recordId, target);
  // 立即尝试一次；失败后由 alarm 退避重试，不阻塞侧栏保存。
  void flushSyncQueue();
  return { ok: true, queued: true, target };
}

export async function removeRecordSyncJob(recordId: string, target: DocumentTarget): Promise<void> {
  const queue = await loadQueue();
  delete queue[jobKey(recordId, target)];
  await saveQueue(queue);
}

async function syncJob(job: SyncJob, context: DocumentContext): Promise<DocumentWriteResultLike> {
  const record = await getRecord(job.recordId);
  if (!record) throw new Error('记录已不存在，跳过同步。');
  const existing = getDocumentRef(record, job.target);
  if (existing) {
    const result = await appendDocument(context, {
      target: job.target,
      documentId: existing.documentId,
      markdown: recordToAppendMarkdown(record),
    });
    if (!result.ok) throw new Error(result.error ?? '追加失败');
    return { ...result, title: existing.title ?? recordToDocumentTitle(record) };
  }
  const result = await writeDocument(context, {
    target: job.target,
    title: recordToDocumentTitle(record),
    markdown: recordToMarkdown(record),
  });
  if (!result.ok) throw new Error(result.error ?? '创建失败');
  return result;
}

interface DocumentWriteResultLike {
  ok: boolean;
  target: DocumentTarget;
  documentId?: string;
  url?: string;
  path?: string;
  title?: string;
}

export async function flushSyncQueue(force = false): Promise<number> {
  if (draining) {
    drainAgain = true;
    return 0;
  }
  draining = true;
  let synced = 0;
  try {
    const queue = await loadQueue();
    const context = await contextForSettings();
    const jobs = Object.entries(queue).sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt);
    // 成功/删除的任务在本地 queue 中移除；如果同步期间用户又保存了一次，会生成
    // 更新的同 key 任务。保存时必须合并而不是直接覆盖，否则会丢掉新任务。
    const processed = new Map<string, number>();

    for (const [key, job] of jobs) {
      if (!force && job.nextAttemptAt > Date.now()) continue;
      const currentRecord = await getRecord(job.recordId);
      if (!currentRecord) {
        // 记录已删除，重试没有意义；清理任务，避免永久占用队列。
        processed.set(key, job.enqueuedAt);
        delete queue[key];
        await mergeAndSaveQueue(queue, processed);
        continue;
      }
      try {
        const result = await syncJob(job, context);
        const record = await getRecord(job.recordId);
        if (record) {
          await saveRecord(
            withDocumentRef(record, {
              target: job.target,
              documentId: result.documentId ?? '',
              url: result.url ?? '',
              writtenAt: Date.now(),
              title: result.title ?? recordToDocumentTitle(record),
            }),
          );
        }
        processed.set(key, job.enqueuedAt);
        delete queue[key];
        synced += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        const delay = Math.min(30 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 5));
        queue[key] = {
          ...job,
          attempts,
          nextAttemptAt: Date.now() + delay,
          lastError: asErrorMessage(error).slice(0, 800),
        };
        const record = await getRecord(job.recordId);
        if (record) {
          await saveRecord(
            withDocumentSyncState(record, job.target, {
              status: 'error',
              attempts,
              lastError: queue[key].lastError,
              nextAttemptAt: queue[key].nextAttemptAt,
              updatedAt: Date.now(),
            }),
          );
        }
      }
      await mergeAndSaveQueue(queue, processed);
    }
    await mergeAndSaveQueue(queue, processed);
    return synced;
  } catch (error) {
    // alarm/启动钩子里的异常不能变成未处理的 Promise 拒绝。
    console.error('PageStudy 自动同步队列处理失败：', error);
    return 0;
  } finally {
    draining = false;
    if (drainAgain) {
      drainAgain = false;
      void flushSyncQueue();
    }
  }
}

export async function autoSyncStatus(): Promise<{ pending: number; error: number }> {
  const queue = await loadQueue();
  const jobs = Object.values(queue);
  return {
    pending: jobs.filter((job) => !job.lastError).length,
    error: jobs.filter((job) => Boolean(job.lastError)).length,
  };
}
