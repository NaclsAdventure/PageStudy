import type {
  BridgeHealth,
  ChatRequest,
  ChatStreamEvent,
  DocumentTarget,
  DocumentWriteResult,
  FeishuWriteResult,
  FeishuWikiState,
  ModelOption,
  PageContext,
  PageSummary,
  SelectionContext,
  Settings,
  StudyRecord,
  SummaryRequest,
  WikiPublishResponse,
} from './types';

export type RuntimeMessage =
  | { type: 'PS_PING' }
  | { type: 'PS_GET_SETTINGS' }
  | { type: 'PS_GET_PUBLIC_SETTINGS' }
  | { type: 'PS_SAVE_SETTINGS'; settings: Settings }
  | { type: 'PS_FETCH_MODELS' }
  | { type: 'PS_TEST_PROVIDER' }
  | { type: 'PS_SUMMARIZE'; request: SummaryRequest }
  | { type: 'PS_BRIDGE_HEALTH' }
  | { type: 'PS_WRITE_DOCUMENT'; target: DocumentTarget; title: string; markdown: string; recordId?: string }
  | { type: 'PS_APPEND_DOCUMENT'; target: DocumentTarget; documentId: string; markdown: string; recordId?: string }
  | { type: 'PS_WRITE_FEISHU'; title: string; markdown: string; parentToken?: string }
  | { type: 'PS_APPEND_FEISHU'; documentId: string; markdown: string }
  | { type: 'PS_ENQUEUE_SYNC'; recordId: string; target?: DocumentTarget }
  | { type: 'PS_FLUSH_SYNC' }
  | { type: 'PS_PUBLISH_WIKI' }
  | { type: 'PS_REQUEST_WIKI_PUBLISH' }
  | { type: 'PS_GET_WIKI_STATE' }
  | { type: 'PS_GET_RECORD'; recordId: string }
  | { type: 'PS_OPEN_PANEL' }
  | { type: 'PS_SELECTION_CHANGED'; selection: SelectionContext | null; tabId?: number };

export type ContentMessage =
  | { type: 'PS_GET_PAGE_CONTEXT' }
  | { type: 'PS_GET_SELECTION' }
  | { type: 'PS_SCROLL_TO_ANCHOR'; anchor: string }
  | { type: 'PS_PING_CONTENT' };

export interface PageContextResponse {
  ok: boolean;
  page?: PageContext;
  error?: string;
}

export interface SelectionResponse {
  ok: boolean;
  selection?: SelectionContext | null;
  error?: string;
}

export interface SummarizeResponse {
  ok: boolean;
  summary?: PageSummary;
  error?: string;
}

export interface ModelsResponse {
  ok: boolean;
  models?: ModelOption[];
  error?: string;
}

export interface TestProviderResponse {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface BridgeHealthResponse extends BridgeHealth {}

export interface FeishuWriteResponse extends FeishuWriteResult {}

export interface DocumentWriteResponse extends DocumentWriteResult {}

export interface RecordResponse {
  ok: boolean;
  record?: StudyRecord;
  error?: string;
}

export interface SyncEnqueueResponse {
  ok: boolean;
  queued?: boolean;
  target?: DocumentTarget;
  error?: string;
}

export interface WikiPublishMessageResponse extends WikiPublishResponse {}

export interface WikiStateResponse {
  ok: boolean;
  state?: FeishuWikiState | null;
  error?: string;
}

export interface WikiQueueResponse {
  ok: boolean;
  queued?: boolean;
  error?: string;
}

export type BackgroundResponse = unknown;

export type ChatPortRequest =
  | { type: 'chat.start'; payload: ChatRequest }
  | { type: 'chat.abort'; requestId: string };

export type ChatPortEvent = ChatStreamEvent;

export async function sendRuntimeMessage<T = unknown>(message: RuntimeMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

export async function sendTabMessage<T = unknown>(
  tabId: number,
  message: ContentMessage,
): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}
