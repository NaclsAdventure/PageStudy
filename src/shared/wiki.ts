import type { KeyConcept, StudyRecord, SummarySection } from './types';
import { hashString, safeHostname, truncate } from './utils';

export type WikiPageKind = 'note' | 'tag' | 'concept';

export interface WikiPage {
  id: string;
  kind: WikiPageKind;
  title: string;
  subtitle: string;
  overview: string;
  tags: string[];
  concepts: KeyConcept[];
  sections: SummarySection[];
  recordId?: string;
  sourceUrl?: string;
  outbound: string[];
  backlinks: string[];
  recordCount: number;
  updatedAt: number;
}

export interface WikiIndex {
  pages: WikiPage[];
  byId: Map<string, WikiPage>;
  noteCount: number;
  tagCount: number;
  conceptCount: number;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function topicKey(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN');
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || hashString(value);
}

export function recordWikiPageId(recordId: string): string {
  return `note:${recordId}`;
}

function topicPageId(kind: 'tag' | 'concept', key: string): string {
  return `${kind}:${slugify(key)}-${hashString(key).slice(0, 6)}`;
}

function fallbackOverview(record: StudyRecord): string {
  const fromOutline = record.page.outline
    .map((node) => node.text || node.title)
    .find((value) => value.trim());
  return (
    record.summary?.overview.trim() ||
    record.page.description.trim() ||
    (fromOutline ? truncate(fromOutline.trim(), 220) : '') ||
    (record.notes.trim() ? truncate(record.notes.trim(), 220) : '还没有内容概览。')
  );
}

/**
 * Wiki 是记录的派生视图：每次读取都从最新记录重建，因此保存记录后不需要额外的复制步骤。
 * 记录页与标签/概念主题页互相建立出链和反链，形成可浏览的本地知识库。
 */
export function buildWiki(records: StudyRecord[]): WikiIndex {
  const notes: WikiPage[] = [];
  const tagPages = new Map<string, WikiPage>();
  const conceptPages = new Map<string, WikiPage>();

  for (const record of records) {
    const tags = unique([...record.tags, ...(record.summary?.tags ?? [])]);
    const concepts = (record.summary?.keyConcepts ?? []).filter((concept) => concept.term.trim());
    const noteId = recordWikiPageId(record.id);
    const outbound: string[] = [];

    for (const tag of tags) {
      const key = topicKey(tag);
      const id = topicPageId('tag', key);
      outbound.push(id);
      const existing = tagPages.get(key);
      if (existing) {
        existing.outbound.push(noteId);
        existing.recordCount += 1;
        existing.updatedAt = Math.max(existing.updatedAt, record.updatedAt);
        existing.tags = unique([...existing.tags, tag]);
      } else {
        tagPages.set(key, {
          id,
          kind: 'tag',
          title: tag,
          subtitle: '标签主题',
          overview: `与“${tag}”相关的学习记录。`,
          tags: [tag],
          concepts: [],
          sections: [],
          outbound: [noteId],
          backlinks: [],
          recordCount: 1,
          updatedAt: record.updatedAt,
        });
      }
    }

    for (const concept of concepts) {
      const key = topicKey(concept.term);
      const id = topicPageId('concept', key);
      outbound.push(id);
      const existing = conceptPages.get(key);
      if (existing) {
        existing.outbound.push(noteId);
        existing.recordCount += 1;
        existing.updatedAt = Math.max(existing.updatedAt, record.updatedAt);
        if (!existing.overview && concept.explanation.trim()) {
          existing.overview = concept.explanation.trim();
        }
      } else {
        conceptPages.set(key, {
          id,
          kind: 'concept',
          title: concept.term,
          subtitle: '概念主题',
          overview: concept.explanation.trim(),
          tags: [],
          concepts: [concept],
          sections: [],
          outbound: [noteId],
          backlinks: [],
          recordCount: 1,
          updatedAt: record.updatedAt,
        });
      }
    }

    notes.push({
      id: noteId,
      kind: 'note',
      title: record.page.title.trim() || '未命名记录',
      subtitle: record.page.manual ? '手动摘录' : safeHostname(record.page.url),
      overview: fallbackOverview(record),
      tags,
      concepts,
      sections: record.summary?.sections ?? [],
      recordId: record.id,
      sourceUrl: record.page.url,
      outbound: unique(outbound),
      backlinks: [],
      recordCount: 1,
      updatedAt: record.updatedAt,
    });
  }

  const pages = [...notes, ...tagPages.values(), ...conceptPages.values()];
  const byId = new Map(pages.map((page) => [page.id, page]));

  for (const page of pages) {
    page.outbound = unique(page.outbound).filter((id) => byId.has(id) && id !== page.id);
    for (const targetId of page.outbound) {
      const target = byId.get(targetId);
      if (target && !target.backlinks.includes(page.id)) target.backlinks.push(page.id);
    }
  }

  for (const page of pages) {
    page.backlinks.sort((a, b) => {
      const left = byId.get(a);
      const right = byId.get(b);
      return (right?.recordCount ?? 0) - (left?.recordCount ?? 0);
    });
  }

  pages.sort((a, b) => {
    if (a.kind !== b.kind) {
      const order: Record<WikiPageKind, number> = { note: 0, tag: 1, concept: 2 };
      return order[a.kind] - order[b.kind];
    }
    return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title, 'zh-CN');
  });

  return {
    pages,
    byId,
    noteCount: notes.length,
    tagCount: tagPages.size,
    conceptCount: conceptPages.size,
  };
}

export function filterWikiPages(pages: WikiPage[], query: string, kind: 'all' | WikiPageKind = 'all'): WikiPage[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  return pages.filter((page) => {
    if (kind !== 'all' && page.kind !== kind) return false;
    if (!normalized) return true;
    const haystack = [
      page.title,
      page.subtitle,
      page.overview,
      ...page.tags,
      ...page.concepts.map((concept) => `${concept.term} ${concept.explanation}`),
    ]
      .join('\n')
      .toLocaleLowerCase('zh-CN');
    return haystack.includes(normalized);
  });
}
