import type { OutlineNode, StudyRecord, SummarySection } from './types';
import { formatDate, truncate } from './utils';

function summarizeSection(section: SummarySection): string[] {
  const lines: string[] = [];
  if (section.summary.trim()) lines.push(section.summary.trim());
  if (section.keyPoints.length > 0) {
    lines.push('', ...section.keyPoints.map((point) => `- ${point}`));
  }
  if (section.questions.length > 0) {
    lines.push('', ...section.questions.map((question) => `- 待思考：${question}`));
  }
  return lines;
}

function walkOutline(
  nodes: OutlineNode[],
  depth: number,
  summaryMap: Map<string, SummarySection>,
  lines: string[],
): void {
  for (const node of nodes) {
    const headingLevel = Math.min(6, Math.max(3, depth + 3));
    lines.push('', `${'#'.repeat(headingLevel)} ${node.title || '未命名章节'}`);
    const section = summaryMap.get(node.id);
    if (section) {
      lines.push(...summarizeSection(section));
    } else if (node.text.trim()) {
      lines.push(truncate(node.text.trim(), 320));
    }
    if (node.children.length > 0) {
      walkOutline(node.children, depth + 1, summaryMap, lines);
    }
  }
}

export function recordToMarkdown(record: StudyRecord): string {
  const lines: string[] = [];
  const page = record.page;
  lines.push(`# ${page.title || '未命名网页'}`);
  lines.push('');
  lines.push(`> 原文：[${page.url}](${page.url})`);
  if (page.site) lines.push(`> 站点：${page.site}`);
  if (page.author) lines.push(`> 作者：${page.author}`);
  if (page.publishedAt) lines.push(`> 发布时间：${page.publishedAt}`);
  lines.push(`> 记录时间：${formatDate(record.createdAt)}`);
  lines.push(`> 内容哈希：\`${page.contentHash}\``);

  if (record.summary) {
    lines.push('');
    lines.push('## 内容概览');
    lines.push('');
    lines.push(record.summary.overview.trim() || '（暂无概览）');
    if (record.summary.tags.length > 0) {
      lines.push('');
      lines.push(`标签：${record.summary.tags.map((tag) => `#${tag}`).join(' ')}`);
    }
    if (record.summary.keyConcepts.length > 0) {
      lines.push('');
      lines.push('### 关键概念');
      for (const concept of record.summary.keyConcepts) {
        lines.push(`- **${concept.term}**：${concept.explanation}`);
      }
    }
  }

  if (page.outline.length > 0) {
    lines.push('');
    lines.push('## 网页大纲与逐节笔记');
    const summaryMap = new Map((record.summary?.sections ?? []).map((section) => [section.outlineId, section]));
    walkOutline(page.outline, 0, summaryMap, lines);
  }

  if (record.selections.length > 0) {
    lines.push('');
    lines.push('## 选中的原文');
    for (const selection of record.selections) {
      lines.push('');
      if (selection.headingPath.length > 0) lines.push(`> ${selection.headingPath.join(' / ')}`);
      lines.push(`> ${selection.text.replace(/\n+/g, ' ')}`);
    }
  }

  if (record.messages.length > 0) {
    lines.push('');
    lines.push('## 对话摘录');
    for (const message of record.messages) {
      if (!message.content.trim()) continue;
      lines.push('');
      lines.push(`**${message.role === 'user' ? '我' : '助教'}：**`);
      lines.push('');
      lines.push(message.content.trim());
    }
  }

  if (record.notes.trim()) {
    lines.push('');
    lines.push('## 我的笔记');
    lines.push('');
    lines.push(record.notes.trim());
  }

  if (record.tags.length > 0) {
    lines.push('');
    lines.push(`记录标签：${record.tags.map((tag) => `#${tag}`).join(' ')}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('由 PageStudy 生成。原文可能随时间变化，以上大纲和总结是记录时的快照。');
  return lines.join('\n');
}

/**
 * 追加内容只写“本次更新”，不重复整篇概览和大纲，避免文档越追加越臃肿。
 */
export function recordToAppendMarkdown(record: StudyRecord, now = Date.now()): string {
  const lines: string[] = ['', '---', '', `## 追加更新 · ${formatDate(now)}`];
  if (record.summary) {
    lines.push('', '### 内容概览', '', record.summary.overview.trim() || '（暂无概览）');
    if (record.summary.keyConcepts.length > 0) {
      lines.push('', '### 关键概念');
      for (const concept of record.summary.keyConcepts) {
        lines.push(`- **${concept.term}**：${concept.explanation}`);
      }
    }
  }
  if (record.notes.trim()) {
    lines.push('', '### 我的笔记', '', record.notes.trim());
  }
  if (record.tags.length > 0) {
    lines.push('', `记录标签：${record.tags.map((tag) => `#${tag}`).join(' ')}`);
  }
  if (lines.length === 4) lines.push('', '（本次没有新增总结或笔记）');
  return lines.join('\n');
}

export function recordToDocumentTitle(record: StudyRecord): string {
  const title = record.page.title.trim() || '未命名网页';
  const date = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(record.createdAt));
  return `学习记录 · ${title} · ${date}`;
}

// 旧名字保留给已有导入和测试；行为已通用化。
export const recordToFeishuAppendMarkdown = recordToAppendMarkdown;
export const recordToFeishuTitle = recordToDocumentTitle;

export function recordToText(record: StudyRecord): string {
  const summary = record.summary?.overview ?? '';
  return [record.page.title, record.page.url, summary].filter(Boolean).join('\n');
}
