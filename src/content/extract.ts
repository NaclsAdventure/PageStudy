import type { OutlineNode, PageBlock, PageContext, PageImage, SelectionContext } from '../shared/types';
import { MAX_PAGE_CHARS, MAX_SECTION_CHARS } from '../shared/constants';
import { hashString, normalizeWhitespace, truncate } from '../shared/utils';

const UI_SELECTOR = [
  'nav',
  'aside',
  'footer',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="complementary"]',
  '[role="search"]',
  '.sr-only',
  '.visually-hidden',
  '.notranslate',
  '.toc',
  '.table-of-contents',
  '.breadcrumb',
  '.breadcrumbs',
  '.sidebar',
  '.menu',
  '.pagination',
  '.pager',
  '.comments',
  '.comment-section',
  '.related-posts',
  '.recommend',
  '.advertisement',
  '.advert',
  '.cookie-banner',
  '.share-buttons',
  '[aria-hidden="true"]',
].join(',');

const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
const CONTENT_BLOCK_SELECTOR = 'p,li,blockquote,pre';
const FULL_BLOCK_SELECTOR = `${HEADING_SELECTOR},${CONTENT_BLOCK_SELECTOR},td,th`;
const BLOCK_SELECTOR = `${HEADING_SELECTOR},${CONTENT_BLOCK_SELECTOR}`;
const IMAGE_MIN_WIDTH = 180;
const IMAGE_MIN_HEIGHT = 100;
const MAX_IMAGES = 16;

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return element.getClientRects().length > 0;
}

function isUiElement(element: Element): boolean {
  return Boolean(element.closest(UI_SELECTOR));
}

function getText(element: Element): string {
  return normalizeWhitespace(element.textContent ?? '');
}

function candidateRoots(): Element[] {
  const roots: Element[] = [];
  const push = (selector: string) => {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!roots.includes(element) && isVisible(element)) roots.push(element);
    }
  };
  push('article');
  push('[role="article"]');
  push('main');
  return roots;
}

export function findContentRoot(): Element {
  const roots = candidateRoots()
    .map((element) => ({ element, length: getText(element).length }))
    .filter((item) => item.length >= 80)
    .sort((a, b) => b.length - a.length);
  if (roots.length > 0) return roots[0].element;
  return document.body;
}

function metaContent(...selectors: string[]): string {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (!element) continue;
    if (element instanceof HTMLMetaElement) {
      const value = element.content?.trim();
      if (value) return value;
    } else {
      const value = element.getAttribute('content')?.trim() || getText(element);
      if (value) return value;
    }
  }
  return '';
}

function pageMeta(root: Element): Omit<PageContext, 'outline' | 'capturedAt' | 'contentHash' | 'wordCount'> {
  const title =
    metaContent('meta[property="og:title"]', 'meta[name="twitter:title"]') ||
    normalizeWhitespace(document.title) ||
    '未命名网页';
  const canonicalElement = document.querySelector('link[rel="canonical"]');
  const canonicalUrl = canonicalElement instanceof HTMLLinkElement ? canonicalElement.href : location.href;
  const author =
    metaContent('meta[name="author"]', 'meta[property="article:author"]') ||
    normalizeWhitespace(
      document.querySelector('article [rel="author"], main [rel="author"], [itemprop="author"]')?.textContent ?? '',
    );
  const publishedAt = metaContent(
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[itemprop="datePublished"]',
  );
  const description = metaContent('meta[name="description"]', 'meta[property="og:description"]');
  return {
    url: location.href,
    title: truncate(title, 300),
    canonicalUrl,
    site: metaContent('meta[property="og:site_name"]') || location.hostname.replace(/^www\./, ''),
    author: truncate(author, 120),
    publishedAt: truncate(publishedAt, 60),
    lang: document.documentElement.lang.trim() || 'unknown',
    description: truncate(description, 500),
  };
}

function ensureAnchor(heading: Element, index: number): string {
  const existing = heading.getAttribute('data-ps-anchor');
  if (existing) return existing;
  const base =
    heading.id.trim() ||
    `ps-h-${hashString(`${heading.tagName}-${getText(heading)}-${index}`)}`;
  heading.setAttribute('data-ps-anchor', base);
  return base;
}

function addNode(
  roots: OutlineNode[],
  stack: Array<{ level: number; node: OutlineNode }>,
  node: OutlineNode,
): void {
  while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
  if (stack.length > 0) {
    stack[stack.length - 1].node.children.push(node);
  } else {
    roots.push(node);
  }
  stack.push({ level: node.level, node });
}

