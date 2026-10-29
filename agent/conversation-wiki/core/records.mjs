/** 会话记录的归一化、保存、合并与读取。 */
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { isRecord, readJson, sha256, slugify, writeJsonAtomic } from './util.mjs';
import { deriveOverview, deriveTitle, normalizeTranscript, transcriptSignature } from './transcript.mjs';
import { vaultPaths } from './config.mjs';

const MAX_SECTIONS = 50;
const MAX_ITEMS = 40;

function normalizeString(value, max = 4000) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function uniqueStrings(values, max = MAX_ITEMS, itemMax = 160) {
  const output = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeString(value, itemMax);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
    if (output.length >= max) break;
  }
  return output;
}

function normalizeSections(values) {
  const output = [];
  for (const raw of Array.isArray(values) ? values : []) {
    if (!isRecord(raw)) continue;
    const title = normalizeString(raw.title, 160);
    const summary = normalizeString(raw.summary, 3000);
    if (!title && !summary) continue;
    output.push({
      title: title || '未命名小节',
      summary,
      keyPoints: uniqueStrings(raw.keyPoints, 20, 240),
    });
    if (output.length >= MAX_SECTIONS) break;
  }
  return output;
}

function normalizeConcepts(values) {
  const output = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    if (!isRecord(raw)) continue;
    const term = normalizeString(raw.term, 120);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    output.push({ term, explanation: normalizeString(raw.explanation, 800) });
    if (output.length >= 80) break;
  }
  return output;
}

export function sanitizeRecordId(value) {
  const text = String(value || '').trim();
  const safe = text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return safe || `session-${sha256(text).slice(0, 12)}`;
}

function normalizeSource(raw) {
  const source = isRecord(raw) ? raw : {};
  return {
    agent: ['pi', 'dsh', 'cli', 'unknown'].includes(source.agent) ? source.agent : 'unknown',
    sessionId: normalizeString(source.sessionId, 200),
    sessionFile: normalizeString(source.sessionFile, 1000),
    model: normalizeString(source.model, 200),
    cwd: normalizeString(source.cwd, 1000),
  };
}

export function normalizeRecord(raw) {
  const source = isRecord(raw) ? raw : {};
  const transcript = normalizeTranscript(source.messages, {
    maxMessages: source.maxMessages,
    maxChars: source.maxChars,
    includeToolMessages: source.includeToolMessages,
  });
  const id = sanitizeRecordId(source.id || source.source?.sessionId || `record-${Date.now()}`);
  const title = normalizeString(source.title, 200) || deriveTitle(transcript.messages);
  const createdAt = Number(source.createdAt) || Date.now();
  const updatedAt = Number(source.updatedAt) || createdAt;
  const enriched = Boolean(source.enriched);
  return {
    version: 1,
    id,
    title,
    overview: normalizeString(source.overview, 1200) || deriveOverview(transcript.messages),
    createdAt,
    updatedAt,
    enriched,
    source: normalizeSource(source.source),
    messages: transcript.messages,
    transcript: {
      truncated: transcript.truncated,
      originalCount: transcript.originalCount,
      charCount: transcript.charCount,
    },
    sections: normalizeSections(source.sections),
    decisions: uniqueStrings(source.decisions, 30, 500),
    actionItems: uniqueStrings(source.actionItems, 30, 500),
    openQuestions: uniqueStrings(source.openQuestions, 30, 500),
    tags: uniqueStrings(source.tags, 40, 80),
    concepts: normalizeConcepts(source.concepts),
    notes: normalizeString(source.notes, 6000),
  };
}

export function recordContentHash(record) {
  const value = {
    title: record.title,
    overview: record.overview,
    messages: record.messages.map((message) => [message.role, message.text]),
    sections: record.sections,
    decisions: record.decisions,
    actionItems: record.actionItems,
    openQuestions: record.openQuestions,
    tags: record.tags,
    concepts: record.concepts,
    notes: record.notes,
    enriched: record.enriched,
  };
  return sha256(JSON.stringify(value)).slice(0, 16);
}

export function recordPageId(record) {
  return `session:${record.id}`;
}

