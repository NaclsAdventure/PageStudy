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
  context: ContextSettings;
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
  context: ContextSettings;
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

export type ContextMode = 'smart' | 'full' | 'selection' | 'off';

export interface ContextSettings {
  mode: ContextMode;
  includeImages: boolean;
}

export interface PageBlock {
  id: string;
  kind: 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table';
  text: string;
  anchor: string;
  headingPath: string[];
  level?: number;
}

export interface PageImage {
  id: string;
  src: string;
  alt: string;
  caption: string;
  anchor: string;
  headingPath: string[];
  width: number;
  height: number;
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
  /** 全文分块；旧记录没有该字段时回退到 outline。 */
  blocks?: PageBlock[];
  images?: PageImage[];
  tokenEstimate?: number;
  extractionQuality?: 'high' | 'medium' | 'low';
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

export interface ArgumentPoint {
  claim: string;
  evidence: string;
  assumptions: string;
  boundary: string;
}

export interface DialogueInsight {
  question: string;
  insight: string;
  evidence: string[];
  concepts: string[];
  /** 讨论结论归属的章节；为空表示整篇/未归类。 */
  outlineId?: string;
  sectionTitle?: string;
  /** 产生这条结论的对话消息，用于避免重复整理。 */
  sourceMessageIds?: string[];
}

export interface PageSummary {
  overview: string;
  tags: string[];
  sections: SummarySection[];
  keyConcepts: KeyConcept[];
  /** 一句话主张；旧记录没有时回退到 overview。 */
  thesis?: string;
  quickRead?: string[];
  argumentMap?: ArgumentPoint[];
  dialogueInsights?: DialogueInsight[];
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
  /** 知识卡中保留的正文图片 ID；undefined 表示默认全部正文图。 */
  selectedImageIds?: string[];
  /** 已经整理进章节笔记的对话消息 ID，避免重复沉淀。 */
  distilledMessageIds?: string[];
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
  /** 提问时选中的章节锚点，便于把讨论归入本节。 */
  anchor?: string;
  headingPath?: string[];
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
  warnings?: string[];
  error?: string;
}

export interface SummaryRequest {
  page: PageContext;
  messages: ChatHistoryMessage[];
  selections: SelectionContext[];
  language: string;
  model: string;
}

export interface DiscussionSection {
  outlineId: string;
  title: string;
  anchor: string;
  summary: string;
  keyPoints: string[];
  questions: string[];
}

export interface DistillRequest {
  page: PageContext;
  section: DiscussionSection;
  messages: ChatHistoryMessage[];
  selection?: SelectionContext | null;
  language: string;
}

export interface ChatRequest {
  requestId: string;
  messages: ChatHistoryMessage[];
  page: PageContext | null;
  selections: SelectionContext[];
  skill: Skill;
  language: string;
  model: string;
  contextMode: ContextMode;
  query?: string;
}

export type ChatStreamEvent =
  | { type: 'start'; requestId: string }
  | { type: 'delta'; requestId: string; text: string }
  | { type: 'done'; requestId: string }
  | { type: 'error'; requestId: string; error: string };
