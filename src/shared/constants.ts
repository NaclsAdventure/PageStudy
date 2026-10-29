import type { ProviderId, ProviderConfig, Settings, Skill } from './types';

export const APP_NAME = 'PageStudy';
export const APP_VERSION = '0.4.0';
export const SETTINGS_KEY = 'pagestudy.settings.v1';
export const SYNC_QUEUE_KEY = 'pagestudy.sync.queue.v1';
export const SYNC_ALARM = 'pagestudy-sync';
export const WIKI_STATE_KEY = 'pagestudy.wiki.feishu.v1';
export const WIKI_QUEUE_KEY = 'pagestudy.wiki.queue.v1';
export const WIKI_SYNC_ALARM = 'pagestudy-wiki-sync';
export const WIKI_ROOT_TITLE = 'PageStudy Wiki';
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
  {
    id: 'feynman',
    name: '费曼讲解',
    description: '用自己的话讲清楚，暴露理解断点。',
    builtin: true,
    sourceUrl: 'https://github.com/toddward/the-learning-skill',
    prompt:
      '你是一位费曼学习法教练。先要求读者用自己的话复述选中内容，再检查复述中的模糊词、跳跃和未解释的术语。用更简单的类比重讲一遍，最后给出 2–3 个能暴露理解断点的问题。不要把“读懂了”当作“讲清楚了”；读者没有讲清楚的地方要明确指出。',
  },
  {
    id: 'socratic',
    name: '苏格拉底追问',
    description: '不急着给答案，用问题逼近假设与边界。',
    builtin: true,
    sourceUrl: 'https://github.com/anthropics/skills',
    prompt:
      '你是一位苏格拉底式阅读教练。不要一开始就给结论，而是基于选中段落提出 1 个最关键的问题，等待读者回答；根据回答继续追问证据、隐含假设、反例和适用边界。每轮只推进一小步，问题要具体到原文，不要连续抛出清单。',
  },
  {
    id: 'cornell',
    name: '康奈尔笔记',
    description: '把段落整理成线索、笔记、总结三栏。',
    builtin: true,
    sourceUrl: 'https://lsc.cornell.edu/how-to-study/taking-notes/cornell-note-taking-system/',
    prompt:
      '你是一位康奈尔笔记教练。把选中内容整理为三部分：左侧“线索”写 3–5 个能触发回忆的问题或关键词；右侧“笔记”用简短要点记录论据、例子和定义；底部“总结”用 2–3 句话概括这一节。笔记要基于原文，不要补写作者没有说过的结论。',
  },
  {
    id: 'active-recall',
    name: '主动回忆',
    description: '生成闭卷检索题和间隔复习安排。',
    builtin: true,
    sourceUrl: 'https://github.com/toddward/the-learning-skill',
    prompt:
      '你是一位主动回忆教练。基于选中段落设计 4–6 道闭卷检索题，覆盖定义、因果、例子和易混点；先只给问题，附上简短评分要点，不要直接展示完整答案。最后给出一个轻量的间隔复习安排（今天、3 天后、7 天后），并提醒读者先尝试回忆再看原文。',
  },
  {
    id: 'zettelkasten',
    name: '卡片笔记',
    description: '把内容拆成原子笔记并寻找连接。',
    builtin: true,
    sourceUrl: 'https://zettelkasten.de/introduction/',
    prompt:
      '你是一位卡片笔记（Zettelkasten）教练。把选中内容拆成 2–4 张原子笔记：每张只表达一个观点，用自己的话写，保留原文出处；为每张笔记起一个可检索的标题，并指出它可能与哪些已有概念/标签连接。不要写成长篇摘要，也不要虚构不存在的链接。',
  },
  {
    id: 'progressive-summary',
    name: '渐进式总结',
    description: '从原文到一句话，逐层压缩重点。',
    builtin: true,
    sourceUrl: 'https://fortelabs.com/blog/progressive-summarization-a-practical-technique-for-designing-discoverable-notes/',
    prompt:
      '你是一位渐进式总结教练。把选中内容压缩成三层：第一层保留关键原文句子；第二层提炼论点和证据；第三层用一句话说出“这段话为什么重要”。每层都要能独立阅读，并标出被压缩掉的信息类型。不要为了简短而丢掉限定条件和反例。',
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
    documents: {
      autoSync: false,
      wikiAutoSync: false,
      defaultTarget: 'feishu',
      notionParentPageId: '',
      markdownDirectory: '',
    },
    context: {
      mode: 'smart',
      includeImages: true,
    },
    customSkills: [],
  };
}
