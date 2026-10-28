import { getDefaultSettings, PROVIDER_DEFAULTS, PROVIDER_LABELS, SETTINGS_KEY } from './constants';
import type {
  DocumentSettings,
  DocumentTarget,
  ProviderConfig,
  ProviderId,
  PublicProviderConfig,
  PublicSettings,
  ReasoningEffort,
  Settings,
  Skill,
} from './types';

const PROVIDER_IDS: ProviderId[] = ['deepseek', 'openai', 'anthropic', 'gemini', 'custom'];
const REASONING_LEVELS: ReasoningEffort[] = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const DOCUMENT_TARGETS: DocumentTarget[] = ['feishu', 'notion', 'markdown'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && PROVIDER_IDS.includes(value as ProviderId);
}

function normalizeReasoning(value: unknown): ReasoningEffort {
  return typeof value === 'string' && REASONING_LEVELS.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : 'default';
}

function normalizeProvider(id: ProviderId, raw: unknown): ProviderConfig {
  const fallback = PROVIDER_DEFAULTS[id];
  if (!isRecord(raw)) return { ...fallback };
  return {
    id,
    label: PROVIDER_LABELS[id],
    apiKey: asString(raw.apiKey),
    baseUrl:
      asString(raw.baseUrl, fallback.baseUrl).trim().replace(/\/+$/, '') || fallback.baseUrl,
    model: asString(raw.model, fallback.model).trim(),
    reasoning: normalizeReasoning(raw.reasoning),
  };
}

function normalizeSkill(raw: unknown): Skill | null {
  if (!isRecord(raw)) return null;
  const name = asString(raw.name).trim();
  const prompt = asString(raw.prompt).trim();
  if (!name || !prompt) return null;
  return {
    id: asString(raw.id).trim() || `custom_${name}`,
    name,
    description: asString(raw.description).trim(),
    prompt,
    builtin: false,
    sourceUrl: asString(raw.sourceUrl).trim() || undefined,
  };
}

function normalizeDocuments(raw: unknown, fallback: DocumentSettings): DocumentSettings {
  if (!isRecord(raw)) return { ...fallback };
  const target = asString(raw.defaultTarget);
  return {
    autoSync: typeof raw.autoSync === 'boolean' ? raw.autoSync : fallback.autoSync,
    defaultTarget: DOCUMENT_TARGETS.includes(target as DocumentTarget)
      ? (target as DocumentTarget)
      : fallback.defaultTarget,
    notionParentPageId: asString(raw.notionParentPageId).trim(),
    markdownDirectory: asString(raw.markdownDirectory).trim(),
  };
}

export function normalizeSettings(raw: unknown): Settings {
  const base = getDefaultSettings();
  if (!isRecord(raw)) return base;

  const providers = { ...base.providers };
  const rawProviders = isRecord(raw.providers) ? raw.providers : {};
  for (const id of PROVIDER_IDS) {
    providers[id] = normalizeProvider(id, rawProviders[id]);
  }

  const activeProvider = isProviderId(raw.activeProvider) ? raw.activeProvider : base.activeProvider;
  const rawFeishu = isRecord(raw.feishu) ? raw.feishu : {};
  const customSkills = Array.isArray(raw.customSkills)
    ? raw.customSkills.map(normalizeSkill).filter((skill): skill is Skill => Boolean(skill))
    : [];

  return {
    version: 1,
    activeProvider,
    providers,
    outputLanguage: asString(raw.outputLanguage, base.outputLanguage).trim() || base.outputLanguage,
    feishu: {
      url:
        asString(rawFeishu.url, base.feishu.url).trim().replace(/\/+$/, '') || base.feishu.url,
      token: asString(rawFeishu.token),
      parentToken: asString(rawFeishu.parentToken).trim(),
    },
    documents: normalizeDocuments(raw.documents, base.documents),
    customSkills,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalized });
  return normalized;
}

export function toPublicSettings(settings: Settings): PublicSettings {
  const providers = {} as Record<ProviderId, PublicProviderConfig>;
  for (const id of PROVIDER_IDS) {
    const provider = settings.providers[id];
    providers[id] = {
      id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      reasoning: provider.reasoning,
      hasApiKey: Boolean(provider.apiKey.trim()),
    };
  }
  return {
    version: 1,
    activeProvider: settings.activeProvider,
    providers,
    outputLanguage: settings.outputLanguage,
    feishu: {
      url: settings.feishu.url,
      parentToken: settings.feishu.parentToken,
      hasToken: Boolean(settings.feishu.token),
    },
    documents: { ...settings.documents },
    customSkills: settings.customSkills,
  };
}

export function getActiveProvider(settings: Settings): ProviderConfig {
  return settings.providers[settings.activeProvider];
}

export function sanitizeBridgeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}
