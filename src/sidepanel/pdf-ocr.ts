import type { OutlineNode, PageContext } from '../shared/types';
import type { OcrImageResponse } from '../shared/messages';
import { sendRuntimeMessage } from '../shared/messages';
import { asErrorMessage } from '../shared/utils';
import { getCachedPdfDoc } from './pdf-loader';

const MAX_RENDER_WIDTH = 1800;
const OCR_LANGUAGE = 'zh-CN';
const ocrCache = new Map<string, string>();

export interface OcrProgress {
  current: number;
  total: number;
  page: number;
}

export interface OcrSectionResult {
  text: string;
  pages: Array<{ page: number; text: string }>;
}

function cacheKey(page: PageContext, pageNumber: number): string {
  return `${page.url}\n${pageNumber}`;
}

async function renderPageJpeg(page: PageContext, pageNumber: number): Promise<string> {
  const doc = getCachedPdfDoc(page);
  if (!doc) {
    throw new Error('当前 PDF 的解析句柄已失效，请重新打开 PDF 或重新选择本地文件后再 OCR。');
  }
  const pdfPage = await doc.getPage(pageNumber);
  try {
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(2.6, MAX_RENDER_WIDTH / Math.max(1, base.width));
    const viewport = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('无法创建 OCR 画布。');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // OCR 只取像素，不需要屏幕刷新；用 print intent 关闭 requestAnimationFrame，
    // 否则后台标签页/不可见侧栏里的 rAF 会被浏览器暂停，渲染永远不结束。
    await pdfPage.render({ canvasContext: context, viewport, intent: 'print' }).promise;
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    pdfPage.cleanup();
  }
}

async function ocrPage(page: PageContext, pageNumber: number): Promise<string> {
  const key = cacheKey(page, pageNumber);
  const cached = ocrCache.get(key);
  if (cached) return cached;
  const image = await renderPageJpeg(page, pageNumber);
  const response = await sendRuntimeMessage<OcrImageResponse>({
    type: 'PS_OCR_IMAGE',
    image,
    language: OCR_LANGUAGE,
  });
  if (!response.ok) {
    throw new Error(response.error ?? `第 ${pageNumber} 页 OCR 失败。`);
  }
  const text = response.text?.trim() ?? '';
  // 空白页允许返回空字符串，由小节层决定是否整体报错。
  ocrCache.set(key, text);
  return text;
}

/**
 * 只 OCR 当前小节涉及的原书页码。结果按 URL + 页码缓存，
 * 同一小节重试或后续聊天不需要重复识别。
 */
export async function ocrPdfSection(
  page: PageContext,
  section: OutlineNode,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrSectionResult> {
  if (!page.needsOcr) {
    return {
      text: section.text,
      pages: section.page ? [{ page: section.page, text: section.text }] : [],
    };
  }
  const start = Math.max(1, section.page ?? 1);
  const end = Math.max(start, section.pageEnd ?? section.page ?? 1);
  const total = end - start + 1;
  if (total > 200) {
    throw new Error(`这一节有 ${total} 页，单次 OCR 上限为 200 页；请把页码范围拆小。`);
  }
  const pages: Array<{ page: number; text: string }> = [];
  for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
    onProgress?.({ current: pageNumber - start + 1, total, page: pageNumber });
    try {
      const text = await ocrPage(page, pageNumber);
      if (text) pages.push({ page: pageNumber, text });
    } catch (error) {
      throw new Error(`第 ${pageNumber} 页：${asErrorMessage(error)}`);
    }
  }
  if (pages.length === 0) throw new Error('这一节没有 OCR 出可用文字。');
  return {
    text: pages.map((item) => `【第 ${item.page} 页】\n${item.text}`).join('\n\n'),
    pages,
  };
}

export function clearOcrCache(): void {
  ocrCache.clear();
}
