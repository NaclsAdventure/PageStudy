import type {
  DocumentRef,
  DocumentSyncState,
  DocumentTarget,
  StudyRecord,
} from './types';

export const DOCUMENT_TARGETS: DocumentTarget[] = ['feishu', 'notion', 'markdown'];

export const DOCUMENT_TARGET_LABELS: Record<DocumentTarget, string> = {
  feishu: '飞书文档',
  notion: 'Notion',
  markdown: '本地 Markdown',
};

export const DOCUMENT_TARGET_SHORT_LABELS: Record<DocumentTarget, string> = {
  feishu: '飞书',
  notion: 'Notion',
  markdown: '本地',
};

export function isDocumentTarget(value: unknown): value is DocumentTarget {
  return typeof value === 'string' && DOCUMENT_TARGETS.includes(value as DocumentTarget);
}

export function documentTargetLabel(target: DocumentTarget): string {
  return DOCUMENT_TARGET_LABELS[target];
}

export function getDocumentRef(record: StudyRecord, target: DocumentTarget): DocumentRef | null {
  const current = record.documents?.[target];
  if (current) return current;
  if (target === 'feishu' && record.feishu) {
    return {
      target: 'feishu',
      documentId: record.feishu.documentId,
      url: record.feishu.url,
      writtenAt: record.feishu.writtenAt,
      title: record.page.title,
    };
  }
  return null;
}

export function getAllDocumentRefs(record: StudyRecord): DocumentRef[] {
  return DOCUMENT_TARGETS.map((target) => getDocumentRef(record, target)).filter(
    (ref): ref is DocumentRef => Boolean(ref),
  );
}

export function withDocumentRef(
  record: StudyRecord,
  ref: DocumentRef,
  now = Date.now(),
): StudyRecord {
  const previous = record.documents?.[ref.target];
  // 追加接口通常只返回 documentId，不重复返回页面 URL；必须保留旧链接。
  const mergedRef: DocumentRef = {
    ...ref,
    url: ref.url || previous?.url || (ref.target === 'feishu' ? record.feishu?.url ?? '' : ''),
  };
  const documents = { ...(record.documents ?? {}), [ref.target]: mergedRef };
  const sync = { ...(record.sync ?? {}) };
  sync[ref.target] = {
    status: 'synced',
    attempts: 0,
    updatedAt: now,
  };
  return {
    ...record,
    documents,
    sync,
    feishu:
      ref.target === 'feishu'
        ? { url: mergedRef.url, documentId: mergedRef.documentId, writtenAt: mergedRef.writtenAt }
        : record.feishu,
    updatedAt: now,
  };
}

export function withDocumentSyncState(
  record: StudyRecord,
  target: DocumentTarget,
  state: DocumentSyncState,
): StudyRecord {
  return {
    ...record,
    sync: { ...(record.sync ?? {}), [target]: state },
    updatedAt: Date.now(),
  };
}

export function clearDocumentSyncState(record: StudyRecord, target: DocumentTarget): StudyRecord {
  const sync = { ...(record.sync ?? {}) };
  delete sync[target];
  return { ...record, sync, updatedAt: Date.now() };
}

export function mergeDocumentRefs(
  existing: Partial<Record<DocumentTarget, DocumentRef>> | undefined,
  incoming: Partial<Record<DocumentTarget, DocumentRef>> | undefined,
): Partial<Record<DocumentTarget, DocumentRef>> | undefined {
  if (!existing && !incoming) return undefined;
  const merged: Partial<Record<DocumentTarget, DocumentRef>> = { ...(existing ?? {}) };
  for (const target of DOCUMENT_TARGETS) {
    const next = incoming?.[target];
    if (!next) continue;
    const previous = merged[target];
    // 后台自动同步可能比侧栏的本地状态更新；同一目标保留写入时间较新的引用。
    if (!previous || next.writtenAt >= previous.writtenAt) merged[target] = next;
  }
  return merged;
}

export function mergeSyncStates(
  existing: Partial<Record<DocumentTarget, DocumentSyncState>> | undefined,
  incoming: Partial<Record<DocumentTarget, DocumentSyncState>> | undefined,
): Partial<Record<DocumentTarget, DocumentSyncState>> | undefined {
  if (!existing && !incoming) return undefined;
  const merged: Partial<Record<DocumentTarget, DocumentSyncState>> = { ...(existing ?? {}) };
  for (const target of DOCUMENT_TARGETS) {
    const next = incoming?.[target];
    if (!next) continue;
    const previous = merged[target];
    if (!previous || next.updatedAt >= previous.updatedAt) merged[target] = next;
  }
  return merged;
}

export function syncStateText(state: DocumentSyncState | undefined): string {
  if (!state) return '';
  if (state.status === 'synced') return '已自动同步';
  if (state.status === 'pending') return '等待同步';
  return state.lastError ? `同步失败：${state.lastError}` : '同步失败';
}