export function extractOutline(root: Element): OutlineNode[] {
  const allBlocks = Array.from(root.querySelectorAll(BLOCK_SELECTOR)).filter(
    (element) => !isUiElement(element) && isVisible(element),
  );
  const headings = allBlocks.filter((element) => element.matches(HEADING_SELECTOR));

  if (headings.length === 0) {
    const text = allBlocks
      .filter((element) => element.matches(CONTENT_BLOCK_SELECTOR))
      .map((element) => getText(element))
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_SECTION_CHARS);
    return [
      {
        id: 'ps-outline-root',
        level: 1,
        title: normalizeWhitespace(document.title) || '全文',
        text,
        anchor: 'ps-page-top',
        children: [],
      },
    ];
  }

  const outline: OutlineNode[] = [];
  const stack: Array<{ level: number; node: OutlineNode }> = [];
  let usedChars = 0;

  headings.forEach((heading, headingIndex) => {
    const levelMatch = heading.tagName.match(/^H([1-6])$/);
    const level = levelMatch ? Number(levelMatch[1]) : 2;
    const title = getText(heading);
    if (!title) return;

    const headingPosition = allBlocks.indexOf(heading);
    let sectionText = '';
    for (let index = headingPosition + 1; index < allBlocks.length; index += 1) {
      const element = allBlocks[index];
      if (element.matches(HEADING_SELECTOR)) break;
      if (!element.matches(CONTENT_BLOCK_SELECTOR)) continue;
      const text = getText(element);
      if (!text) continue;
      if (sectionText.length + text.length > MAX_SECTION_CHARS) {
        sectionText += `\n${truncate(text, Math.max(0, MAX_SECTION_CHARS - sectionText.length))}`;
        break;
      }
      sectionText += `${sectionText ? '\n' : ''}${text}`;
    }

    if (usedChars > MAX_PAGE_CHARS) sectionText = '';
    usedChars += sectionText.length;
    const node: OutlineNode = {
      id: `ps-outline-${headingIndex + 1}`,
      level,
      title,
      text: sectionText,
      anchor: ensureAnchor(heading, headingIndex),
      children: [],
    };
    addNode(outline, stack, node);
  });

  return outline;
}

function blockKind(element: Element): PageBlock['kind'] {
  if (element.matches(HEADING_SELECTOR)) return 'heading';
  if (element.matches('li')) return 'list';
  if (element.matches('blockquote')) return 'quote';
  if (element.matches('pre')) return 'code';
  if (element.matches('td,th')) return 'table';
  return 'paragraph';
}

function isNestedContentBlock(element: Element, root: Element): boolean {
  const parent = element.parentElement?.closest(FULL_BLOCK_SELECTOR);
  return Boolean(parent && parent !== element && root.contains(parent));
}

export function extractBlocks(root: Element): PageBlock[] {
  const allBlocks = Array.from(root.querySelectorAll(FULL_BLOCK_SELECTOR)).filter(
    (element) => !isUiElement(element) && isVisible(element),
  );
  const headings = allBlocks.filter((element) => element.matches(HEADING_SELECTOR));
  const blocks: PageBlock[] = [];
  let headingPath: string[] = [];
  let usedChars = 0;

  for (const element of allBlocks) {
    const text = getText(element);
    if (!text) continue;
    if (!element.matches(HEADING_SELECTOR) && isNestedContentBlock(element, root)) continue;

    if (element.matches(HEADING_SELECTOR)) {
      headingPath = headingPathFor(element, headings);
    }
    const heading = element.matches(HEADING_SELECTOR) ? element : findHeadingForNode(element, root);
    const anchor = heading
      ? heading.getAttribute('data-ps-anchor') ||
        heading.id ||
        ensureAnchor(heading, headings.indexOf(heading))
      : 'ps-page-top';
    const remaining = MAX_PAGE_CHARS - usedChars;
    if (remaining <= 0) break;
    const blockText = truncate(text, remaining);
    const levelMatch = element.tagName.match(/^H([1-6])$/);
    blocks.push({
      id: `ps-block-${blocks.length + 1}`,
      kind: blockKind(element),
      text: blockText,
      anchor,
      headingPath: [...headingPath],
      ...(levelMatch ? { level: Number(levelMatch[1]) } : {}),
    });
    usedChars += blockText.length;
  }

  if (blocks.length === 0) {
    // 极端页面可能没有 p/li 等块级元素；从大纲文本生成一个可总结的根块。
    const outline = extractOutline(root);
    const outlineText = (nodes: OutlineNode[]): string[] =>
      nodes.flatMap((node) => [node.text, ...outlineText(node.children)]);
    const fallbackText = normalizeWhitespace(outlineText(outline).join('\n'));
    if (fallbackText) {
      blocks.push({
        id: 'ps-block-root',
        kind: 'paragraph',
        text: truncate(fallbackText, MAX_PAGE_CHARS),
        anchor: 'ps-page-top',
        headingPath: [],
      });
    }
  }
  return blocks;
}

function absoluteImageUrl(value: string): string {
  if (!value.trim()) return '';
  try {
    return new URL(value, location.href).toString();
  } catch {
    return '';
  }
}

