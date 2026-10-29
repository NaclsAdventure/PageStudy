import type { PDFDocumentProxy } from 'pdfjs-dist';
import { asErrorMessage, normalizeWhitespace } from '../shared/utils';
import { buildPdfPageContext, type PdfBookmark, type PdfTextLine } from '../shared/pdf';
import type { PageContext } from '../shared/types';

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const FETCH_TIMEOUT_MS = 45000;

function tooLargeMessage(bytes: number): string {
  const size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `PDF 文件 ${size}，超过 60 MB 上限；大体积扫描版需要先 OCR 或压缩后再导入。`;
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
  height?: number;
  fontName?: string;
}

interface PdfOutlineItem {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
}

interface PdfRow {
  y: number;
  height: number;
  parts: Array<{ x: number; text: string }>;
}

function hasPdfMagic(bytes: Uint8Array): boolean {
  const probe = new TextDecoder('latin1').decode(bytes.slice(0, 1024));
  return probe.includes('%PDF-');
}

function itemText(value: string | undefined): string {
  return normalizeWhitespace(value ?? '');
}

function mergeRowText(parts: Array<{ x: number; text: string }>): string {
  const ordered = [...parts].sort((left, right) => left.x - right.x);
  let text = '';
  for (const part of ordered) {
    const next = itemText(part.text);
    if (!next) continue;
    if (text && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(next)) text += ' ';
    text += next;
  }
  return normalizeWhitespace(text);
}

function rowTexts(items: PdfTextItem[]): PdfTextLine[] {
  const rows: PdfRow[] = [];
  for (const item of items) {
    const text = item.str ?? '';
    const transform = item.transform;
    if (!text.trim() || !transform || transform.length < 6) continue;
    const y = transform[5];
    const x = transform[4];
    const height = Math.abs(item.height ?? transform[3] ?? 0);
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.35));
    if (!row) {
      row = { y, height, parts: [] };
      rows.push(row);
    }
    row.height = Math.max(row.height, height);
    row.parts.push({ x, text });
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => ({
      page: 0,
      y: row.y,
      height: row.height,
      text: mergeRowText(row.parts),
    }))
    .filter((line) => line.text);
}

async function resolveDestinationPage(
  pdf: PDFDocumentProxy,
  dest: unknown,
): Promise<{ page: number; y?: number } | null> {
  if (!dest) return null;
  let resolved: unknown = dest;
  if (typeof dest === 'string') {
    resolved = await pdf.getDestination(dest);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) return null;
  const ref = resolved[0];
  let pageIndex = -1;
  if (typeof ref === 'number') {
    pageIndex = ref;
  } else if (ref && typeof ref === 'object') {
    try {
      pageIndex = await pdf.getPageIndex(ref as never);
    } catch {
      return null;
    }
  }
  if (pageIndex < 0) return null;
  const kind = resolved[1] && typeof resolved[1] === 'object'
    ? (resolved[1] as { name?: unknown }).name
    : undefined;
  let y: number | undefined;
  if (kind === 'XYZ' && typeof resolved[3] === 'number') y = resolved[3];
  if (kind === 'FitH' && typeof resolved[2] === 'number') y = resolved[2];
  return { page: pageIndex + 1, y };
}

async function flattenPdfBookmarks(
  pdf: PDFDocumentProxy,
  items: PdfOutlineItem[],
  level = 1,
): Promise<PdfBookmark[]> {
  const result: PdfBookmark[] = [];
  for (const item of items) {
    const title = normalizeWhitespace(item.title ?? '');
    const destination = title ? await resolveDestinationPage(pdf, item.dest) : null;
    if (title && destination) {
      result.push({
        title,
        page: destination.page,
        level,
        y: destination.y,
      });
    }
    if (item.items?.length) {
      result.push(...(await flattenPdfBookmarks(pdf, item.items, level + 1)));
    }
  }
  return result;
}

async function extractPdf(
  bytes: Uint8Array,
  url: string,
  tabTitle: string,
): Promise<PageContext> {
  // legacy 构建包含对旧版 Chromium/Edge 的语法与 Promise 兼容处理，避免 116–118 直接报错。
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfWorkerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    isEvalSupported: false,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  try {
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页，当前版本暂不支持整本解析。`);
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = (metadata?.info ?? {}) as { Title?: unknown; Author?: unknown };
    const lines: PdfTextLine[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const items = content.items
          .filter((item) => Boolean(item && typeof item === 'object' && 'str' in item))
          .map((item) => item as unknown as PdfTextItem);
        lines.push(...rowTexts(items).map((line) => ({ ...line, page: pageNumber })));
      } finally {
        page.cleanup();
      }
    }
    const bookmarks = await flattenPdfBookmarks(
      pdf,
      (await pdf.getOutline().catch(() => null)) ?? [],
    );
    const title =
      normalizeWhitespace(typeof info.Title === 'string' ? info.Title : '') ||
      normalizeWhitespace(tabTitle) ||
      url.split('/').pop() ||
      '未命名 PDF';
    return buildPdfPageContext({
      url,
      title,
      author: typeof info.Author === 'string' ? info.Author : '',
      lines,
      bookmarks,
      pageCount: pdf.numPages,
    });
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
}

/**
 * 直接抓取并解析 PDF。返回 null 表示响应不是 PDF，调用方应继续走网页路径。
 */
export async function loadPdfPage(
  url: string,
  tabTitle: string,
): Promise<PageContext | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`下载 PDF 失败：HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_PDF_BYTES) {
      throw new Error(tooLargeMessage(declaredLength));
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/application\/pdf/i.test(contentType) && !hasPdfMagic(bytes)) return null;
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new Error(tooLargeMessage(bytes.byteLength));
    }
    return await extractPdf(bytes, url, tabTitle);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('读取 PDF 超时；可以稍后重试，或选择本地 PDF。');
    }
    if (/^file:/i.test(url)) {
      throw new Error(
        '浏览器未允许扩展直接读取本地文件。请在下方选择本地 PDF，或在扩展管理页开启“允许访问文件网址”。',
      );
    }
    throw new Error(asErrorMessage(error));
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * 读取用户通过 file input 主动选择的 PDF。
 * Chrome/Edge 默认关闭扩展的 file:// 访问，这个入口不依赖该开关。
 */
export async function loadPdfFile(
  file: File,
  url: string,
  title: string,
): Promise<PageContext> {
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(tooLargeMessage(file.size));
  }
  if (file.size === 0) {
    throw new Error('选择的 PDF 文件是空的。');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasPdfMagic(bytes) && !/\.pdf$/i.test(file.name)) {
    throw new Error('选择的文件不是 PDF。');
  }
  return extractPdf(bytes, url.trim() || file.name, title.trim() || file.name);
}
