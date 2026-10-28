import type { PageContext } from './types';
import { hashString, normalizeWhitespace, safeHostname } from './utils';

export function isHttpUrl(url: string | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

export function isBrowserInternalUrl(url: string | undefined): boolean {
  return typeof url === 'string' && /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url);
}

export function isRestrictedPageUrl(url: string | undefined): boolean {
  return Boolean(url) && !isHttpUrl(url);
}

interface ManualPageInput {
  url: string;
  title: string;
  text: string;
}

/**
 * 浏览器内置页（chrome://、edge://、扩展页等）不能被内容脚本注入。
 * 这里用用户手动摘录的正文构造一个最小页面上下文，后续仍可走总结与 Wiki。
 */
export function createManualPage({ url, title, text }: ManualPageInput): PageContext {
  const cleanText = normalizeWhitespace(text);
  const cleanTitle = normalizeWhitespace(title) || '手动摘录';
  const cleanUrl = url.trim();
  const outline = cleanText
    ? [
        {
          id: `manual-${hashString(cleanText)}`,
          level: 1,
          title: '手动摘录',
          text: cleanText,
          anchor: '',
          children: [],
        },
      ]
    : [];
  return {
    url: cleanUrl,
    title: cleanTitle,
    canonicalUrl: cleanUrl || `pagestudy://manual/${hashString(cleanTitle)}`,
    site: cleanUrl ? safeHostname(cleanUrl) : '手动记录',
    author: '',
    publishedAt: '',
    lang: 'zh-CN',
    description: cleanText.slice(0, 180),
    wordCount: cleanText.replace(/\s/g, '').length,
    capturedAt: Date.now(),
    contentHash: hashString(`${cleanUrl}\n${cleanTitle}\n${cleanText}`),
    outline,
    manual: true,
  };
}
