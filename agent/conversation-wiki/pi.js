/**
 * Pi 原生扩展。
 *
 * 在 agent_settled 后自动捕获当前会话，注册 conversation_wiki 工具和
 * /conversation-wiki 命令；与 DSH 插件共享同一份本地 Wiki 核心。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';
import {
  captureConversation,
  conversationWikiStatus,
  initConversationWiki,
  loadConfig,
  publishConversationWikiNow,
  recordConversation,
} from './core/index.mjs';
import {
  contentToText,
  deriveTitle,
  normalizeRole,
  transcriptSignature,
} from './core/transcript.mjs';
import { loadRecord } from './core/records.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const DESCRIPTION =
  '把当前会话整理并保存到本地 Conversation Wiki（会话/标签/概念页互相反链），可按配置发布到飞书个人文档库。';

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sourceFromPi(ctx) {
  const entries = ctx.sessionManager.buildContextEntries();
  const messages = [];
  for (const entry of entries) {
    if (entry?.type !== 'message' || !entry.message) continue;
    const role = normalizeRole(entry.message.role);
    if (!['user', 'assistant', 'tool'].includes(role)) continue;
    const text = contentToText(entry.message.content ?? entry.message.text);
    if (!text.trim()) continue;
    messages.push({
      role,
      text,
      timestamp: Number(entry.message.timestamp) || 0,
    });
  }
  return {
    messages,
    source: {
      agent: 'pi',
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile() || '',
      cwd: ctx.cwd || ctx.sessionManager.getCwd() || '',
    },
  };
}

function notify(ctx, text, level = 'info') {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // 通知失败不影响主流程。
  }
}

function withoutToolMessages(messages, config) {
  return config.includeToolMessages
    ? messages
    : messages.filter((message) => message.role !== 'tool');
}

async function captureFromPi(ctx) {
  const config = await loadConfig();
  if (!config.autoCapture) return null;
  const { messages: allMessages, source } = sourceFromPi(ctx);
  const messages = withoutToolMessages(allMessages, config);
  if (!messages.some((message) => message.role === 'user' || message.role === 'assistant')) return null;
  const signature = transcriptSignature({ messages });
  const existing = await loadRecord(config, source.sessionId);
  if (existing && transcriptSignature({ messages: existing.messages }) === signature) return null;
  return captureConversation(config, {
    id: source.sessionId,
    title: deriveTitle(messages),
    messages,
    source,
  });
}

export default function conversationWiki(pi) {
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
            console.warn(`conversation-wiki: 自动发布失败：${result.result?.error || '未知错误'}`);
          }
        }
      } catch {
        // 自动发布失败不应影响 Pi 会话。
      } finally {
        publishing = false;
      }
    }, 6000);
    publishTimer.unref?.();
  }

  pi.on('resources_discover', async () => ({
    skillPaths: [join(packageRoot, 'skills')],
  }));

  pi.on('agent_settled', async (_event, ctx) => {
    try {
      const result = await captureFromPi(ctx);
      if (result) {
        const config = await loadConfig();
        if (config.autoPublish && config.feishu.enabled) schedulePublish();
      }
    } catch (error) {
      notify(ctx, `会话知识库自动记录失败：${safeMessage(error)}`, 'warning');
    }
  });

  pi.registerTool({
    name: 'conversation_wiki',
    label: '会话知识库',
    description: DESCRIPTION,
    promptSnippet: 'Save the current conversation into the local Conversation Wiki or publish it to Feishu.',
    promptGuidelines: [
      'Use conversation_wiki with action "record" when the user asks to save, summarize, or turn this conversation into a knowledge base; fill title, overview, sections, tags, and concepts from the actual conversation.',
      'Use conversation_wiki with action "publish" only when the user asks to publish to Feishu; publishing requires feishu.enabled in the shared config.',
    ],
    parameters: Type.Object({
      action: StringEnum(['record', 'capture', 'publish', 'status', 'init'], {
        description:
          'record：用结构化摘要更新当前会话；capture：只保存原始转录；publish：发布到飞书；status：查看状态；init：初始化目录。',
      }),
      title: Type.Optional(Type.String({ description: '会话标题；省略时从首条用户消息推导。' })),
      overview: Type.Optional(Type.String({ description: '2-4 句会话概览。' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: '3-8 个主题标签。' })),
      concepts: Type.Optional(
        Type.Array(
          Type.Object({
            term: Type.String({ description: '概念名。' }),
            explanation: Type.Optional(Type.String({ description: '一句话解释。' })),
          }),
          { description: '会话中出现的可复用概念。' },
        ),
      ),
      sections: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: '小节标题。' }),
            summary: Type.Optional(Type.String({ description: '小节摘要。' })),
            keyPoints: Type.Optional(Type.Array(Type.String(), { description: '关键点。' })),
          }),
          { description: '按会话脉络拆分的小节。' },
        ),
      ),
      decisions: Type.Optional(Type.Array(Type.String(), { description: '已达成的决策。' })),
      actionItems: Type.Optional(Type.Array(Type.String(), { description: '后续行动项。' })),
      openQuestions: Type.Optional(Type.Array(Type.String(), { description: '尚未解决的问题。' })),
      notes: Type.Optional(Type.String({ description: '人工补充笔记。' })),
      publish: Type.Optional(
        Type.Boolean({ description: 'record 完成后是否立即发布到飞书；需要配置启用。' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = await loadConfig();
      const { messages: allMessages, source } = sourceFromPi(ctx);
      const messages = withoutToolMessages(allMessages, config);

      if (params.action === 'init') {
        const result = await initConversationWiki(config);
        return {
          content: [{ type: 'text', text: `已初始化 Conversation Wiki：${result.config.vault}` }],
          details: { ok: true, action: params.action, vault: result.config.vault },
        };
      }
      if (params.action === 'status') {
        const status = await conversationWikiStatus(config);
        return {
          content: [
            {
              type: 'text',
              text: [
                `本地记录 ${status.recordCount} 条，Wiki ${status.wiki.pages} 页。`,
                `飞书：${status.feishu.enabled ? '已启用' : '未启用'}${
                  status.feishu.published ? `，已发布 ${status.feishu.pages} 页` : ''
                }。`,
                `路径：${status.wiki.root}`,
              ].join('\n'),
            },
          ],
          details: { ok: true, action: params.action, ...status },
        };
      }
      if (params.action === 'publish') {
        const { wiki, result } = await publishConversationWikiNow(config);
        const text = result.ok
          ? `已发布 ${wiki.counts.sessions} 条会话、${wiki.counts.tags} 个标签、${wiki.counts.concepts} 个概念；新建 ${result.created || 0}，更新 ${result.updated || 0}，跳过 ${result.skipped || 0}。${result.state?.root?.url ? `\n${result.state.root.url}` : ''}`
          : `发布失败：${result.error || '未知错误'}`;
        return {
          content: [{ type: 'text', text }],
          details: { ok: Boolean(result.ok), action: params.action, ...result },
          ...(result.ok ? {} : { isError: true }),
        };
      }
      if (params.action === 'capture') {
        const result = await captureConversation(config, {
          id: source.sessionId,
          title: params.title || deriveTitle(messages),
          messages,
          source,
        });
        return {
          content: [
            {
              type: 'text',
              text: result.saved.changed
                ? `已捕获会话并更新 Wiki：${result.saved.record.title}`
                : '会话没有变化，已保持现有 Wiki。',
            },
          ],
          details: {
            ok: true,
            action: params.action,
            title: result.saved.record.title,
            changed: result.saved.changed,
            counts: result.wiki.counts,
          },
        };
      }

      const result = await recordConversation(config, {
        id: source.sessionId,
        messages,
        source,
        title: params.title,
        publish: Boolean(params.publish),
        enrichment: {
          title: params.title,
          overview: params.overview,
          tags: params.tags,
          concepts: params.concepts,
          sections: params.sections,
          decisions: params.decisions,
          actionItems: params.actionItems,
          openQuestions: params.openQuestions,
          notes: params.notes,
        },
      });
      const publishText = result.publish
        ? result.publish.ok
          ? `\n飞书：新建 ${result.publish.created || 0}，更新 ${result.publish.updated || 0}，跳过 ${result.publish.skipped || 0}。`
          : `\n飞书：未发布（${result.publish.error}）。`
        : '';
      return {
        content: [
          {
            type: 'text',
            text: `已保存会话：${result.record.title}\n本地 Wiki：${result.wiki.counts.sessions} 条会话、${result.wiki.counts.tags} 个标签、${result.wiki.counts.concepts} 个概念。${publishText}`,
          },
        ],
        details: {
          ok: true,
          action: params.action,
          title: result.record.title,
          changed: result.saved.changed,
          counts: result.wiki.counts,
          publish: result.publish || null,
        },
      };
    },
  });

  pi.registerCommand('conversation-wiki', {
    description: '查看或操作 Conversation Wiki（status / publish / init）',
    handler: async (args, ctx) => {
      const action = String(args || '').trim().split(/\s+/)[0] || 'status';
      try {
        const config = await loadConfig();
        if (action === 'init') {
          const result = await initConversationWiki(config);
          notify(ctx, `已初始化：${result.config.vault}`, 'info');
          return;
        }
        if (action === 'publish') {
          const { result } = await publishConversationWikiNow(config);
          notify(
            ctx,
            result.ok ? `已发布到飞书：${result.state?.root?.url || '完成'}` : `发布失败：${result.error}`,
            result.ok ? 'info' : 'warning',
          );
          return;
        }
        const status = await conversationWikiStatus(config);
        notify(
          ctx,
          `Conversation Wiki：${status.recordCount} 条记录，${status.wiki.pages} 页；飞书${status.feishu.enabled ? '已启用' : '未启用'}。`,
          'info',
        );
      } catch (error) {
        notify(ctx, `Conversation Wiki 操作失败：${safeMessage(error)}`, 'warning');
      }
    },
  });
}
