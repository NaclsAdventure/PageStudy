import type { PDFDocumentProxy } from 'pdfjs-dist';
import { asErrorMessage, normalizeWhitespace } from '../shared/utils';
import { buildPdfPageContext, type PdfBookmark, type PdfTextLine } from '../shared/pdf';
import type { PageContext } from '../shared/types';

const MAX_HTTP_PDF_BYTES = 60 * 1024 * 1024;
const MAX_LOCAL_PDF_BYTES = 512 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const MAX_SCANNED_PAGES = 2000;
const FETCH_TIMEOUT_MS = 45000;
const PROBE_PAGES = 6;
const INITIAL_RANGE_BYTES = 64 * 1024;

function tooLargeMessage(bytes: number, limit: number, label: string): string {
  const size = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  const max = `${(limit / (1024 * 1024)).toFixed(0)} MB`;
  return `${label} ${size}，超过 ${max} 上限。大体积扫描版请改用本地文件选择器；PDF 只在扩展内按页读取。`;
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

interface CachedPdf {
  url: string;
  pageCount: number;
  doc: PDFDocumentProxy;
}

let cachedPdf: CachedPdf | null = null;

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

/** 渲染 OCR 需要保留 PDFDocumentProxy；切到普通网页或加载新 PDF 时释放。 */
export function getCachedPdfDoc(page: PageContext): PDFDocumentProxy | null {
  if (!cachedPdf) return null;
  return cachedPdf.url === page.url && cachedPdf.pageCount === (page.pdfPageCount ?? 0)
    ? cachedPdf.doc
    : null;
}

export async function disposeCachedPdfDoc(): Promise<void> {
  const current = cachedPdf;
  cachedPdf = null;
  if (current) await current.doc.destroy().catch(() => undefined);
}

async function cachePdfDoc(page: PageContext, doc: PDFDocumentProxy): Promise<void> {
  await disposeCachedPdfDoc();
  cachedPdf = {
    url: page.url,
    pageCount: page.pdfPageCount ?? 0,
    doc,
  };
}

async function loadPdfJs() {
  // legacy 构建包含对旧版 Chromium/Edge 的语法与 Promise 兼容处理，避免 116–118 直接报错。
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfWorkerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  return pdfjsLib;
}

/**
 * 用 File.slice 按需读取范围，避免把 400 MB 的扫描书一次性读进侧栏内存。
 */
function createFileRangeTransport(
  pdfjsLib: Awaited<ReturnType<typeof loadPdfJs>>,
  file: File,
  initialData: Uint8Array,
) {
  class FileRangeTransport extends pdfjsLib.PDFDataRangeTransport {
    private readonly file: File;

    constructor() {
      super(file.size, initialData);
      this.file = file;
    }

    override requestDataRange(begin: number, end: number): void {
      void this.file
        .slice(begin, end)
        .arrayBuffer()
        .then((buffer) => {
          this.onDataRange(begin, new Uint8Array(buffer));
        })
        .catch(() => {
          // PDF.js 的范围读取接口没有错误回调；失败时中止文档加载，由上层显示可读错误。
          this.abort();
        });
    }
  }

  return new FileRangeTransport();
}

function meaningfulText(lines: PdfTextLine[]): string {
  return lines
    .map((line) =>
      line.text
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/see\s+more\s+please\s+visit/gi, ' ')
        .replace(/homeofpdf/gi, ' ')
        .trim(),
    )
    .filter((line) => /[\u3400-\u9fffA-Za-z]/.test(line))
    .filter((line) => !/^[\d\s.,:;()（）\-]+$/.test(line))
    .join('\n');
}

/** 抽样检查文字层；只有水印/页码的扫描书会被识别出来。 */
async function detectScanned(pdf: PDFDocumentProxy): Promise<boolean> {
  const candidates = new Set<number>([1, 2, 3]);
  if (pdf.numPages > 3) {
    candidates.add(Math.ceil(pdf.numPages / 2));
    candidates.add(pdf.numPages);
  }
  let sample = '';
  for (const pageNumber of [...candidates].slice(0, PROBE_PAGES)) {
    if (pageNumber > pdf.numPages) continue;
    const page = await pdf.getPage(pageNumber);
    try {
      const content = await page.getTextContent();
      const items = content.items
        .filter((item) => Boolean(item && typeof item === 'object' && 'str' in item))
        .map((item) => item as unknown as PdfTextItem);
      sample += `${meaningfulText(rowTexts(items))}\n`;
    } finally {
      page.cleanup();
    }
  }
  const compact = sample.replace(/\s/g, '');
  return compact.length < 80;
}

