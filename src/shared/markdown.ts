import type { OutlineNode, PageImage, StudyRecord, SummarySection } from './types';
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

function selectedImages(record: StudyRecord): PageImage[] {
  const images = record.page.images ?? [];
  if (!record.selectedImageIds) return images;
  const selected = new Set(record.selectedImageIds);
  return images.filter((image) => selected.has(image.id));
}

function imageCaption(image: PageImage): string {
  return (image.caption || image.alt || '正文图片').replace(/\s+/g, ' ').trim();
}

function imageMarkdown(image: PageImage): string {
  const alt = imageCaption(image).replace(/[\[\]]/g, '\\$&');
  return `![${alt}](${image.src})`;
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
    lines.push(`> 生成模型：${record.summary.model}`);
  }

  const summary = record.summary;
  lines.push('');
  lines.push('## 30 秒速读');
  lines.push('');
  lines.push((summary?.thesis || summary?.overview || '（还没有生成知识卡）').trim());
  if (summary?.quickRead && summary.quickRead.length > 0) {
    lines.push('');
    for (const point of summary.quickRead) lines.push(`- ${point}`);
  }
  if (summary?.tags && summary.tags.length > 0) {
    lines.push('');
    lines.push(`标签：${summary.tags.map((tag) => `#${tag}`).join(' ')}`);
  }

  if (summary?.argumentMap && summary.argumentMap.length > 0) {
    lines.push('');
    lines.push('## 核心论证');
    summary.argumentMap.forEach((argument, index) => {
      lines.push('');
      lines.push(`### ${index + 1}. ${argument.claim}`);
      if (argument.evidence) lines.push(`- 证据：${argument.evidence}`);
      if (argument.assumptions) lines.push(`- 隐含假设：${argument.assumptions}`);
      if (argument.boundary) lines.push(`- 适用边界：${argument.boundary}`);
    });
  }

  if (summary?.keyConcepts && summary.keyConcepts.length > 0) {
    lines.push('');
    lines.push('## 概念卡');
    for (const concept of summary.keyConcepts) {
      lines.push(`- **${concept.term}**：${concept.explanation}`);
    }
  }

  if (page.outline.length > 0) {
    lines.push('');
    lines.push('## 章节笔记');
    const summaryMap = new Map((summary?.sections ?? []).map((section) => [section.outlineId, section]));
    walkOutline(page.outline, 0, summaryMap, lines);
  }

  const images = selectedImages(record);
  if (images.length > 0) {
    lines.push('');
    lines.push('## 图表与图片');
    for (const image of images) {
      const caption = imageCaption(image);
      const path = image.headingPath.length > 0 ? image.headingPath.join(' / ') : '页面开头';
      lines.push('');
      lines.push(imageMarkdown(image));
      lines.push(`> ${caption}`);
      lines.push(`> 位置：${path} [§${image.anchor}]`);
    }
  }

  if (summary?.dialogueInsights && summary.dialogueInsights.length > 0) {
    lines.push('');
    lines.push('## 问答沉淀');
    for (const insight of summary.dialogueInsights) {
      lines.push('');
      lines.push(`### ${insight.question}`);
      lines.push('');
      lines.push(insight.insight);
      if (insight.sectionTitle) {
        lines.push('', `归属：${insight.sectionTitle}`);
      }
      if (insight.evidence.length > 0) {
        lines.push('', `依据：${insight.evidence.join('；')}`);
      }
      if (insight.concepts.length > 0) {
        lines.push('', `相关概念：${insight.concepts.join('、')}`);
      }
    }
  }

  if (record.notes.trim()) {
    lines.push('');
    lines.push('## 我的判断');
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
  lines.push('由 PageStudy 生成；AI 内容为草稿，引用请回到原文核对。原文可能随时间变化，以上是记录时的快照。');
  return lines.join('\n');
}

/**
 * 追加内容只写“本次更新”，不重复整篇概览和大纲，避免文档越追加越臃肿。
 */
export function recordToAppendMarkdown(record: StudyRecord, now = Date.now()): string {
  const lines: string[] = ['', '---', '', `## 追加更新 · ${formatDate(now)}`];
  const summary = record.summary;
  if (summary) {
    lines.push('', '### 30 秒速读', '', (summary.thesis || summary.overview).trim());
    if (summary.quickRead && summary.quickRead.length > 0) {
      lines.push(...summary.quickRead.map((point) => `- ${point}`));
    }
    if (summary.keyConcepts.length > 0) {
      lines.push('', '### 概念卡');
      for (const concept of summary.keyConcepts) {
        lines.push(`- **${concept.term}**：${concept.explanation}`);
      }
    }
    if (summary.dialogueInsights && summary.dialogueInsights.length > 0) {
      lines.push('', '### 问答沉淀');
      for (const insight of summary.dialogueInsights) {
        const section = insight.sectionTitle ? `（归属：${insight.sectionTitle}）` : '';
        lines.push(`- ${insight.question}：${insight.insight}${section}`);
      }
    }
  }
  if (record.notes.trim()) {
    lines.push('', '### 我的判断', '', record.notes.trim());
  }
  if (record.tags.length > 0) {
    lines.push('', `记录标签：${record.tags.map((tag) => `#${tag}`).join(' ')}`);
  }
  if (lines.length === 4) lines.push('', '（本次没有新增知识卡或笔记）');
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
