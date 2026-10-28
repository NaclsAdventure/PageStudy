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

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  builtin: boolean;
}

export interface Settings {
  version: 1;
  activeProvider: ProviderId;
  providers: Record<ProviderId, ProviderConfig>;
  outputLanguage: string;
  feishu: BridgeConfig;
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
  version?: string;
  error?: string;
}

export interface FeishuWriteResult {
  ok: boolean;
  url?: string;
  documentId?: string;
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
