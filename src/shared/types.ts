export type ProviderId = 'deepseek' | 'openai' | 'anthropic' | 'gemini' | 'custom';

export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoning: ReasoningEffort;
}

export interface BridgeConfig {
  url: string;
  token: string;
  parentToken: string;
}

export type DocumentTarget = 'feishu' | 'notion' | 'markdown';

export interface DocumentSettings {
  autoSync: boolean;
  wikiAutoSync: boolean;
  defaultTarget: DocumentTarget;
  notionParentPageId: string;
  markdownDirectory: string;
}

export interface DocumentRef {
  target: DocumentTarget;
  documentId: string;
  url: string;
  writtenAt: number;
  title?: string;
}

export interface DocumentSyncState {
  status: 'pending' | 'synced' | 'error';
  attempts: number;
  lastError?: string;
  nextAttemptAt?: number;
  updatedAt: number;
}

export type WikiCategoryKey = 'records' | 'tags' | 'concepts';

export interface WikiNodeRef {
  nodeToken: string;
  objToken: string;
  url: string;
}

export interface WikiCategoryRef extends WikiNodeRef {
  title: string;
  hash: string;
}

export interface WikiPageRef extends WikiNodeRef {
  pageId: string;
  title: string;
  kind: 'note' | 'tag' | 'concept';
  hash: string;
}

/** 飞书个人文档库中的 PageStudy Wiki 映射；只保存 token 和哈希，不保存正文。 */
export interface FeishuWikiState {
  schemaVersion: 1;
  target: 'feishu';
  spaceId: string;
  root: WikiCategoryRef;
  categories: Partial<Record<WikiCategoryKey, WikiCategoryRef>>;
  pages: Record<string, WikiPageRef>;
  lastPublishedAt?: number;
  lastError?: string;
}

export interface WikiPublishCategory {
  key: WikiCategoryKey;
  title: string;
  markdown: string;
  hash: string;
}

export interface WikiPublishPage {
  id: string;
  kind: 'note' | 'tag' | 'concept';
  category: WikiCategoryKey;
  title: string;
  markdown: string;
  hash: string;
}

export interface WikiPublishRequest {
  root: {
    title: string;
    markdown: string;
    hash: string;
  };
  categories: WikiPublishCategory[];
  pages: WikiPublishPage[];
  state: FeishuWikiState | null;
}

export interface WikiPublishResponse {
  ok: boolean;
  state?: FeishuWikiState;
  created?: number;
  updated?: number;
  skipped?: number;
  error?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
  sourceUrl?: string;
}

export interface Settings {
  version: 1;
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  outputLanguage: string;
  feishu: BridgeConfig;
  documents: DocumentSettings;
  customSkills: Skill[];
}

export interface PublicProviderConfig {
  id: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  reasoning: ReasoningEffort;
  hasApiKey: boolean;
}

export interface PublicSettings {
  version: 1;
  activeProvider: ProviderId;
  providers: Record<ProviderId, PublicProviderConfig>;
  outputLanguage: string;
  feishu: {
    url: string;
    parentToken: string;
    hasToken: boolean;
  };
  documents: DocumentSettings;
  customSkills: Skill[];
}

export interface OutlineNode {
  id: string;
  level: number;
  title: string;
  text: string;
  anchor: string;
  children: OutlineNode[];
}

export interface PageContext {
  url: string;
  title: string;
  canonicalUrl: string;
  site: string;
  author: string;
  publishedAt: string;
  lang: string;
  description: string;
  wordCount: number;
  capturedAt: number;
  contentHash: string;
  outline: OutlineNode[];
  manual?: boolean;
}

export interface SelectionContext {
  text: string;
  paragraph: string;
  headingPath: string[];
  anchor: string;
}

export interface SummarySection {
  outlineId: string;
  title: string;
  summary: string;
  keyPoints: string[];
  questions: string[];
}

export interface KeyConcept {
  term: string;
  explanation: string;
}

export interface PageSummary {
  overview: string;
  tags: string[];
  sections: SummarySection[];
  keyConcepts: KeyConcept[];
  generatedAt: number;
  model: string;
}

export type RecordStatus = 'captured' | 'ready' | 'error';

export interface FeishuDocumentRef {
  url: string;
  documentId: string;
  writtenAt: number;
}

export interface StudyRecord {
  id: string;
  page: PageContext;
  summary: PageSummary | null;
  messages: ChatMessage[];
  selections: SelectionContext[];
  notes: string;
  tags: string[];
  status: RecordStatus;
  createdAt: number;
  updatedAt: number;
  feishu: FeishuDocumentRef | null;
  documents?: Partial<Record<DocumentTarget, DocumentRef>>;
  sync?: Partial<Record<DocumentTarget, DocumentSyncState>>;
  error: string | null;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  skillId?: string;
  error?: boolean;
}

export interface ChatHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface BridgeHealth {
  ok: boolean;
  larkCli: boolean;
  wiki?: boolean;
  notion?: boolean;
  markdown?: boolean;
  markdownDir?: string;
  version?: string;
  syncPending?: number;
  syncError?: number;
  wikiPending?: number;
  wikiError?: number;
  error?: string;
}

export interface FeishuWriteResult {
  ok: boolean;
  url?: string;
  documentId?: string;
  error?: string;
}

export interface DocumentWriteResult {
  ok: boolean;
  target: DocumentTarget;
  documentId?: string;
  url?: string;
  path?: string;
  error?: string;
}

export interface SummaryRequest {
  page: PageContext;
  messages: ChatHistoryMessage[];
  selections: SelectionContext[];
  language: string;
  model: string;
}

export interface ChatRequest {
  requestId: string;
  messages: ChatHistoryMessage[];
  page: PageContext | null;
  selections: SelectionContext[];
  skill: Skill;
  language: string;
  model: string;
}

export type ChatStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; error: string };