export function recordFilePath(config, id) {
  return join(vaultPaths(config).records, `${sanitizeRecordId(id)}.json`);
}

export async function loadRecord(config, id) {
  const raw = await readJson(recordFilePath(config, id));
  return isRecord(raw) ? normalizeRecord(raw) : null;
}

export async function listRecords(config) {
  const directory = vaultPaths(config).records;
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue;
    const raw = await readJson(join(directory, entry.name));
    if (!isRecord(raw)) continue;
    records.push(normalizeRecord(raw));
  }
  return records.sort((left, right) => right.createdAt - left.createdAt);
}

/**
 * 保存记录。内容哈希未变时保留原 updatedAt，避免自动捕获产生无意义的版本变化。
 * @returns {Promise<{record: object, changed: boolean, file: string}>}
 */
export async function saveRecord(config, rawRecord) {
  const record = normalizeRecord(rawRecord);
  const file = recordFilePath(config, record.id);
  const existingRaw = await readJson(file);
  const existing = isRecord(existingRaw) ? normalizeRecord(existingRaw) : null;
  const nextHash = recordContentHash(record);
  if (existing && recordContentHash(existing) === nextHash) {
    return { record: existing, changed: false, file };
  }
  record.createdAt = existing?.createdAt || record.createdAt || Date.now();
  record.updatedAt = Date.now();
  await writeJsonAtomic(file, record);
  return { record, changed: true, file };
}

export function makeAutoRecord({ id, title, messages, source = {}, maxMessages, maxChars, includeToolMessages }) {
  const transcript = normalizeTranscript(messages, { maxMessages, maxChars, includeToolMessages });
  return normalizeRecord({
    id,
    title: title || deriveTitle(transcript.messages),
    overview: deriveOverview(transcript.messages),
    messages: transcript.messages,
    source,
    enriched: false,
    maxMessages,
    maxChars,
    includeToolMessages,
  });
}

/** 自动捕获只更新转录和来源；已经人工整理过的标题、概览和主题不会被空字段覆盖。 */
export function mergeAutoRecord(existing, auto) {
  if (!existing) return auto;
  if (!existing.enriched) {
    return normalizeRecord({
      ...auto,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    });
  }
  return normalizeRecord({
    ...existing,
    messages: auto.messages,
    transcript: auto.transcript,
    source: { ...existing.source, ...auto.source },
    title: existing.title || auto.title,
    overview: existing.overview || auto.overview,
    enriched: true,
  });
}

export async function saveAutoRecord(config, auto) {
  const existing = await readJson(recordFilePath(config, auto.id));
  const merged = mergeAutoRecord(isRecord(existing) ? normalizeRecord(existing) : null, auto);
  return saveRecord(config, merged);
}

export function applyRecordInput(record, input) {
  if (!isRecord(input)) return record;
  const next = { ...record };
  if (typeof input.title === 'string') next.title = normalizeString(input.title, 200) || record.title;
  if (typeof input.overview === 'string') next.overview = normalizeString(input.overview, 1200);
  if (Array.isArray(input.sections)) next.sections = normalizeSections(input.sections);
  if (Array.isArray(input.decisions)) next.decisions = uniqueStrings(input.decisions, 30, 500);
  if (Array.isArray(input.actionItems)) next.actionItems = uniqueStrings(input.actionItems, 30, 500);
  if (Array.isArray(input.openQuestions)) next.openQuestions = uniqueStrings(input.openQuestions, 30, 500);
  if (Array.isArray(input.tags)) next.tags = uniqueStrings(input.tags, 40, 80);
  if (Array.isArray(input.concepts)) next.concepts = normalizeConcepts(input.concepts);
  if (typeof input.notes === 'string') next.notes = normalizeString(input.notes, 6000);
  next.enriched = true;
  return normalizeRecord(next);
}

export function recordSignature(record) {
  return recordContentHash(record);
}

export function recordSlug(record) {
  return `${slugify(record.title, 'session')}-${sha256(record.id).slice(0, 6)}`;
}

export function transcriptSignatureOf(record) {
  return transcriptSignature({ messages: record.messages });
}
