import { useEffect, useMemo, useState } from 'react';
import type {
  BridgeHealth,
  DocumentTarget,
  FeishuWikiState,
  StudyRecord,
} from '../shared/types';
import { deleteRecord, listRecords, saveRecord } from '../shared/db';
import { asErrorMessage, formatDate, safeHostname } from '../shared/utils';
import { flattenOutline } from '../shared/skills';
import { recordToMarkdown } from '../shared/markdown';
import type {
  BridgeHealthResponse,
  WikiPublishMessageResponse,
  WikiStateResponse,
} from '../shared/messages';
import { sendRuntimeMessage } from '../shared/messages';
import {
  DOCUMENT_TARGETS,
  DOCUMENT_TARGET_LABELS,
  DOCUMENT_TARGET_SHORT_LABELS,
  getDocumentRef,
  syncStateText,
  withDocumentRef,
} from '../shared/documents';
import { writeRecordToDocument, type DocumentWriteMode } from '../shared/document-actions';
import { loadSettings } from '../shared/settings';
import { filterWikiPages, buildWiki, type WikiPage, type WikiPageKind } from '../shared/wiki';
import OutlineTree from '../sidepanel/components/OutlineTree';
import './styles.css';

type SortMode = 'recent' | 'title';
type ViewMode = 'library' | 'wiki';

