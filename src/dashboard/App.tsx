import { useEffect, useMemo, useState } from 'react';
import type { StudyRecord } from '../shared/types';
import { deleteRecord, listRecords, saveRecord } from '../shared/db';
import { asErrorMessage, formatDate, safeHostname } from '../shared/utils';
import { flattenOutline } from '../shared/skills';
import {
  recordToFeishuAppendMarkdown,
  recordToFeishuTitle,
  recordToMarkdown,
} from '../shared/markdown';
import { sendRuntimeMessage, type FeishuWriteResponse } from '../shared/messages';
import OutlineTree from '../sidepanel/components/OutlineTree';
import './styles.css';

type SortMode = 'recent' | 'title';

export default function DashboardApp() {
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('recent');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [feishuLoading, setFeishuLoading] = useState(false);
  const [tagInput, setTagInput] = useState('');

  useEffect(() => {
    void refresh();
  }, []);

  const flash = (text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const all = await listRecords();
      setRecords(all);
      setSelectedId((current) => current ?? all[0]?.id ?? null);
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setLoading(false);
    }
  };

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const record of records) {
      for (const tag of record.tags) tags.add(tag);
      for (const tag of record.summary?.tags ?? []) tags.add(tag);
    }
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [records]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = records.filter((record) => {
      const text = [
        record.page.title,
        record.page.url,
        record.page.site,
        record.page.author,
        record.notes,
        record.summary?.overview ?? '',
        ...record.tags,
        ...(record.summary?.tags ?? []),
      ]
        .join('\n')
        .toLowerCase();
      if (normalizedQuery && !text.includes(normalizedQuery)) return false;
      if (tagFilter) {
        const tags = [...record.tags, ...(record.summary?.tags ?? [])];
        if (!tags.includes(tagFilter)) return false;
      }
      return true;
    });
    return result.sort((a, b) => {
      if (sort === 'title') return a.page.title.localeCompare(b.page.title, 'zh-CN');
      return b.updatedAt - a.updatedAt;
    });
  }, [records, query, tagFilter, sort]);

  const selected = useMemo(
    () => filtered.find((record) => record.id === selectedId) ?? filtered[0] ?? null,
    [filtered, selectedId],
  );

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected, selectedId]);

  const updateSelected = async (patch: Partial<StudyRecord>) => {
    if (!selected) return;
    const next: StudyRecord = { ...selected, ...patch, updatedAt: Date.now() };
    setRecords((current) => current.map((record) => (record.id === next.id ? next : record)));
    await saveRecord(next);
  };

  const openSource = () => {
    if (selected) void chrome.tabs.create({ url: selected.page.url });
  };

  const copyMarkdown = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(recordToMarkdown(selected));
      flash('Markdown 已复制。');
    } catch (error) {
      flash(asErrorMessage(error), true);
    }
  };

  const downloadMarkdown = () => {
    if (!selected) return;
    const blob = new Blob([recordToMarkdown(selected)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(selected.page.title || 'pagestudy').replace(/[\\/:*?"<>|]+/g, '_')}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const writeFeishu = async (mode: 'create' | 'append' = 'create') => {
    if (!selected) return;
    if (mode === 'create' && !selected.summary) {
      flash('请先在侧栏生成总结。', true);
      return;
    }
    if (mode === 'append' && !selected.feishu?.documentId) {
      flash('还没有已写入的飞书文档，请先创建。', true);
      return;
    }
    setFeishuLoading(true);
    try {
      const response =
        mode === 'append'
          ? await sendRuntimeMessage<FeishuWriteResponse>({
              type: 'PS_APPEND_FEISHU',
              documentId: selected.feishu?.documentId ?? '',
              markdown: recordToFeishuAppendMarkdown(selected),
            })
          : await sendRuntimeMessage<FeishuWriteResponse>({
              type: 'PS_WRITE_FEISHU',
              title: recordToFeishuTitle(selected),
              markdown: recordToMarkdown(selected),
            });
      if (!response.ok) throw new Error(response.error ?? '飞书写入失败');
      const next: StudyRecord = {
        ...selected,
        feishu: {
          url: response.url ?? selected.feishu?.url ?? '',
          documentId: response.documentId ?? selected.feishu?.documentId ?? '',
          writtenAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await updateSelected(next);
      flash(mode === 'append' ? '已追加到飞书文档。' : '已写入飞书文档。');
      if (mode === 'create' && response.url) void chrome.tabs.create({ url: response.url });
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setFeishuLoading(false);
    }
  };

  const removeSelected = async () => {
    if (!selected) return;
    if (!window.confirm(`删除“${selected.page.title}”？此操作不可撤销。`)) return;
    await deleteRecord(selected.id);
    const next = records.filter((record) => record.id !== selected.id);
    setRecords(next);
    setSelectedId(next[0]?.id ?? null);
    flash('记录已删除。');
  };

  const addTag = async () => {
    if (!selected) return;
    const value = tagInput.trim();
    if (!value) return;
    const tags = Array.from(new Set([...selected.tags, value]));
    setTagInput('');
    await updateSelected({ tags });
  };

  const removeTag = async (tag: string) => {
    if (!selected) return;
    await updateSelected({ tags: selected.tags.filter((item) => item !== tag) });
  };

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
  };

  return (
    <div className="dashboard-shell">
      <header className="dashboard-topbar">
        <div className="dashboard-brand">
          <span className="dashboard-logo">PS</span>
          <div>
            <strong>PageStudy</strong>
            <span>记录库</span>
          </div>
        </div>
        <div className="dashboard-actions">
          <button type="button" className="secondary-action" onClick={openOptions}>
            设置
          </button>
          <button type="button" className="secondary-action" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      <div className="dashboard-body">
        <aside className="library-panel">
          <div className="library-head">
            <div>
              <span className="eyebrow">LIBRARY</span>
              <h1>学习记录</h1>
            </div>
            <span className="record-total">{records.length}</span>
          </div>

          <input
            className="search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、URL、笔记、标签…"
          />

          <div className="library-controls">
            <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)}>
              <option value="recent">最近更新</option>
              <option value="title">标题排序</option>
            </select>
            {tagFilter ? (
              <button type="button" className="filter-chip" onClick={() => setTagFilter(null)}>
                #{tagFilter} ×
              </button>
            ) : null}
          </div>

          {allTags.length > 0 ? (
            <div className="tag-filter-list">
              {allTags.slice(0, 14).map((tag) => (
                <button
                  type="button"
                  key={tag}
                  className={tagFilter === tag ? 'tag-filter active' : 'tag-filter'}
                  onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                >
                  #{tag}
                </button>
              ))}
            </div>
          ) : null}

          <div className="record-list">
            {loading ? <p className="empty-hint">正在读取记录…</p> : null}
            {!loading && filtered.length === 0 ? (
              <div className="empty-hint">
                <strong>还没有匹配的记录</strong>
                <span>打开一篇博客，在侧栏点击“记录并总结”。</span>
              </div>
            ) : null}
            {filtered.map((record) => (
              <button
                type="button"
                key={record.id}
                className={selected?.id === record.id ? 'record-item active' : 'record-item'}
                onClick={() => setSelectedId(record.id)}
              >
                <span className={`record-status status-${record.status}`} />
                <span className="record-item-main">
                  <strong>{record.page.title}</strong>
                  <span>
                    {safeHostname(record.page.url)} · {formatDate(record.updatedAt)}
                  </span>
                  {record.tags.length > 0 ? (
                    <span className="record-item-tags">{record.tags.slice(0, 3).map((tag) => `#${tag}`).join(' ')}</span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="detail-panel">
          {selected ? (
            <>
              <div className="detail-head">
                <div className="detail-heading">
                  <span className="eyebrow">
                    {safeHostname(selected.page.url)}
                    {selected.page.author ? ` · ${selected.page.author}` : ''}
                  </span>
                  <h1>{selected.page.title}</h1>
                  <a href={selected.page.url} target="_blank" rel="noreferrer" className="source-link">
                    {selected.page.url}
                  </a>
                  <div className="detail-meta">
                    <span>记录于 {formatDate(selected.createdAt)}</span>
                    <span>{flattenOutline(selected.page.outline).length} 个标题</span>
                    <span>{selected.page.wordCount.toLocaleString()} 字</span>
                    <span className={`status-label status-${selected.status}`}>
                      {selected.status === 'ready' ? '已总结' : selected.status === 'error' ? '总结失败' : '已捕获'}
                    </span>
                  </div>
                </div>
                <div className="detail-actions">
                  <button type="button" className="secondary-action" onClick={openSource}>
                    打开原文
                  </button>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => void writeFeishu(selected.feishu?.documentId ? 'append' : 'create')}
                    disabled={feishuLoading || (!selected.feishu?.documentId && !selected.summary)}
                    title={!selected.feishu?.documentId && !selected.summary ? '请先在侧栏生成总结' : undefined}
                  >
                    {feishuLoading
                      ? '写入中…'
                      : selected.feishu?.documentId
                        ? '追加到飞书'
                        : '写入飞书'}
                  </button>
                  {selected.feishu?.documentId ? (
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => void writeFeishu('create')}
                      disabled={feishuLoading || !selected.summary}
                    >
                      新建文档
                    </button>
                  ) : null}
                </div>
              </div>

              {selected.error ? <div className="error-box">{selected.error}</div> : null}

              <div className="detail-columns">
                <div className="detail-main">
                  <section className="detail-section">
                    <div className="detail-section-heading">
                      <h2>内容概览</h2>
                      {selected.summary ? <span>{selected.summary.model}</span> : null}
                    </div>
                    {selected.summary ? (
                      <>
                        <p className="overview">{selected.summary.overview}</p>
                        <div className="tag-row">
                          {selected.summary.tags.map((tag) => (
                            <span className="tag" key={tag}>
                              #{tag}
                            </span>
                          ))}
                        </div>
                        {selected.summary.keyConcepts.length > 0 ? (
                          <div className="concept-grid">
                            <div className="concept-grid-label">关键概念</div>
                            {selected.summary.keyConcepts.map((concept) => (
                              <div className="concept-card" key={concept.term}>
                                <strong>{concept.term}</strong>
                                <p>{concept.explanation}</p>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="muted">还没有生成总结；可以回到原网页的侧栏生成。</p>
                    )}
                  </section>

                  {selected.selections.length > 0 ? (
                    <section className="detail-section">
                      <div className="detail-section-heading">
                        <h2>选中的原文</h2>
                        <span>{selected.selections.length} 段</span>
                      </div>
                      <div className="selection-list">
                        {selected.selections.map((item, index) => (
                          <blockquote className="selection-card" key={`${item.anchor}-${index}`}>
                            {item.headingPath.length > 0 ? <span>{item.headingPath.join(' / ')}</span> : null}
                            <p>{item.text}</p>
                          </blockquote>
                        ))}
                      </div>
                    </section>
                  ) : null}

                  <section className="detail-section">
                    <div className="detail-section-heading">
                      <h2>大纲树</h2>
                      <span>点击标题只会在原文中定位</span>
                    </div>
                    <OutlineTree
                      nodes={selected.page.outline}
                      summary={selected.summary}
                      onJump={() => {
                        flash('请在原网页的侧栏中点击大纲标题定位。');
                      }}
                    />
                  </section>
                </div>

                <aside className="detail-aside">
                  <section className="aside-section">
                    <h2>我的笔记</h2>
                    <textarea
                      className="notes-area"
                      value={selected.notes}
                      onChange={(event) => void updateSelected({ notes: event.target.value })}
                      rows={7}
                      placeholder="写下自己的理解或待验证的问题…"
                    />
                  </section>

                  <section className="aside-section">
                    <h2>标签</h2>
                    <div className="tag-row">
                      {selected.tags.length > 0 ? (
                        selected.tags.map((tag) => (
                          <span className="tag editable" key={tag}>
                            #{tag}
                            <button type="button" onClick={() => void removeTag(tag)}>
                              ×
                            </button>
                          </span>
                        ))
                      ) : (
                        <span className="muted">还没有标签。</span>
                      )}
                    </div>
                    <div className="inline-input">
                      <input
                        value={tagInput}
                        onChange={(event) => setTagInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void addTag();
                        }}
                        placeholder="添加标签"
                      />
                      <button type="button" className="secondary-action" onClick={() => void addTag()}>
                        添加
                      </button>
                    </div>
                  </section>

                  <section className="aside-section">
                    <h2>导出</h2>
                    <div className="stack-actions">
                      <button type="button" className="secondary-action" onClick={() => void copyMarkdown()}>
                        复制 Markdown
                      </button>
                      <button type="button" className="secondary-action" onClick={downloadMarkdown}>
                        下载 Markdown
                      </button>
                    </div>
                    {selected.feishu ? (
                      <p className="feishu-link">
                        飞书文档：
                        {selected.feishu.url ? (
                          <a href={selected.feishu.url} target="_blank" rel="noreferrer">
                            打开
                          </a>
                        ) : (
                          selected.feishu.documentId
                        )}
                      </p>
                    ) : null}
                  </section>

                  <button type="button" className="danger-link delete-record" onClick={() => void removeSelected()}>
                    删除这条记录
                  </button>
                </aside>
              </div>
            </>
          ) : (
            <div className="detail-empty">
              <span>▤</span>
              <h1>选择一条学习记录</h1>
              <p>左侧会显示你保存过的网页、总结和标签。</p>
            </div>
          )}
        </main>
      </div>

      {notice ? <div className={notice.error ? 'notice error' : 'notice'}>{notice.text}</div> : null}
    </div>
  );
}
