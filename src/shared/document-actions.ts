import type { DocumentTarget, DocumentWriteResult, StudyRecord } from './types';
import { getDocumentRef } from './documents';
import { recordToFeishuAppendXml, recordToFeishuXml } from './feishu-xml';
import { recordToAppendMarkdown, recordToDocumentTitle, recordToMarkdown } from './markdown';
import { sendRuntimeMessage, type DocumentWriteResponse } from './messages';

export type DocumentWriteMode = 'auto' | 'create' | 'append';

export async function writeRecordToDocument(
  record: StudyRecord,
  target: DocumentTarget,
  mode: DocumentWriteMode = 'auto',
): Promise<DocumentWriteResult> {
  const existing = getDocumentRef(record, target);
  const shouldAppend = mode === 'append' || (mode === 'auto' && Boolean(existing));
  const response = shouldAppend
    ? await sendRuntimeMessage<DocumentWriteResponse>({
        type: 'PS_APPEND_DOCUMENT',
        target,
        documentId: existing?.documentId ?? '',
        markdown: recordToAppendMarkdown(record),
        xml: target === 'feishu' ? recordToFeishuAppendXml(record) : undefined,
        recordId: record.id,
      })
    : await sendRuntimeMessage<DocumentWriteResponse>({
        type: 'PS_WRITE_DOCUMENT',
        target,
        title: recordToDocumentTitle(record),
        markdown: recordToMarkdown(record),
        xml: target === 'feishu' ? recordToFeishuXml(record) : undefined,
        recordId: record.id,
      });
  return response;
}
