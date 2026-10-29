import { MAX_PAGE_CHARS } from './constants';
import type { OutlineNode, PageBlock, PageContext } from './types';
import { hashString, normalizeWhitespace, safeHostname, truncate } from './utils';

/** PDF.js 提取出的一行文字。y 使用 PDF 坐标，页面内从下到上递增。 */
export interface PdfTextLine {
  page: number;
  y: number;
  height: number;
  text: string;
}

/** PDF 书签解析后的扁平条目。 */
export interface PdfBookmark {
  title: string;
  page: number;
  level: number;
  y?: number;
}

/** 用户手动填写的 PDF 小节。 */
export interface PdfManualSection {
  title: string;
  startPage: number;
  endPage: number;
}

export interface PdfPageInput {
  url: string;
  title: string;
  author?: string;
  lines: PdfTextLine[];
  bookmarks?: PdfBookmark[];
  pageCount: number;
  lang?: string;
}

export interface PdfOutlineParseResult {
  entries?: PdfManualSection[];
  error?: string;
}

const MAX_PDF_SECTION_CHARS = 20000;

/** 识别常见的 PDF 直链；正文脚本失败后仍会做内容探测。 */
export function isPdfUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /\.pdf$/i.test(parsed.pathname) ||
      /\/pdf(?:\/|$)/i.test(parsed.pathname) ||
      /[?&](?:file|url)=[^&]*\.pdf(?:&|$)/i.test(url)
    );
  } catch {
    return /\.pdf(?:$|[?#])/i.test(url);
  }
}

function cleanTitle(value: string, fallback: string): string {
  return normalizeWhitespace(value) || fallback;
}

function orderedLines(lines: PdfTextLine[]): PdfTextLine[] {
  return [...lines]
    .filter((line) => line.text.trim() && Number.isFinite(line.page) && Number.isFinite(line.y))
    .sort((a, b) => a.page - b.page || b.y - a.y);
}

function lineText(lines: PdfTextLine[]): string {
  return lines
    .map((line) => line.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sectionStartIndex(
  lines: PdfTextLine[],
  page: number,
  y: number | undefined,
): number {
  const index = lines.findIndex(
    (line) =>
      line.page > page ||
      (line.page === page && (y === undefined || line.y <= y + 6)),
  );
  return index === -1 ? lines.length : index;
}

function sectionBlocks(node: OutlineNode): PageBlock[] {
  const blocks: PageBlock[] = [
    {
      id: `${node.id}-heading`,
      kind: 'heading',
      text: node.title,
      anchor: node.anchor,
      headingPath: [node.title],
      level: node.level,
      page: node.page,
    },
  ];
  if (node.text.trim()) {
    blocks.push({
      id: `${node.id}-text`,
      kind: 'paragraph',
      text: node.text,
      anchor: node.anchor,
      headingPath: [node.title],
      page: node.page,
    });
  }
  return blocks;
}

function pageBlocks(lines: PdfTextLine[]): PageBlock[] {
  const byPage = new Map<number, string[]>();
  for (const line of lines) {
    const current = byPage.get(line.page) ?? [];
    current.push(line.text.trim());
    byPage.set(line.page, current);
  }
  return [...byPage.entries()]
    .sort(([left], [right]) => left - right)
    .map(([page, chunks]) => ({
      id: `pdf-page-${page}`,
      kind: 'paragraph' as const,
      text: chunks.filter(Boolean).join('\n'),
      anchor: `pdf-p${page}`,
      headingPath: [],
      page,
    }))
    .filter((block) => block.text.trim());
}

function buildPage(
  input: PdfPageInput,
  ordered: PdfTextLine[],
  sections: Array<{ title: string; level: number; page: number; text: string }>,
): PageContext {
  const cleanLines = lineText(ordered);
  if (!cleanLines) {
    throw new Error('这个 PDF 没有可提取的文字层，可能是扫描件。');
  }
  const outline: OutlineNode[] = sections
    .filter((section) => section.text.trim())
    .map((section, index) => ({
      id: `pdf-section-${index + 1}`,
      level: Math.max(1, Math.min(6, section.level || 1)),
      title: cleanTitle(section.title, `第 ${section.page} 页`),
      text: truncate(section.text.trim(), MAX_PDF_SECTION_CHARS),
      // 同一页可能有多个书签小节，锚点必须唯一，否则点击标题会跳到前一节。
      anchor: `pdf-p${section.page}-s${index + 1}`,
      page: section.page,
      children: [],
    }));
  const cleanText = truncate(cleanLines, MAX_PAGE_CHARS);
  const blocks =
    outline.length > 0 ? outline.flatMap((node) => sectionBlocks(node)) : pageBlocks(ordered);
  return {
    url: input.url,
    title: cleanTitle(input.title, '未命名 PDF'),
    canonicalUrl: input.url,
    site: safeHostname(input.url) || 'PDF',
    author: normalizeWhitespace(input.author ?? ''),
    publishedAt: '',
    lang: input.lang ?? 'zh-CN',
    description: truncate(normalizeWhitespace(outline[0]?.text || cleanText), 180),
    wordCount: cleanText.replace(/\s/g, '').length,
    capturedAt: Date.now(),
    contentHash: hashString(
      `${input.url}\n${input.title}\n${cleanText}\n${outline.map((node) => `${node.title}:${node.text}`).join('\n')}`,
    ),
    outline,
    blocks,
    images: [],
    tokenEstimate: Math.ceil(cleanText.length / 2),
    extractionQuality: (input.bookmarks?.length ?? 0) > 0 ? 'high' : 'medium',
    sourceType: 'pdf',
    pdfPageCount: input.pageCount,
  };
}

/**
 * 用 PDF 书签生成小节。书签没有覆盖到的页面不会自动编造标题；
 * 没有书签时返回空大纲，交给用户手动填写页码范围。
 */
export function buildPdfPageContext(input: PdfPageInput): PageContext {
  const ordered = orderedLines(input.lines);
  if (ordered.length === 0) {
    throw new Error('这个 PDF 没有可提取的文字层，可能是扫描件。');
  }
  const bookmarks = (input.bookmarks ?? [])
    .filter((bookmark) => bookmark.title.trim() && bookmark.page >= 1)
    .sort((a, b) => a.page - b.page || (b.y ?? 0) - (a.y ?? 0));
  if (bookmarks.length === 0) {
    return buildPage(input, ordered, []);
  }

  const starts = bookmarks.map((bookmark) => ({
    bookmark,
    start: sectionStartIndex(ordered, bookmark.page, bookmark.y),
  }));
  const sections = starts
    .map(({ bookmark, start }, index) => {
      const end = starts[index + 1]?.start ?? ordered.length;
      return {
        title: bookmark.title,
        level: bookmark.level,
        page: bookmark.page,
        text: lineText(ordered.slice(start, end)),
      };
    })
    .filter((section) => section.text.trim());
  return buildPage(input, ordered, sections);
}

function pageTextFromBlocks(page: PageContext): Map<number, string> {
  const pages = new Map<number, string[]>();
  for (const block of page.blocks ?? []) {
    if (!block.page || !block.text.trim()) continue;
    const current = pages.get(block.page) ?? [];
    current.push(block.text.trim());
    pages.set(block.page, current);
  }
  return new Map(
    [...pages.entries()].map(([pageNumber, chunks]) => [pageNumber, chunks.join('\n')]),
  );
}

/** 把用户填写的页码范围应用到已解析的 PDF 页面快照。 */
export function applyPdfManualOutline(
  page: PageContext,
  entries: PdfManualSection[],
): PageContext {
  if (!page.pdfPageCount) {
    throw new Error('缺少 PDF 页数，无法应用目录。');
  }
  const pages = pageTextFromBlocks(page);
  const sections = entries
    .map((entry) => {
      const chunks: string[] = [];
      for (let pageNumber = entry.startPage; pageNumber <= entry.endPage; pageNumber += 1) {
        const text = pages.get(pageNumber);
        if (text) chunks.push(text);
      }
      return {
        title: entry.title,
        level: 1,
        page: entry.startPage,
        text: chunks.join('\n').trim(),
      };
    })
    .filter((section) => section.text.trim());
  if (sections.length === 0) {
    throw new Error('填写的页码范围里没有可提取的文字。');
  }
  const ordered = (page.blocks ?? [])
    .filter((block): block is PageBlock & { page: number } => Boolean(block.page))
    .sort((left, right) => left.page - right.page)
    .map((block) => ({
      page: block.page,
      y: 0,
      height: 0,
      text: block.text,
    }));
  return buildPage(
    {
      url: page.url,
      title: page.title,
      author: page.author,
      lines: ordered,
      pageCount: page.pdfPageCount,
      lang: page.lang,
    },
    ordered,
    sections,
  );
}

/**
 * 解析手动目录。每行格式：标题 | 起始页-结束页。
 * 只接受从 1 开始、按顺序且互不重叠的页码范围。
 */
export function parsePdfOutlineInput(
  input: string,
  pageCount: number,
): PdfOutlineParseResult {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { error: '请至少填写一个小节。' };
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { error: 'PDF 页数不可用，无法校验目录。' };
  }
  const entries: PdfManualSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const parts = raw.split(/\s*[|｜]\s*/);
    if (parts.length !== 2) {
      return { error: `第 ${index + 1} 行格式不对，应为“标题 | 起始页-结束页”。` };
    }
    const title = parts[0].trim();
    const range = parts[1].match(/^(\d+)(?:\s*[-–—~至]\s*(\d+))?$/);
    if (!title || !range) {
      return { error: `第 ${index + 1} 行格式不对，应为“标题 | 起始页-结束页”。` };
    }
    const startPage = Number(range[1]);
    const endPage = Number(range[2] ?? range[1]);
    if (startPage < 1 || endPage > pageCount || startPage > endPage) {
      return {
        error: `第 ${index + 1} 行页码范围无效，应在 1–${pageCount} 内且起始页不大于结束页。`,
      };
    }
    entries.push({ title, startPage, endPage });
  }
  entries.sort((left, right) => left.startPage - right.startPage);
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].startPage <= entries[index - 1].endPage) {
      return {
        error: `“${entries[index].title}”与“${entries[index - 1].title}”的页码范围重叠。`,
      };
    }
  }
  return { entries };
}
