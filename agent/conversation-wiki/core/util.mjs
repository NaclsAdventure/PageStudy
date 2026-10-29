/** 共享的小型文件、哈希和 Markdown 工具，不依赖任何第三方包。 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export function expandHome(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith(`~${sep}`) || text.startsWith('~/') || text.startsWith('~\\')) {
    return resolve(homedir(), text.slice(2));
  }
  return resolve(text);
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function shortHash(value, length = 8) {
  return sha256(value).slice(0, Math.max(4, Math.min(32, length)));
}

export function slugify(value, fallback = 'page') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
  const slug = normalized
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

export function escapeLinkLabel(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

export function escapeMarkdownInline(value) {
  return String(value || '').replace(/\r?\n+/g, ' ').trim();
}

export function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** 只有内容真正变化时才落盘，避免自动捕获反复刷新 mtime。 */
export async function writeTextIfChanged(file, content) {
  let previous = null;
  try {
    previous = await readFile(file, 'utf8');
  } catch {
    previous = null;
  }
  if (previous === content) return false;
  await ensureDir(dirname(file));
  await writeFile(file, content, 'utf8');
  return true;
}

export function isPathInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep);
}

export function formatDate(timestamp) {
  const date = new Date(Number(timestamp) || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}
