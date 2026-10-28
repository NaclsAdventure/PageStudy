/**
 * Obsidian / Logseq 等 Markdown 笔记软件的本地落盘。
 *
 * 目录只来自桥接进程环境变量，扩展传相对子目录时也只能落在该根目录内。
 */
import path from 'node:path';
import { access, appendFile, mkdir, writeFile } from 'node:fs/promises';

const ROOT = process.env.PAGESTUDY_MARKDOWN_DIR
  ? path.resolve(process.env.PAGESTUDY_MARKDOWN_DIR)
  : '';

export function markdownEnabled() {
  return Boolean(ROOT);
}

export function markdownStatus() {
  return { enabled: Boolean(ROOT), markdownDir: ROOT };
}

function ensureInsideRoot(candidate) {
  const root = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;
  const resolved = path.resolve(candidate);
  if (resolved !== ROOT && !resolved.startsWith(root)) {
    throw new Error('Markdown 目录超出桥接配置的根目录。');
  }
  return resolved;
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function targetDirectory(directory) {
  if (!ROOT) {
    throw new Error('还没有配置本地 Markdown 目录。请在启动桥接前设置 PAGESTUDY_MARKDOWN_DIR。');
  }
  const raw = String(directory || '').trim();
  if (!raw) return ROOT;
  if (path.isAbsolute(raw)) throw new Error('扩展只能传相对于 Markdown 根目录的子目录。');
  const candidate = ensureInsideRoot(path.resolve(ROOT, raw));
  return candidate;
}

function timestampName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function normalizeNotePath(relativePath) {
  const raw = String(relativePath || '').trim();
  if (!raw) throw new Error('缺少本地笔记路径。');
  if (path.isAbsolute(raw)) throw new Error('本地笔记路径必须是相对路径。');
  const candidate = ensureInsideRoot(path.resolve(ROOT, raw));
  return candidate;
}

export async function createMarkdownNote({ title, markdown, directory }) {
  if (!String(markdown || '').trim()) throw new Error('Markdown 内容不能为空。');
  const baseDir = targetDirectory(directory);
  await mkdir(baseDir, { recursive: true });

  const baseTitle = safeSegment(title) || 'PageStudy 学习记录';
  let file = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? '' : `-${attempt + 1}`;
    const candidate = path.join(baseDir, `${baseTitle} ${timestampName()}${suffix}.md`);
    try {
      await writeFile(candidate, `${markdown.trim()}\n`, { encoding: 'utf8', flag: 'wx' });
      file = candidate;
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  if (!file) throw new Error('无法创建唯一的 Markdown 文件名。');

  const documentId = path.relative(ROOT, file).split(path.sep).join('/');
  return { ok: true, documentId, path: file, url: '' };
}

export async function appendMarkdownNote({ documentId, markdown }) {
  if (!ROOT) {
    throw new Error('还没有配置本地 Markdown 目录。请在启动桥接前设置 PAGESTUDY_MARKDOWN_DIR。');
  }
  if (!String(markdown || '').trim()) throw new Error('Markdown 内容不能为空。');
  const file = normalizeNotePath(documentId);
  try {
    await access(file);
  } catch {
    throw new Error('本地笔记不存在，可能已被移动或删除。');
  }
  const content = markdown.trim();
  const separator = content.startsWith('---') ? '\n\n' : '\n\n---\n\n';
  await appendFile(file, `${separator}${content}\n`, 'utf8');
  return {
    ok: true,
    documentId: path.relative(ROOT, file).split(path.sep).join('/'),
    path: file,
    url: '',
  };
}
