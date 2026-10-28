import type { ProviderId, ProviderConfig, Settings, Skill } from './types';

export const APP_NAME = 'PageStudy';
export const APP_VERSION = '0.1.0';
export const SETTINGS_KEY = 'pagestudy.settings.v1';
export const MAX_PAGE_CHARS = 60000;
export const MAX_SECTION_CHARS = 5000;

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  custom: '自定义兼容接口',
};

export const PROVIDER_DEFAULTS: Record<ProviderId, ProviderConfig> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    reasoning: 'default',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    reasoning: 'default',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    apiKey: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    reasoning: 'default',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    apiKey: '',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
    reasoning: 'default',
  },
  custom: {
    id: 'custom',
    label: '自定义兼容接口',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    reasoning: 'default',
  },
};

export const DEFAULT_SKILLS: Skill[] = [
  {
    id: 'general',
    name: '通用助读',
    description: '围绕选中段落解释、追问和梳理，不预设固定输出格式。',
    builtin: true,
    prompt:
      '你是一位耐心的中文阅读助教。优先解释用户选中的段落及其上下文，再补充必要背景。回答要具体、可核对；不确定时明确说明，不要编造原文没有的事实。',
  },
  {
    id: 'deep-read',
    name: '逐段精读',
    description: '拆解论证、概念和例子，适合技术博客与长文。',
    builtin: true,
    prompt:
      '你是一位严谨的精读助教。请按“这段在说什么 → 它为什么成立 → 关键概念/例子 → 与全文的关系 → 我可能误解什么”的顺序讲解。尽量使用短段落和小标题，保留原文术语，不要泛泛复述。',
  },
  {
    id: 'critical',
    name: '批判性阅读',
    description: '区分主张、证据、假设和反例，训练独立判断。',
    builtin: true,
    prompt:
      '你是一位批判性阅读教练。请区分作者的主张、证据、隐含假设和适用范围，指出可能的反例、利益相关方和未经验证的跳跃。不要为了显得批判而否定一切，要给出可检验的判断。',
  },
  {
    id: 'concept',
    name: '概念拆解',
    description: '把陌生术语拆成定义、类比、边界和例子。',
    builtin: true,
    prompt:
      '你是一位概念拆解助教。请用“一句话定义 → 它解决什么问题 → 与相近概念的区别 → 一个具体例子 → 常见误区”的结构解释选中内容中的关键概念。必要时给出中英文术语。',
  },
  {
    id: 'study-cards',
    name: '学习卡片',
    description: '把段落转成可复习的问答卡片。',
    builtin: true,
    prompt:
      '你是一位学习卡片设计师。请基于选中段落生成 3–6 张问答卡片，问题要能检验理解而不是死记硬背；答案简洁，并在必要处引用原文。最后列出 1–2 个仍需读者自己验证的问题。',
  },
];

export function getDefaultSettings(): Settings {
  return {
    version: 1,
    activeProvider: 'deepseek',
    providers: {
      deepseek: { ...PROVIDER_DEFAULTS.deepseek },
      openai: { ...PROVIDER_DEFAULTS.openai },
      anthropic: { ...PROVIDER_DEFAULTS.anthropic },
      gemini: { ...PROVIDER_DEFAULTS.gemini },
      custom: { ...PROVIDER_DEFAULTS.custom },
    },
    outputLanguage: '中文',
    feishu: {
      url: 'http://127.0.0.1:17373',
      token: '',
      parentToken: '',
    },
    customSkills: [],
  };
}
