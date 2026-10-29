import type { OcrImageResponse } from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { asErrorMessage } from '../shared/utils';
import { fetchBridge, parseBridgeResponse } from './bridge';

/**
 * 调用本机桥接的 Windows OCR。图片只在本机回环传输，不经过模型或云端。
 */
export async function ocrImage(image: string, language = 'zh-CN'): Promise<OcrImageResponse> {
  try {
    if (!image.trim()) throw new Error('缺少待识别的页面图片。');
    const settings = await loadSettings();
    const response = await fetchBridge(
      settings.feishu,
      '/api/ocr',
      {
        method: 'POST',
        body: JSON.stringify({ image, language }),
      },
      120_000,
    );
    const data = await parseBridgeResponse(response);
    if (!response.ok || data.ok === false) {
      throw new Error(data.error ?? `OCR 失败：HTTP ${response.status}`);
    }
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    return { ok: true, text };
  } catch (error) {
    const message = asErrorMessage(error);
    if (/failed to fetch|networkerror|fetch failed|无法连接/i.test(message)) {
      return {
        ok: false,
        error: '无法连接本地桥接。请先在项目目录运行 npm run bridge，并确认桥接已重启且 /health 返回 ocr: true。',
      };
    }
    return { ok: false, error: message };
  }
}
