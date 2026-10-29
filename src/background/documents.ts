import type {
  BridgeConfig,
  DocumentSettings,
  DocumentTarget,
  DocumentWriteResult,
} from '../shared/types';
import { DOCUMENT_TARGET_LABELS } from '../shared/documents';
import { asErrorMessage } from '../shared/utils';
import { fetchBridge, parseBridgeResponse } from './bridge';

export interface DocumentContext {
  bridge: BridgeConfig;
  documents: DocumentSettings;
}

interface WriteInput {
  target: DocumentTarget;
  title: string;
  markdown: string;
  xml?: string;
}

interface AppendInput {
  target: DocumentTarget;
  documentId: string;
  markdown: string;
  xml?: string;
}

function createPath(target: DocumentTarget): string {
  if (target === 'feishu') return '/api/feishu/docs';
  if (target === 'notion') return '/api/notion/pages';
  return '/api/markdown/notes';
}

function appendPath(target: DocumentTarget): string {
  if (target === 'feishu') return '/api/feishu/docs/__ID__/append';
  if (target === 'notion') return '/api/notion/pages/__ID__/append';
  return '/api/markdown/notes/append';
}

function targetError(target: DocumentTarget, error: unknown): string {
  return `${DOCUMENT_TARGET_LABELS[target]}：${asErrorMessage(error)}`;
}

function normalizeWarnings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        return String(record.message ?? record.msg ?? record.error ?? '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, 20);
}

export async function writeDocument(
  context: DocumentContext,
  input: WriteInput,
): Promise<DocumentWriteResult> {
  try {
    const body: Record<string, unknown> = {
      title: input.title,
      markdown: input.markdown,
    };
    if (input.xml) body.xml = input.xml;
    if (input.target === 'feishu') body.parentToken = context.bridge.parentToken;
    if (input.target === 'notion') body.parentPageId = context.documents.notionParentPageId;
    if (input.target === 'markdown') body.directory = context.documents.markdownDirectory;

    const response = await fetchBridge(context.bridge, createPath(input.target), {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return {
        ok: false,
        target: input.target,
        error: targetError(input.target, data.error ?? `HTTP ${response.status}`),
      };
    }
    const documentId = data.documentId || data.path;
    if (!documentId) {
      return { ok: false, target: input.target, error: `${DOCUMENT_TARGET_LABELS[input.target]}没有返回文档 ID。` };
    }
    return {
      ok: true,
      target: input.target,
      documentId,
      url: data.url ?? '',
      path: data.path,
      warnings: normalizeWarnings(data.warnings),
    };
  } catch (error) {
    return { ok: false, target: input.target, error: targetError(input.target, error) };
  }
}

export async function appendDocument(
  context: DocumentContext,
  input: AppendInput,
): Promise<DocumentWriteResult> {
  try {
    const isMarkdown = input.target === 'markdown';
    const path = isMarkdown
      ? appendPath(input.target)
      : appendPath(input.target).replace('__ID__', encodeURIComponent(input.documentId));
    const body = isMarkdown
      ? { documentId: input.documentId, path: input.documentId, markdown: input.markdown }
      : { markdown: input.markdown, ...(input.xml ? { xml: input.xml } : {}) };
    const response = await fetchBridge(context.bridge, path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      return {
        ok: false,
        target: input.target,
        error: targetError(input.target, data.error ?? `HTTP ${response.status}`),
      };
    }
    return {
      ok: true,
      target: input.target,
      documentId: data.documentId || input.documentId,
      url: data.url ?? '',
      path: data.path,
      warnings: normalizeWarnings(data.warnings),
    };
  } catch (error) {
    return { ok: false, target: input.target, error: targetError(input.target, error) };
  }
}
