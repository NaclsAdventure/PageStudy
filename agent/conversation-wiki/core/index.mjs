/** Conversation Wiki 的业务编排；Pi、DSH、CLI 共用。 */
import { ensureConfig, describeConfig, vaultPaths } from './config.mjs';
import { buildWiki, writeWiki } from './wiki.mjs';
import {
  applyRecordInput,
  listRecords,
  loadRecord,
  makeAutoRecord,
  normalizeRecord,
  recordPageId,
  saveRecord,
  saveAutoRecord,
} from './records.mjs';
import { deriveTitle } from './transcript.mjs';
import { feishuStatus, publishConversationWiki } from './feishu.mjs';
import { readJson } from './util.mjs';

export * from './config.mjs';
export * from './records.mjs';
export * from './wiki.mjs';
export * from './feishu.mjs';
export * from './transcript.mjs';
export * from './redact.mjs';
export { runLark, larkVersion } from './lark.mjs';

function sourceWithSession(source) {
  return {
    agent: source?.agent || 'unknown',
    sessionId: String(source?.sessionId || ''),
    sessionFile: String(source?.sessionFile || ''),
    model: String(source?.model || ''),
    cwd: String(source?.cwd || ''),
  };
}

async function saveAndBuild(config, record, { publish = false, runLark } = {}) {
  const saved = await saveRecord(config, record);
  const records = await listRecords(config);
  const wiki = buildWiki(records);
  const write = await writeWiki(config, wiki);
  let publishResult;
  if (publish) {
    if (!config.feishu.enabled) {
      publishResult = { ok: false, error: '飞书发布未启用。请先在配置中设置 feishu.enabled=true。' };
    } else {
      try {
        publishResult = await publishConversationWiki(config, wiki, { runLark });
      } catch (error) {
        publishResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  return { saved, records, wiki, write, publish: publishResult };
}

/**
 * 把一次会话保存为自动记录；已人工整理的记录不会被空摘要覆盖。
 */
export async function captureConversation(config, input) {
  const ensured = config || (await ensureConfig());
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const source = sourceWithSession(input?.source);
  const auto = makeAutoRecord({
    id: input?.id || source.sessionId || `session-${Date.now()}`,
    title: input?.title,
    messages,
    source,
    maxMessages: ensured.maxMessages,
    maxChars: ensured.maxChars,
    includeToolMessages: ensured.includeToolMessages,
  });
  const saved = await saveAutoRecord(ensured, auto);
  const records = await listRecords(ensured);
  const wiki = buildWiki(records);
  const write = await writeWiki(ensured, wiki);
  return { saved, records, wiki, write, auto };
}

/**
 * 保存一条结构化会话记录。enrichment 由 Agent 根据会话内容填写。
 */
export async function recordConversation(config, input) {
  const ensured = config || (await ensureConfig());
  const source = sourceWithSession(input?.source);
  const id = input?.id || source.sessionId || `session-${Date.now()}`;
  const auto = makeAutoRecord({
    id,
    title: input?.title,
    messages: input?.messages,
    source,
    maxMessages: ensured.maxMessages,
    maxChars: ensured.maxChars,
    includeToolMessages: ensured.includeToolMessages,
  });
  const existing = await loadRecord(ensured, id).catch(() => null);
  let record = existing?.enriched
    ? normalizeRecord({ ...existing, messages: auto.messages, transcript: auto.transcript, source })
    : auto;
  record = applyRecordInput(record, input?.enrichment || {});
  if (!record.overview) {
    record.overview = auto.overview;
  }
  record.enriched = true;
  const result = await saveAndBuild(ensured, record, {
    publish: Boolean(input?.publish) || Boolean(ensured.autoPublish && ensured.feishu.enabled),
    runLark: input?.runLark,
  });
  return { ...result, record: result.saved.record };
}

/** 只重建本地 Wiki，不触碰云端。 */
export async function rebuildConversationWiki(config) {
  const ensured = config || (await ensureConfig());
  const records = await listRecords(ensured);
  const wiki = buildWiki(records);
  const write = await writeWiki(ensured, wiki);
  return { records, wiki, write };
}

export async function publishConversationWikiNow(config, options = {}) {
  const ensured = config || (await ensureConfig());
  if (!ensured.feishu.enabled && !options.force) {
    throw new Error('飞书发布未启用。请先在配置中设置 feishu.enabled=true。');
  }
  const { wiki } = await rebuildConversationWiki(ensured);
  const result = await publishConversationWiki(ensured, wiki, options);
  return { wiki, result };
}

export async function conversationWikiStatus(config) {
  const ensured = config || (await ensureConfig());
  const paths = vaultPaths(ensured);
  const records = await listRecords(ensured);
  const wikiState = await readJson(paths.wikiState, { pages: {} });
  const published = await feishuStatus(ensured);
  return {
    config: describeConfig(ensured),
    recordCount: records.length,
    latest: records.slice(0, 5).map((record) => ({
      id: record.id,
      pageId: recordPageId(record),
      title: record.title,
      enriched: record.enriched,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })),
    wiki: {
      pages: wikiState?.pages ? Object.keys(wikiState.pages).length : 0,
      root: paths.rootPage,
    },
    feishu: published,
  };
}

export async function initConversationWiki(config) {
  const ensured = config || (await ensureConfig());
  const { wiki, write } = await rebuildConversationWiki(ensured);
  return {
    config: describeConfig(ensured),
    wiki,
    write,
  };
}

export function makeSessionId(prefix = 'session') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function inferTitle(messages, fallback) {
  return deriveTitle(messages, fallback);
}

export { listRecords, loadRecord, buildWiki, writeWiki, applyRecordInput, saveRecord };