export function extractImages(root: Element): PageImage[] {
  const headings = headingElements(root);
  const images: PageImage[] = [];
  const seen = new Set<string>();

  for (const image of Array.from(root.querySelectorAll('img'))) {
    if (!isVisible(image)) continue;
    const element = image as HTMLImageElement;
    const src = absoluteImageUrl(
      element.currentSrc ||
        element.getAttribute('data-src') ||
        element.getAttribute('data-original') ||
        element.src ||
        '',
    );
    if (!src || seen.has(src)) continue;
    if (src.startsWith('data:') && src.length < 200) continue;
    if (/pixel|tracking|spacer|sprite|avatar|icon|logo|emoji/i.test(`${element.className} ${element.alt}`)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const declaredWidth = Number(element.getAttribute('width')) || 0;
    const declaredHeight = Number(element.getAttribute('height')) || 0;
    const width = element.naturalWidth || declaredWidth || Math.round(rect.width);
    const height = element.naturalHeight || declaredHeight || Math.round(rect.height);
    if (width <= 1 || height <= 1) continue;

    const figure = element.closest('figure');
    const captionElement = figure?.querySelector('figcaption') ?? element.closest('figcaption');
    const caption = normalizeWhitespace(
      captionElement?.textContent || element.getAttribute('title') || element.alt || '',
    );
    if (width < IMAGE_MIN_WIDTH && height < IMAGE_MIN_HEIGHT && !caption) continue;

    const heading = findHeadingForNode(element, root);
    const anchor = heading
      ? heading.getAttribute('data-ps-anchor') ||
        heading.id ||
        ensureAnchor(heading, headings.indexOf(heading))
      : 'ps-page-top';
    images.push({
      id: `ps-image-${hashString(src)}`,
      src,
      alt: truncate(normalizeWhitespace(element.alt || caption), 300),
      caption: truncate(caption, 500),
      anchor,
      headingPath: headingPathFor(heading, headings),
      width,
      height,
    });
    seen.add(src);
    if (images.length >= MAX_IMAGES) break;
  }
  return images;
}

function headingElements(root: Element): Element[] {
  return Array.from(root.querySelectorAll(HEADING_SELECTOR)).filter(
    (element) => !isUiElement(element) && isVisible(element) && getText(element),
  );
}

function headingPathFor(heading: Element | null, headings: Element[]): string[] {
  if (!heading) return [];
  const index = headings.indexOf(heading);
  if (index < 0) return [getText(heading)];
  const path: string[] = [];
  let floor = 7;
  for (let i = index; i >= 0; i -= 1) {
    const current = headings[i];
    const level = Number(current.tagName.slice(1));
    if (level < floor) {
      path.unshift(getText(current));
      floor = level;
    }
    if (floor === 1) break;
  }
  return path;
}

function findHeadingForNode(node: Node, root: Element): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;
  const closest = element.closest(HEADING_SELECTOR);
  if (closest) return closest;
  const headings = headingElements(root);
  let previous: Element | null = null;
  for (const heading of headings) {
    if (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
      previous = heading;
    } else {
      break;
    }
  }
  return previous;
}

function blockForNode(node: Node, root: Element): Element | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;
  const block = element.closest('p,li,blockquote,pre,td,th');
  if (block && root.contains(block) && !isUiElement(block)) return block;
  return null;
}

export function extractSelection(root: Element): SelectionContext | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = normalizeWhitespace(selection.toString());
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const heading = findHeadingForNode(range.startContainer, root);
  const block = blockForNode(range.startContainer, root);
  const headings = headingElements(root);
  return {
    text: truncate(text, 6000),
    paragraph: truncate(block ? getText(block) : text, 4000),
    headingPath: headingPathFor(heading, headings),
    anchor: heading
      ? heading.getAttribute('data-ps-anchor') || heading.id || ensureAnchor(heading, headings.indexOf(heading))
      : '',
  };
}

export function buildPageContext(): PageContext {
  const root = findContentRoot();
  const outline = extractOutline(root);
  const meta = pageMeta(root);
  const blocks = extractBlocks(root);
  const images = extractImages(root);
  const fullText = normalizeWhitespace(blocks.map((block) => block.text).join('\n'));
  const contentHash = hashString(
    `${meta.canonicalUrl}|${meta.title}|${blocks
      .map((block) => block.text)
      .join('|')}|${images.map((image) => image.src).join('|')}`,
  );
  const extractionQuality =
    fullText.length >= 500 && blocks.length >= 4
      ? 'high'
      : fullText.length >= 80
        ? 'medium'
        : 'low';
  return {
    ...meta,
    outline,
    blocks,
    images,
    wordCount: Math.min(9999999, fullText.length),
    tokenEstimate: Math.ceil(fullText.length / 2),
    extractionQuality,
    capturedAt: Date.now(),
    contentHash,
  };
}

export function scrollToAnchor(anchor: string): boolean {
  if (!anchor) return false;
  const element =
    document.getElementById(anchor) ??
    document.querySelector(`[data-ps-anchor="${CSS.escape(anchor)}"]`);
  if (!(element instanceof HTMLElement)) return false;
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.animate(
    [
      { backgroundColor: 'rgba(13, 148, 136, 0.18)' },
      { backgroundColor: 'rgba(13, 148, 136, 0)' },
    ],
    { duration: 1500, easing: 'ease-out' },
  );
  return true;
}
