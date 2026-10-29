/** 把本地 Conversation Wiki 发布到飞书个人文档库。 */
import { publishWiki } from './feishu-publisher.mjs';
import { runLark as defaultRunLark } from './lark.mjs';
import { readJson, writeJsonAtomic } from './util.mjs';
import { vaultPaths } from './config.mjs';

function toFeishuPayload(wiki, state, config) {
  return {
    root: {
      title: config.feishu.rootTitle,
      markdown: wiki.root.markdown,
      hash: wiki.root.hash,
    },
    categories: wiki.categories.map((page) => ({
      key: page.category,
      title: page.title,
      markdown: page.markdown,
      hash: page.hash,
    })),
    pages: [...wiki.sessionPages, ...wiki.tagPages, ...wiki.conceptPages].map((page) => ({
      id: page.id,
      kind: page.kind === 'session' ? 'note' : page.kind,
      category: page.category,
      title: page.title,
      markdown: page.markdown,
      hash: page.hash,
    })),
    state,
  };
}

export async function loadFeishuState(config) {
  return readJson(vaultPaths(config).feishuState);
}

export async function feishuStatus(config) {
  const state = await loadFeishuState(config);
  return {
    enabled: config.feishu.enabled,
    space: config.feishu.space,
    rootTitle: config.feishu.rootTitle,
    origin: config.feishu.origin,
    published: Boolean(state?.root?.url),
    rootUrl: state?.root?.url || '',
    pages: state?.pages ? Object.keys(state.pages).length : 0,
    lastPublishedAt: state?.lastPublishedAt || 0,
    lastError: state?.lastError || '',
  };
}

/**
 * @param {object} config 归一化配置
 * @param {object} wiki buildWiki 的结果
 * @param {{runLark?: Function, state?: object|null, force?: boolean}} [options]
 */
export async function publishConversationWiki(config, wiki, options = {}) {
  if (!config.feishu.enabled && !options.force) {
    throw new Error('飞书发布未启用。请先在配置中设置 feishu.enabled=true。');
  }
  let state = options.state === undefined ? await loadFeishuState(config) : options.state;
  if (!config.feishu.origin && !state?.root?.url) {
    throw new Error('缺少 feishu.origin。请填写租户地址，例如 https://your-tenant.feishu.cn。');
  }
  const attempts = Math.max(1, Math.min(3, Number(options.attempts) || 2));
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await publishWiki({
      runLark: options.runLark || defaultRunLark,
      payload: toFeishuPayload(wiki, state, config),
      webOrigin: config.feishu.origin,
    });
    if (result?.ok) break;
    const error = String(result?.error || '');
    const retryable = /超时|timeout|ECONN|network|fetch failed|rate limit|429|5\d\d/i.test(error);
    if (!retryable || attempt >= attempts) break;
    state = result.state || state;
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  const nextState = result?.state
    ? {
        ...result.state,
        ...(result.ok ? {} : { lastError: String(result.error || '发布失败').slice(0, 1000) }),
      }
    : null;
  if (nextState) await writeJsonAtomic(vaultPaths(config).feishuState, nextState);
  return { ...result, state: nextState || undefined };
}
