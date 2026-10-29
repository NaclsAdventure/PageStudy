import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OCR_SCRIPT = path.join(MODULE_DIR, 'windows-ocr.ps1');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const OCR_TIMEOUT_MS = 90_000;

function powershellPath() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidate = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

export function normalizeOcrText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) =>
      line
        // Windows OCR 会在每个汉字之间插空格，直接喂给模型会浪费大量 token。
        .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/([\u3400-\u9fff])\s+(?=[，。；：、！？）》」』】])/g, '$1')
        .replace(/([，。；：、！？）》」』】])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/([（《「『【“])\s+(?=[\u3400-\u9fff])/g, '$1')
        .replace(/([\u3400-\u9fff])\s+(?=[（《「『【“])/g, '$1')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    // 扫描书页脚的盗版站水印不承载正文，避免污染模型上下文。
    .filter((line) => !/see\s*more|visit\s*:?\s*https?|home\s*of\s*pdf/i.test(line))
    .join('\n');
}

function decodeImage(image) {
  if (typeof image !== 'string' || !image.trim()) {
    throw new Error('缺少 OCR 图片。');
  }
  const raw = image.replace(/^data:image\/[a-z0-9+.-]+;base64,/i, '').trim();
  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('OCR 图片不是有效的 base64。');
  }
  if (buffer.byteLength === 0) throw new Error('OCR 图片为空。');
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('OCR 图片超过 8 MB，无法识别。');
  }
  return buffer;
}

function runOcr(inputPath, outputPath, language) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        OCR_SCRIPT,
        '-Path',
        inputPath,
        '-OutputPath',
        outputPath,
        '-Language',
        language,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Windows OCR 超时。'));
    }, OCR_TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法启动 Windows OCR：${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Windows OCR 失败：${stderr.trim() || `退出码 ${code}`}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * 用 Windows 自带 OCR 识别一张页面截图。
 * 只接收图片内容，不接收路径，避免桥接被当作任意文件读取器。
 */
export async function ocrImage({ image, language = 'zh-CN' } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('当前实时 OCR 只支持 Windows 自带的 OCR 引擎。');
  }
  const cleanLanguage = String(language || 'zh-CN').trim();
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(cleanLanguage)) {
    throw new Error('OCR 语言格式不正确。');
  }
  const buffer = decodeImage(image);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pagestudy-ocr-'));
  const inputPath = path.join(dir, 'page.png');
  const outputPath = path.join(dir, 'page.txt');
  try {
    await writeFile(inputPath, buffer);
    await runOcr(inputPath, outputPath, cleanLanguage);
    return normalizeOcrText(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function ocrStatus() {
  if (process.platform !== 'win32') {
    return { ok: false, error: '实时 OCR 需要 Windows 自带的 OCR 引擎。' };
  }
  if (!existsSync(OCR_SCRIPT)) {
    return { ok: false, error: '缺少 windows-ocr.ps1 脚本。' };
  }
  return { ok: true, engine: 'windows-ocr' };
}
