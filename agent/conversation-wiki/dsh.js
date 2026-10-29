/**
 * DeepSeek Harness（DSH）原生插件。
 *
 * 在每轮结束时自动捕获当前会话，注册 conversation_wiki 工具和技能，
 * 数据写入与 Pi 扩展共享的 ~/.conversation-wiki。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureConversation,
  conversationWikiStatus,
  initConversationWiki,
  loadConfig,
  publishConversationWikiNow,
  recordConversation,
} from './core/index.mjs';
import { deriveTitle, normalizeRole, transcriptSignature } from './core/transcript.mjs';
import { loadRecord } from './core/records.mjs';

export const name = 'conversation-wiki';
export const inject = ['tools', 'sessions'];

const packageRoot = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(packageRoot, 'skills', 'conversation-wiki');
const DESCRIPTION =
  '把当前会话整理并保存到本地 Conversation Wiki（会话/标签/概念页互相反链），可按配置发布到飞书个人文档库。';

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool-call' || block.type === 'toolCall') {
      parts.push(`[调用工具：${block.name || block.toolName || 'unknown'}]`);
    } else if (block.type === 'image') parts.push('[图片]');
  }
  return parts.join('\n');
}

function modelOfMessage(message) {
  const source = message?.source || message?.metadata || {};
  const provider = source.provider || source.providerId || '';
  const model = source.model || source.modelId || message?.model || '';
  return [provider, model].filter(Boolean).join('/');
}

function extractDshMessages(session) {
  const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [];
  return messages.map((message) => ({
    role: normalizeRole(message?.role),
    text: textFromContent(message?.content ?? message?.text),
    timestamp: Number(message?.timestamp) || 0,
    toolName: message?.toolName || message?.name || '',
    model: modelOfMessage(message),
  }));
}

function sourceOfAgent(agent) {
  const session = agent?.session;
  const messages = extractDshMessages(session);
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  return {
    messages,
    source: {
      agent: 'dsh',
      sessionId: String(session?.id || agent?.id || ''),
      sessionFile: String(session?.filePath || session?.header?.sessionFile || ''),
      model: lastAssistant?.model || '',
      cwd: String(session?.header?.cwd || ''),
    },
  };
}

function isSubagent(agent) {
  const header = agent?.session?.header;
  return Boolean(header?.parentSession || header?.delegationDepth);
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function filterMessages(messages, config) {
  return config.includeToolMessages ? messages : messages.filter((message) => message.role !== 'tool');
}

function log(ctx, message) {
  try {
    ctx.logger?.warn?.(`conversation-wiki: ${message}`);
  } catch {
    // 日志失败不能影响会话。
  }
}

function stripFrontmatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function registerSkill(ctx) {
  const skills = ctx.get?.('skills');
  if (!skills) return;
  try {
    const content = stripFrontmatter(
      readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'),
    );
    const register = () =>
      skills.register({
        name: 'conversation-wiki',
        description: DESCRIPTION,
        whenToUse:
          '当用户要求把当前会话整理成知识库/Wiki、保存会话记录、建立标签和概念页，或发布会话知识到飞书时使用。',
        content,
        resourceBase: { kind: 'directory', path: skillRoot },
      });
    if (typeof ctx.effect === 'function') ctx.effect(register);
    else register();
  } catch (error) {
    log(ctx, `注册技能失败：${safeErrorMessage(error)}`);
  }
}

export function apply(ctx) {
  registerSkill(ctx);
  const lastCaptures = new Map();
  let publishTimer = null;
  let publishing = false;

  function schedulePublish() {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(async () => {
      if (publishing) return;
      publishing = true;
      try {
        const config = await loadConfig();
        if (config.autoPublish && config.feishu.enabled) {
          const result = await publishConversationWikiNow(config);
          if (!result.result?.ok) {
            log(ctx, `自动发布失败：${result.result?.error || '未知错误'}`);
          }
        }
      } catch (error) {
        log(ctx, `自动发布失败：${safeErrorMessage(error)}`);
      } finally {
        publishing = false;
      }
    }, 6000);
    publishTimer.unref?.();
  }

  async function capture(agent) {
    if (!agent?.session) return null;
    const config = await loadConfig();
    if (!config.autoCapture) return null;
    if (!config.captureSubagents && isSubagent(agent)) return null;
    const { messages: allMessages, source } = sourceOfAgent(agent);
    const messages = filterMessages(allMessages, config);
    if (!messages.some((message) => message.role === 'user' || message.role === 'assistant')) {
      return null;
    }
    const signature = transcriptSignature({ messages });
    const previous = lastCaptures.get(agent.id);
    if (previous === signature) return null;
    const existing = await loadRecord(config, source.sessionId || agent.id);
    if (existing && transcriptSignature({ messages: existing.messages }) === signature) {
      lastCaptures.set(agent.id, signature);
      return null;
    }
    const result = await captureConversation(config, {
      id: source.sessionId || agent.id,
      title: deriveTitle(messages),
      messages,
      source,
    });
    lastCaptures.set(agent.id, signature);
    if (config.autoPublish && config.feishu.enabled) schedulePublish();
    return result;
  }

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    try {
      await capture(agent);
    } catch (error) {
      log(ctx, `自动捕获失败：${safeErrorMessage(error)}`);
    }
  });

  ctx.tools.register({
    name: 'conversation_wiki',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'capture', 'publish', 'status', 'init'],
          description:
            'record：用结构化摘要更新当前会话；capture：只保存原始转录；publish：发布到飞书；status：查看状态；init：初始化目录。',
        },
        title: { type: 'string', description: '会话标题；省略时从首条用户消息推导。' },
        overview: { type: 'string', description: '2-4 句会话概览。' },
        tags: { type: 'array', items: { type: 'string' }, description: '3-8 个主题标签。' },
        concepts: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['term'],
            properties: {
              term: { type: 'string', description: '概念名。' },
              explanation: { type: 'string', description: '一句话解释。' },
            },
          },
          description: '会话中出现的可复用概念。',
        },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              title: { type: 'string', description: '小节标题。' },
              summary: { type: 'string', description: '小节摘要。' },
              keyPoints: { type: 'array', items: { type: 'string' }, description: '关键点。' },
            },
          },
          description: '按会话脉络拆分的小节。',
        },
        decisions: { type: 'array', items: { type: 'string' }, description: '已达成的决策。' },
        actionItems: { type: 'array', items: { type: 'string' }, description: '后续行动项。' },
        openQuestions: { type: 'array', items: { type: 'string' }, description: '尚未解决的问题。' },
        notes: { type: 'string', description: '人工补充笔记。' },
        publish: { type: 'boolean', description: 'record 完成后是否立即发布到飞书；需要配置启用。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'ok',
          'action',
          'message',
          'title',
          'vault',
          'sessions',
          'tags',
          'concepts',
          'changed',
          'published',
        ],
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          title: { type: 'string' },
          vault: { type: 'string' },
          sessions: { type: 'integer' },
          tags: { type: 'integer' },
          concepts: { type: 'integer' },
          changed: { type: 'boolean' },
          published: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const agent = exec.agent;
      const config = await loadConfig();
      const session = agent?.session;
      if (!session && ['record', 'capture'].includes(args.action)) {
        throw new Error('conversation_wiki 需要当前 Agent 的会话；请在会话中调用。');
      }

      if (args.action === 'init') {
        const result = await initConversationWiki(config);
        return {
          ok: true,
          action: args.action,
          message: `已初始化 Conversation Wiki：${result.config.vault}`,
          title: '',
          vault: result.config.vault,
          sessions: result.wiki.counts.sessions,
          tags: result.wiki.counts.tags,
          concepts: result.wiki.counts.concepts,
          changed: result.write.written > 0,
          published: false,
        };
      }

      if (args.action === 'status') {
        const status = await conversationWikiStatus(config);
        return {
          ok: true,
          action: args.action,
          message: [
            `本地记录 ${status.recordCount} 条，Wiki ${status.wiki.pages} 页。`,
            `飞书：${status.feishu.enabled ? '已启用' : '未启用'}${
              status.feishu.published ? `，已发布 ${status.feishu.pages} 页` : ''
            }。`,
            `路径：${status.wiki.root}`,
          ].join('\n'),
          title: '',
          vault: status.config.vault,
          sessions: status.recordCount,
          tags: 0,
          concepts: 0,
          changed: false,
          published: status.feishu.published,
        };
      }

      if (args.action === 'publish') {
        const { wiki, result } = await publishConversationWikiNow(config);
        return {
          ok: Boolean(result.ok),
          action: args.action,
          message: result.ok
            ? `已发布 ${wiki.counts.sessions} 条会话、${wiki.counts.tags} 个标签、${wiki.counts.concepts} 个概念；新建 ${result.created || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}。${result.state?.root?.url ? `\n${result.state.root.url}` : ''}`
            : `发布失败：${result.error || '未知错误'}`,
          title: '',
          vault: config.vault,
          sessions: wiki.counts.sessions,
          tags: wiki.counts.tags,
          concepts: wiki.counts.concepts,
          changed: false,
          published: Boolean(result.ok),
        };
      }

      if (args.action === 'capture') {
        const { messages: allMessages, source } = sourceOfAgent(agent);
        const messages = filterMessages(allMessages, config);
        const result = await captureConversation(config, {
          id: source.sessionId || agent.id,
          title: args.title || deriveTitle(messages),
          messages,
          source,
        });
        return {
          ok: true,
          action: args.action,
          message: result.saved.changed
            ? `已捕获会话并更新 Wiki：${result.saved.record.title}`
            : `会话没有变化，已保持现有 Wiki。`,
          title: result.saved.record.title,
          vault: config.vault,
          sessions: result.wiki.counts.sessions,
          tags: result.wiki.counts.tags,
          concepts: result.wiki.counts.concepts,
          changed: result.saved.changed,
          published: false,
        };
      }

      const { messages: allMessages, source } = sourceOfAgent(agent);
      const messages = filterMessages(allMessages, config);
      const result = await recordConversation(config, {
        id: source.sessionId || agent.id,
        messages,
        source,
        title: args.title,
        publish: Boolean(args.publish),
        enrichment: {
          title: args.title,
          overview: args.overview,
          tags: args.tags,
          concepts: args.concepts,
          sections: args.sections,
          decisions: args.decisions,
          actionItems: args.actionItems,
          openQuestions: args.openQuestions,
          notes: args.notes,
        },
      });
      const publishText = result.publish
        ? result.publish.ok
          ? `\n飞书：新建 ${result.publish.created || 0}，更新 ${result.publish.updated || 0}，跳过 ${result.publish.skipped || 0}。`
          : `\n飞书：未发布（${result.publish.error}）。`
        : '';
      return {
        ok: true,
        action: args.action,
        message: `已保存会话：${result.record.title}\n本地 Wiki：${result.wiki.counts.sessions} 条会话、${result.wiki.counts.tags} 个标签、${result.wiki.counts.concepts} 个概念。${publishText}`,
        title: result.record.title,
        vault: config.vault,
        sessions: result.wiki.counts.sessions,
        tags: result.wiki.counts.tags,
        concepts: result.wiki.counts.concepts,
        changed: result.saved.changed,
        published: Boolean(result.publish?.ok),
      };
    },
  });
}