export default function DashboardApp() {
  const [records, setRecords] = useState<StudyRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>('recent');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docTarget, setDocTarget] = useState<DocumentTarget>('feishu');
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [wikiState, setWikiState] = useState<FeishuWikiState | null>(null);
  const [wikiPublishing, setWikiPublishing] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>(
    window.location.hash === '#wiki' ? 'wiki' : 'library',
  );
  const [wikiQuery, setWikiQuery] = useState('');
  const [wikiKind, setWikiKind] = useState<'all' | WikiPageKind>('all');
  const [wikiPageId, setWikiPageId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
    void loadSettings().then((settings) => setDocTarget(settings.documents.defaultTarget));
    void sendRuntimeMessage<WikiStateResponse>({ type: 'PS_GET_WIKI_STATE' })
      .then((response) => {
        if (response.ok) setWikiState(response.state ?? null);
      })
      .catch(() => {
        // 发布状态读取失败不影响本地 Wiki 浏览。
      });
    const onHashChange = () => setViewMode(window.location.hash === '#wiki' ? 'wiki' : 'library');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
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

  const wiki = useMemo(() => buildWiki(records), [records]);
  const wikiPages = useMemo(
    () => filterWikiPages(wiki.pages, wikiQuery, wikiKind),
    [wiki.pages, wikiQuery, wikiKind],
  );
  const selectedWiki = useMemo(
    () => wikiPages.find((page) => page.id === wikiPageId) ?? wikiPages[0] ?? null,
    [wikiPageId, wikiPages],
  );

  useEffect(() => {
    if (selectedWiki && selectedWiki.id !== wikiPageId) setWikiPageId(selectedWiki.id);
  }, [selectedWiki, wikiPageId]);

  const switchView = (mode: ViewMode) => {
    setViewMode(mode);
    window.history.replaceState(null, '', mode === 'wiki' ? '#wiki' : '#library');
  };

  const updateSelected = async (patch: Partial<StudyRecord>) => {
    if (!selected) return;
    const next: StudyRecord = { ...selected, ...patch, updatedAt: Date.now() };
    setRecords((current) => current.map((record) => (record.id === next.id ? next : record)));
    await saveRecord(next);
    // 后台会根据“保存后自动更新 Wiki”设置决定是否入队；这里不阻塞编辑。
    void sendRuntimeMessage({ type: 'PS_REQUEST_WIKI_PUBLISH' }).catch(() => {
      // 自动 Wiki 发布失败不影响本地保存。
    });
  };

  const openSource = () => {
    if (!selected) return;
    if (!selected.page.url) {
      flash('这条手动摘录没有填写地址。');
      return;
    }
    void chrome.tabs
      .create({ url: selected.page.url })
      .catch((error) => flash(`无法打开原文：${asErrorMessage(error)}`, true));
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

  const checkBridge = async (): Promise<BridgeHealth> => {
    try {
      const response = await sendRuntimeMessage<BridgeHealthResponse & { ok: boolean }>({
        type: 'PS_BRIDGE_HEALTH',
      });
      const health: BridgeHealth = {
        ok: Boolean(response.ok),
        larkCli: Boolean(response.larkCli),
        wiki: Boolean(response.wiki),
        notion: Boolean(response.notion),
        markdown: Boolean(response.markdown),
        markdownDir: response.markdownDir,
        version: response.version,
        syncPending: response.syncPending,
        syncError: response.syncError,
        error: response.error,
      };
      setBridgeHealth(health);
      return health;
    } catch (error) {
      const health: BridgeHealth = {
        ok: false,
        larkCli: false,
        wiki: false,
        notion: false,
        markdown: false,
        error: asErrorMessage(error),
      };
      setBridgeHealth(health);
      return health;
    }
  };

  const publishWikiToFeishu = async () => {
    if (wiki.pages.length === 0) {
      flash('本地 Wiki 还没有页面，先保存一条学习记录。', true);
      return;
    }
    setWikiPublishing(true);
    try {
      const health = await checkBridge();
      if (!health.ok) throw new Error(health.error ?? '本地桥接服务未运行，请先运行 npm run bridge。');
      if (!health.larkCli) throw new Error('飞书 CLI 未就绪，请检查 lark-cli 登录状态。');
      if (!health.wiki) throw new Error('桥接版本过旧，请重启本地桥接以启用飞书 Wiki 接口。');
      const response = await sendRuntimeMessage<WikiPublishMessageResponse>({ type: 'PS_PUBLISH_WIKI' });
      if (!response.ok) throw new Error(response.error ?? '发布飞书 Wiki 失败');
      setWikiState(response.state ?? null);
      const created = response.created ?? 0;
      const updated = response.updated ?? 0;
      const skipped = response.skipped ?? 0;
      flash(`已同步到飞书文档库：新建 ${created}，更新 ${updated}，跳过 ${skipped}。`);
    } catch (error) {
      flash(asErrorMessage(error), true);
      try {
        const stateResponse = await sendRuntimeMessage<WikiStateResponse>({ type: 'PS_GET_WIKI_STATE' });
        if (stateResponse.ok) setWikiState(stateResponse.state ?? null);
      } catch {
        // 读取部分映射失败时保留旧状态，至少把发布错误提示给用户。
      }
    } finally {
      setWikiPublishing(false);
    }
  };

  const writeDocument = async (target: DocumentTarget, mode: DocumentWriteMode = 'auto') => {
    if (!selected) return;
    if (mode === 'append' && !getDocumentRef(selected, target)) {
      flash('还没有已写入该平台的文档，请先创建。', true);
      return;
    }
    setDocLoading(true);
    try {
      const health = await checkBridge();
      if (!health.ok) throw new Error(health.error ?? '本地文档桥接服务未运行，请先运行 npm run bridge。');
      if (target === 'feishu' && !health.larkCli) throw new Error('飞书 CLI 未就绪，请检查 lark-cli 登录状态。');
      if (target === 'notion' && !health.notion) throw new Error('Notion 未配置，请先在桥接环境变量中设置 NOTION_TOKEN。');
      if (target === 'markdown' && !health.markdown) {
        throw new Error('本地 Markdown 未配置，请先设置 PAGESTUDY_MARKDOWN_DIR。');
      }
      const response = await writeRecordToDocument(selected, target, mode);
      if (!response.ok || !response.documentId) {
        throw new Error(response.error ?? `${DOCUMENT_TARGET_LABELS[target]}写入失败`);
      }
      await updateSelected(
        withDocumentRef(selected, {
          target,
          documentId: response.documentId,
          url: response.url ?? '',
          writtenAt: Date.now(),
          title: selected.page.title,
        }),
      );
      flash(mode === 'append' ? '已追加到文档。' : '已写入文档。');
      if (mode === 'create' && response.url) void chrome.tabs.create({ url: response.url });
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setDocLoading(false);
    }
  };

  const removeSelected = async () => {
    if (!selected) return;
    if (!window.confirm(`删除“${selected.page.title}”？此操作不可撤销。`)) return;
    await deleteRecord(selected.id);
    const next = records.filter((record) => record.id !== selected.id);
    setRecords(next);
    setSelectedId(next[0]?.id ?? null);
    // 删除会改变 Wiki 的页面清单；后台按设置决定是否入队更新。
    void sendRuntimeMessage({ type: 'PS_REQUEST_WIKI_PUBLISH' }).catch(() => {
      // 自动 Wiki 发布失败不影响本地删除。
    });
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
          <div className="view-switch" role="tablist" aria-label="视图">
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'library'}
              className={viewMode === 'library' ? 'active' : ''}
              onClick={() => switchView('library')}
            >
              记录库
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={viewMode === 'wiki'}
              className={viewMode === 'wiki' ? 'active' : ''}
              onClick={() => switchView('wiki')}
            >
              本地 Wiki
            </button>
          </div>
          <button type="button" className="secondary-action" onClick={openOptions}>
            设置
          </button>
          <button type="button" className="secondary-action" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </header>

      {viewMode === 'wiki' ? (
        <WikiBrowser
          pages={wikiPages}
          byId={wiki.byId}
          query={wikiQuery}
          onQueryChange={setWikiQuery}
          kind={wikiKind}
          onKindChange={setWikiKind}
          selected={selectedWiki}
          onSelect={setWikiPageId}
          counts={{ notes: wiki.noteCount, tags: wiki.tagCount, concepts: wiki.conceptCount }}
          publishState={wikiState}
          publishing={wikiPublishing}
          onPublish={() => void publishWikiToFeishu()}
          onOpenRecord={(recordId) => {
            setSelectedId(recordId);
            switchView('library');
          }}
        />
      ) : (
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
                    {record.page.manual ? '手动摘录' : safeHostname(record.page.url)} · {formatDate(record.updatedAt)}
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
                    {selected.page.manual ? '手动摘录' : safeHostname(selected.page.url)}
                    {selected.page.author ? ` · ${selected.page.author}` : ''}
                  </span>
                  <h1>{selected.page.title}</h1>
                  {selected.page.url ? (
                    <a href={selected.page.url} target="_blank" rel="noreferrer" className="source-link">
                      {selected.page.url}
                    </a>
                  ) : (
                    <span className="source-link">手动摘录（未填写地址）</span>
                  )}
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
                  <select
                    className="doc-target-select"
                    aria-label="文档目标"
                    value={docTarget}
                    onChange={(event) => setDocTarget(event.target.value as DocumentTarget)}
                    disabled={docLoading}
                  >
                    {DOCUMENT_TARGETS.map((target) => (
                      <option value={target} key={target}>
                        {DOCUMENT_TARGET_LABELS[target]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() =>
                      void writeDocument(
                        docTarget,
                        getDocumentRef(selected, docTarget) ? 'append' : 'create',
                      )
                    }
                    disabled={docLoading}
                  >
                    {docLoading
                      ? '写入中…'
                      : `${getDocumentRef(selected, docTarget) ? '追加到' : '写入'}${
                          DOCUMENT_TARGET_SHORT_LABELS[docTarget]
                        }`}
                  </button>
                  {getDocumentRef(selected, docTarget) ? (
                    <button
                      type="button"
                      className="secondary-action"
                      onClick={() => void writeDocument(docTarget, 'create')}
                      disabled={docLoading}
                    >
                      新建一份
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
                    <div className="document-refs">
                      {DOCUMENT_TARGETS.map((target) => {
                        const ref = getDocumentRef(selected, target);
                        if (!ref) return null;
                        const sync = selected.sync?.[target];
                        return (
                          <div className="document-ref" key={target}>
                            <span className="document-ref-label">
                              {DOCUMENT_TARGET_SHORT_LABELS[target]}
                            </span>
                            {ref.url ? (
                              <a href={ref.url} target="_blank" rel="noreferrer" title={ref.documentId}>
                                打开文档
                              </a>
                            ) : (
                              <span className="document-path" title={ref.documentId}>
                                {ref.documentId}
                              </span>
                            )}
                            {sync ? (
                              <span className={`sync-state sync-${sync.status}`}>{syncStateText(sync)}</span>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {bridgeHealth && !bridgeHealth.ok ? (
                      <p className="muted">桥接未连接：{bridgeHealth.error ?? '请先运行 npm run bridge'}</p>
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
      )}

      {notice ? <div className={notice.error ? 'notice error' : 'notice'}>{notice.text}</div> : null}
    </div>
  );
}

interface WikiBrowserProps {
  pages: WikiPage[];
  byId: Map<string, WikiPage>;
  query: string;
  onQueryChange: (value: string) => void;
  kind: 'all' | WikiPageKind;
  onKindChange: (kind: 'all' | WikiPageKind) => void;
  selected: WikiPage | null;
  onSelect: (id: string) => void;
  counts: { notes: number; tags: number; concepts: number };
  publishState: FeishuWikiState | null;
  publishing: boolean;
  onPublish: () => void;
  onOpenRecord: (recordId: string) => void;
}

function WikiBrowser({
  pages,
  byId,
  query,
  onQueryChange,
  kind,
  onKindChange,
  selected,
  onSelect,
  counts,
  publishState,
  publishing,
  onPublish,
  onOpenRecord,
}: WikiBrowserProps) {
  const backlinks = selected
    ? selected.backlinks.map((id) => byId.get(id)).filter((page): page is WikiPage => Boolean(page))
    : [];
  const kindLabel = (value: WikiPageKind) =>
    value === 'note' ? '记录' : value === 'tag' ? '标签' : '概念';
  const publishedPages = publishState ? Object.keys(publishState.pages).length : 0;
  const totalPages = counts.notes + counts.tags + counts.concepts;

  return (
    <div className="wiki-shell">
      <aside className="wiki-list-panel">
        <div className="library-head">
          <div>
            <span className="eyebrow">LOCAL WIKI</span>
            <h1>我的知识库</h1>
          </div>
          <span className="record-total">{counts.notes + counts.tags + counts.concepts}</span>
        </div>
        <p className="wiki-intro">
          每次保存学习记录后自动派生：记录页、标签页和概念页互相建立反链，不需要额外上传。
        </p>
        <input
          className="search-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索标题、标签、概念…"
        />
        <div className="wiki-kind-tabs">
          {(
            [
              ['all', '全部'],
              ['note', '记录'],
              ['tag', '标签'],
              ['concept', '概念'],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={kind === value ? 'active' : ''}
              onClick={() => onKindChange(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wiki-counts">
          {counts.notes} 条记录 · {counts.tags} 个标签 · {counts.concepts} 个概念
        </div>
        <div className="wiki-publish-row">
          <button
            type="button"
            className="primary-action"
            onClick={onPublish}
            disabled={publishing || totalPages === 0}
          >
            {publishing ? '发布中…' : '发布到飞书文档库'}
          </button>
          {publishState?.root.url ? (
            <a
              className="secondary-action"
              href={publishState.root.url}
              target="_blank"
              rel="noreferrer"
            >
              打开飞书 Wiki
            </a>
          ) : null}
          <span className={publishState?.lastError ? 'wiki-publish-status bad' : 'wiki-publish-status'}>
            {publishState?.lastError
              ? `上次发布失败：${publishState.lastError}`
              : publishState
                ? `已发布 ${publishedPages} 页${publishState.lastPublishedAt ? ` · ${formatDate(publishState.lastPublishedAt)}` : ''}`
                : '尚未发布到飞书'}
          </span>
        </div>
        <div className="record-list">
          {pages.length === 0 ? (
            <p className="empty-hint">还没有 Wiki 页面；先在侧栏保存一条学习记录。</p>
          ) : null}
          {pages.map((page) => (
            <button
              type="button"
              key={page.id}
              className={selected?.id === page.id ? 'record-item active' : 'record-item'}
              onClick={() => onSelect(page.id)}
            >
              <span className={`wiki-kind-badge wiki-kind-${page.kind}`}>{kindLabel(page.kind)}</span>
              <span className="record-item-main">
                <strong>{page.title}</strong>
                <span>{page.overview || page.subtitle}</span>
                <span className="record-item-tags">
                  {page.kind === 'note'
                    ? `${page.backlinks.length} 个主题`
                    : `${page.recordCount} 条记录`}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <main className="detail-panel wiki-detail">
        {selected ? (
          <>
            <div className="detail-head">
              <div className="detail-heading">
                <span className="eyebrow">
                  {kindLabel(selected.kind)}
                  {selected.subtitle ? ` · ${selected.subtitle}` : ''}
                </span>
                <h1>{selected.title}</h1>
                <div className="detail-meta">
                  <span>{selected.recordCount} 条记录</span>
                  {selected.backlinks.length > 0 ? <span>{selected.backlinks.length} 条反链</span> : null}
                  {selected.tags.length > 0 ? <span>{selected.tags.map((tag) => `#${tag}`).join(' ')}</span> : null}
                </div>
              </div>
              <div className="detail-actions">
                {selected.recordId ? (
                  <button
                    type="button"
                    className="primary-action"
                    onClick={() => onOpenRecord(selected.recordId as string)}
                  >
                    在记录库查看
                  </button>
                ) : null}
                {selected.sourceUrl ? (
                  <a className="secondary-action" href={selected.sourceUrl} target="_blank" rel="noreferrer">
                    打开原文
                  </a>
                ) : null}
              </div>
            </div>

            <section className="detail-section">
              <div className="detail-section-heading">
                <h2>概要</h2>
                <span>由已保存记录自动生成</span>
              </div>
              <p className="overview">{selected.overview || '这条记录还没有概览。'}</p>
            </section>

            {selected.concepts.length > 0 ? (
              <section className="detail-section">
                <div className="detail-section-heading">
                  <h2>关键概念</h2>
                </div>
                <div className="concept-grid">
                  {selected.concepts.map((concept) => (
                    <div className="concept-card" key={concept.term}>
                      <strong>{concept.term}</strong>
                      <p>{concept.explanation || '暂无解释。'}</p>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {selected.sections.length > 0 ? (
              <section className="detail-section">
                <div className="detail-section-heading">
                  <h2>逐节笔记</h2>
                </div>
                <div className="wiki-section-list">
                  {selected.sections.map((section) => (
                    <article className="wiki-section-card" key={section.outlineId}>
                      <h3>{section.title}</h3>
                      <p>{section.summary}</p>
                      {section.keyPoints.length > 0 ? (
                        <ul>
                          {section.keyPoints.map((point) => (
                            <li key={point}>{point}</li>
                          ))}
                        </ul>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="detail-section">
              <div className="detail-section-heading">
                <h2>反向链接</h2>
                <span>{backlinks.length}</span>
              </div>
              {backlinks.length === 0 ? (
                <p className="muted">还没有其他页面链接到这里。</p>
              ) : (
                <div className="backlink-list">
                  {backlinks.map((page) => (
                    <button
                      type="button"
                      className="backlink-card"
                      key={page.id}
                      onClick={() => onSelect(page.id)}
                    >
                      <span className={`wiki-kind-badge wiki-kind-${page.kind}`}>{kindLabel(page.kind)}</span>
                      <strong>{page.title}</strong>
                      <span>{page.overview}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

          </>
        ) : (
          <div className="detail-empty">
            <span>▤</span>
            <h1>本地 Wiki 还没有页面</h1>
            <p>保存第一条学习记录后，这里会出现记录页、标签页和概念页。</p>
          </div>
        )}
      </main>
    </div>
  );
}