async function extractPdfDocument(
  pdf: PDFDocumentProxy,
  url: string,
  tabTitle: string,
): Promise<PageContext> {
  try {
    const pageCount = pdf.numPages;
    const metadata = await pdf.getMetadata().catch(() => null);
    const info = (metadata?.info ?? {}) as { Title?: unknown; Author?: unknown };
    const bookmarks = await flattenPdfBookmarks(
      pdf,
      (await pdf.getOutline().catch(() => null)) ?? [],
    );
    const title =
      normalizeWhitespace(typeof info.Title === 'string' ? info.Title : '') ||
      normalizeWhitespace(tabTitle) ||
      url.split('/').pop() ||
      '未命名 PDF';
    const needsOcr = await detectScanned(pdf);
    if (needsOcr && pageCount > MAX_SCANNED_PAGES) {
      throw new Error(`扫描版 PDF 超过 ${MAX_SCANNED_PAGES} 页，暂不支持逐节 OCR。`);
    }
    if (!needsOcr && pageCount > MAX_PDF_PAGES) {
      throw new Error(`PDF 超过 ${MAX_PDF_PAGES} 页，当前版本暂不支持整本解析。`);
    }

    const lines: PdfTextLine[] = [];
    if (!needsOcr) {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
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
    }

    const page = buildPdfPageContext({
      url,
      title,
      author: typeof info.Author === 'string' ? info.Author : '',
      lines,
      bookmarks,
      pageCount,
      needsOcr,
    });
    if (needsOcr) {
      await cachePdfDoc(page, pdf);
    } else {
      // 新文件是普通文字 PDF 时，旧扫描版的渲染句柄没有继续保留的必要。
      await disposeCachedPdfDoc();
      await pdf.destroy().catch(() => undefined);
    }
    return page;
  } catch (error) {
    await pdf.destroy().catch(() => undefined);
    throw error;
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
    if (declaredLength > MAX_HTTP_PDF_BYTES) {
      throw new Error(tooLargeMessage(declaredLength, MAX_HTTP_PDF_BYTES, '远端 PDF'));
    }
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/application\/pdf/i.test(contentType) && !hasPdfMagic(bytes)) return null;
    if (bytes.byteLength > MAX_HTTP_PDF_BYTES) {
      throw new Error(tooLargeMessage(bytes.byteLength, MAX_HTTP_PDF_BYTES, '远端 PDF'));
    }
    const pdfjsLib = await loadPdfJs();
    const pdf = await pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false,
      useWorkerFetch: false,
    }).promise;
    return await extractPdfDocument(pdf, url, tabTitle);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('读取 PDF 超时；可以稍后重试，或选择本地 PDF。');
    }
    const message = asErrorMessage(error);
    // 只把浏览器的 file:// 权限/网络拒绝翻译成操作提示；体积、解析错误要原样保留。
    if (
      /^file:/i.test(url) &&
      /failed to fetch|not allowed|permission|networkerror|文件访问|无法加载/i.test(message)
    ) {
      throw new Error(
        '浏览器未允许扩展直接读取本地文件。请在下方选择本地 PDF，或在扩展管理页开启“允许访问文件网址”。',
      );
    }
    throw new Error(message);
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * 读取用户通过 file input 主动选择的 PDF。
 * 大文件用范围读取，扫描版不整本提取文字，等用户逐节触发 OCR。
 */
export async function loadPdfFile(
  file: File,
  url: string,
  title: string,
): Promise<PageContext> {
  if (file.size > MAX_LOCAL_PDF_BYTES) {
    throw new Error(tooLargeMessage(file.size, MAX_LOCAL_PDF_BYTES, '本地 PDF'));
  }
  if (file.size === 0) {
    throw new Error('选择的 PDF 文件是空的。');
  }
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!hasPdfMagic(head) && !/\.pdf$/i.test(file.name)) {
    throw new Error('选择的文件不是 PDF。');
  }
  const pdfjsLib = await loadPdfJs();
  const initialData = new Uint8Array(
    await file.slice(0, Math.min(file.size, INITIAL_RANGE_BYTES)).arrayBuffer(),
  );
  const transport = createFileRangeTransport(pdfjsLib, file, initialData);
  const pdf = await pdfjsLib.getDocument({
    range: transport,
    isEvalSupported: false,
    useWorkerFetch: false,
  }).promise;
  return extractPdfDocument(pdf, url.trim() || file.name, title.trim() || file.name);
}
