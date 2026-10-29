/** 把 Pi/DSH 的不同消息形态归一化为同一种会话转录。 */
import { redactText } from './redact.mjs';
import { escapeMarkdownInline, sha256 } from './util.mjs';

const ROLE_ALIASES = new Map([
  ['human', 'user'],
  ['user', 'user'],
  ['assistant', 'assistant'],
  ['ai', 'assistant'],
  ['tool', 'tool'],
  ['toolresult', 'tool'],
  ['tool_result', 'tool'],
  ['system', 'system'],
]);

export function normalizeRole(value) {
  return ROLE_ALIASES.get(String(value || '').toLowerCase()) || 'other';
}

export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  }
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push('[图片]');
    } else if (block.type === 'tool-call' || block.type === 'toolCall') {
      const name = block.name || block.toolName || '';
      parts.push(name ? `[调用工具：${name}]` : '[调用工具]');
    } else if (block.type === 'tool-result' || block.type === 'toolResult') {
      if (typeof block.content === 'string') parts.push(block.content);
    }
  }
  return parts.join('\n');
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const role = normalizeRole(raw.role);
  if (!['user', 'assistant', 'tool', 'system'].includes(role)) return null;
  const text = redactText(
    String(raw.text ?? contentToText(raw.content) ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim(),
  );
  if (!text) return null;
  const clipped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n\n[单条消息已截断]` : text;
  return {
    role,
    text: clipped,
    timestamp: Number(raw.timestamp) || 0,
    ...(raw.toolName ? { toolName: String(raw.toolName).slice(0, 120) } : {}),
  };
}

function fitByMessages(messages, maxMessages) {
  if (messages.length <= maxMessages) return { messages, truncated: false };
  const head = messages.slice(0, 2);
  const tail = messages.slice(-(maxMessages - head.length));
  return {
    messages: [
      ...head,
      {
        role: 'system',
        text: `[中间省略 ${messages.length - head.length - tail.length} 条消息]`,
        timestamp: 0,
      },
      ...tail,
    ],
    truncated: true,
  };
}

function fitByChars(messages, maxChars) {
  const total = messages.reduce((sum, message) => sum + message.text.length, 0);
  if (total <= maxChars) return { messages, truncated: false };
  const head = messages.slice(0, 2);
  const tail = [];
  let used = head.reduce((sum, message) => sum + message.text.length, 0);
  for (let index = messages.length - 1; index >= head.length; index -= 1) {
    const message = messages[index];
    if (used + message.text.length > maxChars) break;
    tail.unshift(message);
    used += message.text.length;
  }
  return {
    messages: [
      ...head,
      {
        role: 'system',
        text: `[中间内容因长度限制省略 ${Math.max(0, messages.length - head.length - tail.length)} 条消息]`,
        timestamp: 0,
      },
      ...tail,
    ],
    truncated: true,
  };
}

/**
 * @param {Array<{role?: string, text?: string, content?: unknown, timestamp?: number, toolName?: string}>} rawMessages
 * @param {{maxMessages?: number, maxChars?: number, includeToolMessages?: boolean}} options
 */
export function normalizeTranscript(rawMessages, options = {}) {
  const maxMessages = Math.max(20, Math.min(2000, Number(options.maxMessages) || 400));
  const maxChars = Math.max(10_000, Math.min(500_000, Number(options.maxChars) || 120_000));
  const includeToolMessages = Boolean(options.includeToolMessages);
  const source = Array.isArray(rawMessages) ? rawMessages : [];
  const normalized = [];
  for (const raw of source) {
    const message = normalizeMessage(raw);
    if (!message) continue;
    if (message.role === 'system') continue;
    if (message.role === 'tool' && !includeToolMessages) continue;
    const previous = normalized[normalized.length - 1];
    if (previous && previous.role === message.role && previous.text === message.text) continue;
    normalized.push(message);
  }
  const byMessages = fitByMessages(normalized, maxMessages);
  const byChars = fitByChars(byMessages.messages, maxChars);
  return {
    messages: byChars.messages,
    truncated: byMessages.truncated || byChars.truncated,
    originalCount: normalized.length,
    charCount: byChars.messages.reduce((sum, message) => sum + message.text.length, 0),
  };
}

export function deriveTitle(messages, fallback = '未命名会话') {
  const firstUser = (Array.isArray(messages) ? messages : []).find(
    (message) => message.role === 'user' && message.text.trim(),
  );
  const raw = (firstUser?.text || fallback)
    .replace(/^[#>\-*\s]+/gm, '')
    .replace(/[`*_~]/g, '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  const title = escapeMarkdownInline(raw || fallback)
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return title || fallback;
}

export function deriveOverview(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const assistant = [...list].reverse().find((message) => message.role === 'assistant' && message.text.trim());
  const fallback = [...list].reverse().find((message) => message.text.trim());
  const text = (assistant?.text || fallback?.text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 360);
}

export function countRoles(messages) {
  const counts = { user: 0, assistant: 0, tool: 0, system: 0 };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message && Object.hasOwn(counts, message.role)) counts[message.role] += 1;
  }
  return counts;
}

export function transcriptSignature(transcript) {
  return sha256(JSON.stringify(transcript?.messages || []));
}

export function formatMessageForMarkdown(message) {
  const role = message.role === 'user' ? '我' : message.role === 'assistant' ? '助手' : message.role === 'tool' ? '工具' : '系统';
  return `**${role}**：${message.text.replace(/\n/g, '\n  ')}`;
}
