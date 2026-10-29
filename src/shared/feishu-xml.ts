import type { OutlineNode, PageImage, StudyRecord, SummarySection } from './types';
import { formatDate, truncate } from './utils';
import { recordToDocumentTitle } from './markdown';

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br/>');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function paragraph(value: string): string {
  const text = value.trim();
  return text ? `<p>${escapeText(text)}</p>` : '';
}

function heading(level: number, value: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return `<h${level}>${escapeText(text)}</h${level}>`;
}

function list(items: string[], ordered = false): string {
  const clean = items.map((item) => item.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}>${clean.map((item) => `<li>${escapeText(item)}</li>`).join('')}</${tag}>`;
}

function selectedImages(record: StudyRecord): PageImage[] {
  const images = record.page.images ?? [];
  const selected = record.selectedImageIds;
  const usable = selected === undefined ? images : images.filter((image) => selected.includes(image.id));
  return usable.filter((image) => /^https?:\/\//i.test(image.src));
}

function imageCaption(image: PageImage): string {
  return (image.caption || image.alt || '正文图片').replace(/\s+/g, ' ').trim();
}

function imageXml(image: PageImage): string {
  const attrs = [`href="${escapeAttr(image.src)}"`];
  const caption = imageCaption(image);
  if (caption) attrs.push(`caption="${escapeAttr(caption)}"`);
  return `<img ${attrs.join(' ')}/>`;
}

function sectionMap(sections: SummarySection[]): Map<string, SummarySection> {
  return new Map(sections.map((section) => [section.outlineId, section]));
}

function renderOutline(
  nodes: OutlineNode[],
  sections: Map<string, SummarySection>,
  depth = 0,
): string[] {
  const lines: string[] = [];
  const level = Math.min(6, 3 + depth);
  for (const node of nodes) {
    const hasTitle = Boolean(node.title.trim());
    if (hasTitle) lines.push(heading(level, node.title));
    const section = sections.get(node.id);
    if (section) {
      if (section.summary.trim()) lines.push(paragraph(section.summary));
      if (section.keyPoints.length > 0) lines.push(list(section.keyPoints));
      if (section.questions.length > 0) {
        lines.push(paragraph(`待解决问题：${section.questions.join('；')}`));
      }
    } else if (node.text.trim()) {
      lines.push(paragraph(truncate(node.text.trim(), 320)));
    }
    // 没有标题的节点不产生新层级，避免子标题从 h3 直接跳到 h4。
    lines.push(...renderOutline(node.children, sections, hasTitle ? depth + 1 : depth));
  }
  return lines;
}

function renderSummarySections(sections: SummarySection[]): string[] {
  const lines: string[] = [];
  for (const section of sections) {
    const title = section.title.trim();
    if (title) lines.push(heading(3, title));
    if (section.summary.trim()) lines.push(paragraph(section.summary));
    if (section.keyPoints.length > 0) lines.push(list(section.keyPoints));
    if (section.questions.length > 0) {
      lines.push(paragraph(`待解决问题：${section.questions.join('；')}`));
    }
  }
  return lines;
}

function renderMetadata(record: StudyRecord): string {
  const source = record.page.url
    ? `<a href="${escapeAttr(record.page.url)}">${escapeText(record.page.url)}</a>`
    : '手动摘录';
  const model = record.summary?.model ? ` ｜ 生成模型：${escapeText(record.summary.model)}` : '';
  const details = [
    record.page.site ? `站点：${record.page.site}` : '',
    record.page.author ? `作者：${record.page.author}` : '',
    record.page.publishedAt ? `发布时间：${record.page.publishedAt}` : '',
  ].filter(Boolean);
  const lines = [
    '<callout emoji="📚" background-color="light-blue">',
    `<p>来源：${source} ｜ 记录时间：${formatDate(record.createdAt)}${model}</p>`,
  ];
  if (details.length > 0) lines.push(paragraph(details.join(' ｜ ')));
  lines.push(`<p>内容哈希：${escapeText(record.page.contentHash)}</p>`);
  lines.push('</callout>');
  return lines.join('');
}

function renderBody(record: StudyRecord, includeTitle: boolean): string[] {
  const lines: string[] = [];
  if (includeTitle) {
    const title = recordToDocumentTitle(record).replace(/\s*\n+\s*/g, ' ').trim();
    lines.push(`<title>${escapeText(title)}</title>`);
  }
  lines.push(renderMetadata(record));
  const summary = record.summary;

  lines.push(heading(2, '30 秒速读'));
  lines.push(paragraph(summary?.thesis || summary?.overview || '（还没有生成知识卡）'));
  if (summary?.quickRead && summary.quickRead.length > 0) lines.push(list(summary.quickRead));
  if (summary?.tags && summary.tags.length > 0) {
    lines.push(paragraph(`标签：${summary.tags.map((tag) => `#${tag}`).join('  ')}`));
  }

  if (summary?.argumentMap && summary.argumentMap.length > 0) {
    lines.push(heading(2, '核心论证'));
    summary.argumentMap.forEach((argument, index) => {
      lines.push(heading(3, `${index + 1}. ${argument.claim}`));
      if (argument.evidence) lines.push(paragraph(`证据：${argument.evidence}`));
      if (argument.assumptions) lines.push(paragraph(`隐含假设：${argument.assumptions}`));
      if (argument.boundary) lines.push(paragraph(`适用边界：${argument.boundary}`));
    });
  }

  if (summary?.keyConcepts && summary.keyConcepts.length > 0) {
    lines.push(heading(2, '概念卡'));
    lines.push(list(summary.keyConcepts.map((concept) => `${concept.term}：${concept.explanation}`)));
  }

  const outline = record.page.outline;
  if (outline.length > 0) {
    lines.push(heading(2, '章节笔记'));
    lines.push(...renderOutline(outline, sectionMap(summary?.sections ?? [])));
  } else if (summary?.sections && summary.sections.length > 0) {
    lines.push(heading(2, '章节笔记'));
    lines.push(...renderSummarySections(summary.sections));
  }

  const images = selectedImages(record);
  if (images.length > 0) {
    lines.push(heading(2, '图表与图片'));
    for (const image of images) {
      const path = image.headingPath.length > 0 ? image.headingPath.join(' / ') : '页面开头';
      lines.push(imageXml(image));
      lines.push(paragraph(`位置：${path} [§${image.anchor}]`));
    }
  }

  if (summary?.dialogueInsights && summary.dialogueInsights.length > 0) {
    lines.push(heading(2, '问答沉淀'));
    for (const insight of summary.dialogueInsights) {
      lines.push(heading(3, insight.question));
      lines.push(paragraph(insight.insight));
      if (insight.sectionTitle) lines.push(paragraph(`归属：${insight.sectionTitle}`));
      if (insight.evidence.length > 0) lines.push(paragraph(`依据：${insight.evidence.join('；')}`));
      if (insight.concepts.length > 0) lines.push(paragraph(`相关概念：${insight.concepts.join('、')}`));
    }
  }

  if (record.notes.trim()) {
    lines.push(heading(2, '我的判断'));
    lines.push(paragraph(record.notes));
  }

  if (record.tags.length > 0) {
    lines.push(paragraph(`记录标签：${record.tags.map((tag) => `#${tag}`).join('  ')}`));
  }

  lines.push('<hr/>');
  lines.push(paragraph('由 PageStudy 生成；AI 内容为草稿，引用请回到原文核对。原文可能随时间变化，以上是记录时的快照。'));
  return lines.filter(Boolean);
}

export function recordToFeishuXml(record: StudyRecord): string {
  return renderBody(record, true).join('\n');
}

export function recordToFeishuAppendXml(record: StudyRecord, now = Date.now()): string {
  const summary = record.summary;
  const lines: string[] = [heading(2, `追加更新 · ${formatDate(now)}`)];
  if (summary) {
    lines.push(heading(3, '30 秒速读'));
    lines.push(paragraph(summary.thesis || summary.overview));
    if (summary.quickRead && summary.quickRead.length > 0) lines.push(list(summary.quickRead));
    if (summary.keyConcepts.length > 0) {
      lines.push(heading(3, '概念卡'));
      lines.push(list(summary.keyConcepts.map((concept) => `${concept.term}：${concept.explanation}`)));
    }
    if (summary.dialogueInsights && summary.dialogueInsights.length > 0) {
      lines.push(heading(3, '问答沉淀'));
      for (const insight of summary.dialogueInsights) {
        const section = insight.sectionTitle ? `（归属：${insight.sectionTitle}）` : '';
        lines.push(paragraph(`${insight.question}：${insight.insight}${section}`));
      }
    }
  }
  if (record.notes.trim()) {
    lines.push(heading(3, '我的判断'));
    lines.push(paragraph(record.notes));
  }
  if (record.tags.length > 0) {
    lines.push(paragraph(`记录标签：${record.tags.map((tag) => `#${tag}`).join('  ')}`));
  }
  if (lines.length === 1) lines.push(paragraph('（本次没有新增知识卡或笔记）'));
  return lines.filter(Boolean).join('\n');
}
