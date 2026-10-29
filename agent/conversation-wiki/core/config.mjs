/** 读取和写入 Conversation Wiki 的共享配置；Pi 与 DSH 使用同一份配置。 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { expandHome, isRecord, readJson, writeJsonAtomic } from './util.mjs';

export const DEFAULT_ROOT_TITLE = '会话知识库';
export const CONFIG_SCHEMA_VERSION = 1;

export function getHome() {
  return expandHome(process.env.CONVERSATION_WIKI_HOME || join(homedir(), '.conversation-wiki'));
}

export function getConfigPath(home = getHome()) {
  return join(home, 'config.json');
}

export function defaultConfig(home = getHome()) {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    vault: join(home, 'vault'),
    autoCapture: true,
    autoPublish: false,
    captureSubagents: false,
    includeToolMessages: false,
    maxMessages: 400,
    maxChars: 120_000,
    feishu: {
      enabled: false,
      space: 'my_library',
      rootTitle: DEFAULT_ROOT_TITLE,
      origin: '',
    },
  };
}

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

export function normalizeConfig(raw, home = getHome()) {
  const fallback = defaultConfig(home);
  if (!isRecord(raw)) return fallback;
  const feishu = isRecord(raw.feishu) ? raw.feishu : {};
  const vault = expandHome(raw.vault) || fallback.vault;
  const maxMessages = Number(raw.maxMessages);
  const maxChars = Number(raw.maxChars);
  const space = String(feishu.space || fallback.feishu.space).trim();
  const rootTitle = String(feishu.rootTitle || fallback.feishu.rootTitle).trim();

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    vault,
    autoCapture: typeof raw.autoCapture === 'boolean' ? raw.autoCapture : fallback.autoCapture,
    autoPublish: typeof raw.autoPublish === 'boolean' ? raw.autoPublish : fallback.autoPublish,
    captureSubagents:
      typeof raw.captureSubagents === 'boolean' ? raw.captureSubagents : fallback.captureSubagents,
    includeToolMessages:
      typeof raw.includeToolMessages === 'boolean'
        ? raw.includeToolMessages
        : fallback.includeToolMessages,
    maxMessages:
      Number.isFinite(maxMessages) && maxMessages > 0
        ? Math.max(20, Math.min(2000, Math.round(maxMessages)))
        : fallback.maxMessages,
    maxChars:
      Number.isFinite(maxChars) && maxChars > 0
        ? Math.max(10_000, Math.min(500_000, Math.round(maxChars)))
        : fallback.maxChars,
    feishu: {
      enabled: typeof feishu.enabled === 'boolean' ? feishu.enabled : fallback.feishu.enabled,
      space: space || fallback.feishu.space,
      rootTitle: (rootTitle || fallback.feishu.rootTitle).slice(0, 80),
      origin: normalizeOrigin(feishu.origin),
    },
  };
}

export async function loadConfig(home = getHome()) {
  let raw = null;
  try {
    raw = JSON.parse(await readFile(getConfigPath(home), 'utf8'));
  } catch {
    raw = null;
  }
  return normalizeConfig(raw, home);
}

export async function saveConfig(config, home = getHome()) {
  const normalized = normalizeConfig(config, home);
  await writeJsonAtomic(getConfigPath(home), normalized);
  return normalized;
}

export function vaultPaths(config) {
  const vault = config.vault;
  const meta = join(vault, '.conversation-wiki');
  return {
    vault,
    meta,
    records: join(meta, 'records'),
    indexes: join(meta, 'indexes'),
    sessions: join(vault, 'sessions'),
    topics: join(vault, 'topics'),
    concepts: join(vault, 'concepts'),
    rootPage: join(vault, 'index.md'),
    wikiState: join(meta, 'wiki-state.json'),
    feishuState: join(meta, 'feishu-state.json'),
  };
}

/** 创建配置和目录；已有配置不会被覆盖。 */
export async function ensureConfig(home = getHome()) {
  await mkdir(home, { recursive: true });
  let raw = null;
  try {
    raw = JSON.parse(await readFile(getConfigPath(home), 'utf8'));
  } catch {
    raw = null;
  }
  const config = normalizeConfig(raw, home);
  if (raw === null) {
    await writeJsonAtomic(getConfigPath(home), config);
  }
  const paths = vaultPaths(config);
  for (const directory of [paths.vault, paths.meta, paths.records, paths.indexes, paths.sessions, paths.topics, paths.concepts]) {
    await mkdir(directory, { recursive: true });
  }
  return config;
}

export function describeConfig(config, home = getHome()) {
  const paths = vaultPaths(config);
  return {
    home,
    configFile: getConfigPath(home),
    vault: config.vault,
    autoCapture: config.autoCapture,
    autoPublish: config.autoPublish && config.feishu.enabled,
    includeToolMessages: config.includeToolMessages,
    maxMessages: config.maxMessages,
    maxChars: config.maxChars,
    feishu: {
      enabled: config.feishu.enabled,
      space: config.feishu.space,
      rootTitle: config.feishu.rootTitle,
      origin: config.feishu.origin,
    },
    paths,
  };
}

export const CONFIG_HINT = [
  '配置文件：~/.conversation-wiki/config.json',
  '常用项：autoCapture、autoPublish、feishu.enabled、feishu.rootTitle、feishu.origin。',
].join('\n');

export { readJson };
