import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatHistoryMessage,
  ChatMessage,
  ChatRequest,
  BridgeHealth,
  PageContext,
  PageSummary,
  PublicSettings,
  SelectionContext,
  Skill,
  StudyRecord,
  SummaryRequest,
} from '../shared/types';
import {
  createId,
  asErrorMessage,
  formatDate,
  safeHostname,
  truncate,
} from '../shared/utils';
import { flattenOutline, getAllSkills, getSkillById } from '../shared/skills';
import {
  recordToFeishuAppendMarkdown,
  recordToFeishuTitle,
  recordToMarkdown,
} from '../shared/markdown';
import { deleteRecord, findRecordsByUrl, saveRecord } from '../shared/db';
import { SETTINGS_KEY } from '../shared/constants';
import {
  sendRuntimeMessage,
  sendTabMessage,
  type BridgeHealthResponse,
  type ChatPortEvent,
  type ChatPortRequest,
  type FeishuWriteResponse,
  type PageContextResponse,
  type SelectionResponse,
  type SummarizeResponse,
} from '../shared/messages';
import OutlineTree from './components/OutlineTree';
import RichText from './components/RichText';
import './styles.css';

interface PublicSettingsResponse {
  ok: boolean;
  settings?: PublicSettings;
  error?: string;
}

type NoticeKind = 'info' | 'success' | 'error';
interface Notice {
  text: string;
  kind: NoticeKind;
}

type SideTab = 'chat' | 'record';

function activeProviderOf(settings: PublicSettings | null) {
  return settings ? settings.providers[settings.activeProvider] : null;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function mergeSelections(current: SelectionContext[], next: SelectionContext): SelectionContext[] {
  if (!next.text.trim()) return current;
  if (current.some((item) => item.text === next.text)) return current;
  return [...current, next].slice(0, 4);
}

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsError, setSettingsError] = useState('');
  const [skills, setSkills] = useState<Skill[]>(() => getAllSkills());
  const [skillId, setSkillId] = useState('general');
  const [tabId, setTabId] = useState<number | null>(null);
  const [page, setPage] = useState<PageContext | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState('');
  const [selection, setSelection] = useState<SelectionContext | null>(null);
  const [contexts, setContexts] = useState<SelectionContext[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [record, setRecord] = useState<StudyRecord | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [feishuLoading, setFeishuLoading] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>('chat');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);

  const loadSeqRef = useRef(0);
  const tabIdRef = useRef<number | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const recordRef = useRef<StudyRecord | null>(null);
  const contextsRef = useRef<SelectionContext[]>([]);
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const activeRequestRef = useRef<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const showNotice = useCallback((text: string, kind: NoticeKind = 'info') => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ text, kind });
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4200);
  }, []);

  const applyMessages = useCallback(
    (updater: (previous: ChatMessage[]) => ChatMessage[]) => {
      setMessages((previous) => {
        const next = updater(previous);
        messagesRef.current = next;
        return next;
      });
    },
    [],
  );

  const syncMessagesToRecord = useCallback(() => {
    const current = recordRef.current;
    if (!current) return;
    const next = {
      ...current,
      messages: messagesRef.current,
      updatedAt: Date.now(),
    };
    recordRef.current = next;
    setRecord(next);
    void saveRecord(next);
  }, []);

  const persistRecord = useCallback(async (next: StudyRecord) => {
    recordRef.current = next;
    setRecord(next);
    await saveRecord(next);
  }, []);

  const patchRecord = useCallback(
    (patch: Partial<StudyRecord>) => {
      const current = recordRef.current;
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      void persistRecord(next);
    },
    [persistRecord],
  );

  const loadSettings = useCallback(async () => {
    try {
      const response = await sendRuntimeMessage<PublicSettingsResponse>({ type: 'PS_GET_PUBLIC_SETTINGS' });
      if (!response.ok || !response.settings) throw new Error(response.error ?? '读取设置失败');
      setSettings(response.settings);
      setSettingsError('');
      const nextSkills = getAllSkills(response.settings.customSkills);
      setSkills(nextSkills);
      setSkillId((current) => (nextSkills.some((skill) => skill.id === current) ? current : 'general'));
    } catch (error) {
      setSettingsError(asErrorMessage(error));
    }
  }, []);

  const loadTab = useCallback(async (requestedTabId?: number) => {
    const seq = ++loadSeqRef.current;
    setPageLoading(true);
    setPageError('');
    let targetTab: chrome.tabs.Tab | undefined;
    try {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      targetTab = requestedTabId ? tabs.find((item) => item.id === requestedTabId) ?? tabs[0] : tabs[0];
      if (!targetTab?.id) throw new Error('没有找到当前标签页。');
      if (targetTab.url && !/^https?:\/\//.test(targetTab.url)) {
        throw new Error('请在普通网页中使用 PageStudy；浏览器内置页面不支持读取正文。');
      }
      const nextTabId = targetTab.id;
      tabIdRef.current = nextTabId;
      setTabId(nextTabId);

      let nextPage: PageContext | null = null;
      try {
        const response = await sendTabMessage<PageContextResponse>(nextTabId, { type: 'PS_GET_PAGE_CONTEXT' });
        if (response.ok && response.page) nextPage = response.page;
        else throw new Error(response.error ?? '页面内容读取失败');
      } catch (error) {
        throw new Error(`无法读取页面正文：${asErrorMessage(error)}。请刷新网页或重新加载扩展后再试。`);
      }
      if (loadSeqRef.current !== seq) return;

      setPage(nextPage);
      setContexts((current) => current.filter(Boolean));
      const found = await findRecordForPage(nextPage);
      if (loadSeqRef.current !== seq) return;

      if (found) {
        recordRef.current = found;
        setRecord(found);
        messagesRef.current = found.messages;
        setMessages(found.messages);
        contextsRef.current = found.selections;
        setContexts(found.selections);
        if (found.page.contentHash !== nextPage.contentHash) {
          showNotice('网页内容与记录快照不一致；当前记录仍保留原快照。', 'info');
        }
      } else {
        recordRef.current = null;
        setRecord(null);
        messagesRef.current = [];
        setMessages([]);
        contextsRef.current = [];
        setContexts([]);
      }
      setSelection(null);
    } catch (error) {
      if (loadSeqRef.current !== seq) return;
      setPage(null);
      setRecord(null);
      recordRef.current = null;
      setPageError(asErrorMessage(error));
    } finally {
      if (loadSeqRef.current === seq) setPageLoading(false);
    }
  }, [showNotice]);

  const findRecordForPage = async (nextPage: PageContext): Promise<StudyRecord | null> => {
    const byCanonical = await findRecordsByUrl(nextPage.canonicalUrl);
    const byUrl = nextPage.url === nextPage.canonicalUrl ? [] : await findRecordsByUrl(nextPage.url);
    const candidates = [...byCanonical, ...byUrl];
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  };

  useEffect(() => {
    void loadSettings();
    void loadTab();
    const onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[SETTINGS_KEY]) void loadSettings();
    };
    chrome.storage.onChanged.addListener(onStorageChanged);
    return () => chrome.storage.onChanged.removeListener(onStorageChanged);
  }, [loadSettings, loadTab]);

  useEffect(() => {
    const onActivated = () => void loadTab();
    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabIdRef.current && changeInfo.status === 'complete') {
        void loadTab(updatedTabId);
      }
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [loadTab]);

  useEffect(() => {
    contextsRef.current = contexts;
  }, [contexts]);

  useEffect(() => {
    if (tabId === null || !page) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await sendTabMessage<SelectionResponse>(tabId, { type: 'PS_GET_SELECTION' });
        if (!cancelled) setSelection(response.ok ? response.selection ?? null : null);
      } catch {
        if (!cancelled) setSelection(null);
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1100);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tabId, page?.url]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  useEffect(() => {
    if (!record) return;
    const timer = window.setTimeout(() => {
      void saveRecord(record);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [record?.id, record?.notes, record?.tags]);

  const provider = activeProviderOf(settings);
  const hasApiKey = Boolean(provider?.hasApiKey);

  const addSelection = () => {
    if (!selection) return;
    const next = mergeSelections(contextsRef.current, selection);
    if (next.length === contextsRef.current.length) {
      showNotice('这段内容已经在上下文里了。', 'info');
      return;
    }
    contextsRef.current = next;
    setContexts(next);
    if (recordRef.current) patchRecord({ selections: next });
    showNotice('已加入上下文。', 'success');
  };

  const removeSelection = (index: number) => {
    const next = contextsRef.current.filter((_, itemIndex) => itemIndex !== index);
    contextsRef.current = next;
    setContexts(next);
    if (recordRef.current) patchRecord({ selections: next });
  };

  const ensurePort = useCallback((): chrome.runtime.Port => {
    if (portRef.current) return portRef.current;
    const port = chrome.runtime.connect({ name: 'ps-chat' });
    port.onMessage.addListener((event: ChatPortEvent) => {
      const requestId = activeRequestRef.current;
      if (!requestId || event.requestId !== requestId) return;
      const messageId = `assistant_${requestId}`;
      if (event.type === 'delta') {
        applyMessages((previous) =>
          previous.map((message) =>
            message.id === messageId ? { ...message, content: message.content + event.text } : message,
          ),
        );
        return;
      }
      if (event.type === 'done') {
        activeRequestRef.current = null;
        setStreaming(false);
        const target = messagesRef.current.find((message) => message.id === messageId);
        if (target && !target.content.trim()) {
          applyMessages((previous) =>
            previous.map((message) =>
              message.id === messageId ? { ...message, content: '（模型没有返回文字内容）' } : message,
            ),
          );
        }
        syncMessagesToRecord();
        return;
      }
      if (event.type === 'error') {
        activeRequestRef.current = null;
        setStreaming(false);
        applyMessages((previous) =>
          previous.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  content: message.content || event.error,
                  error: !message.content,
                }
              : message,
          ),
        );
        syncMessagesToRecord();
      }
    });
    port.onDisconnect.addListener(() => {
      portRef.current = null;
      if (activeRequestRef.current) {
        activeRequestRef.current = null;
        setStreaming(false);
        showNotice('聊天连接已断开，请重试。', 'error');
      }
    });
    portRef.current = port;
    return port;
  }, [applyMessages, showNotice, syncMessagesToRecord]);

  const sendChat = () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (!hasApiKey) {
      showNotice('请先在设置页配置模型 API Key。', 'error');
      return;
    }
    const requestId = createId('req');
    const userMessage: ChatMessage = {
      id: createId('user'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      skillId,
    };
    const assistantMessage: ChatMessage = {
      id: `assistant_${requestId}`,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      skillId,
    };
    const history: ChatHistoryMessage[] = [...messagesRef.current, userMessage]
      .filter((message) => message.content.trim() && !message.error)
      .slice(-20)
      .map((message) => ({ role: message.role, content: message.content }));
    const skill = getSkillById(skills, skillId);
    const payload: ChatRequest = {
      requestId,
      messages: history,
      page,
      selections: contextsRef.current,
      skill,
      language: settings?.outputLanguage ?? '中文',
      model: provider?.model ?? '',
    };
    applyMessages((previous) => [...previous, userMessage, assistantMessage]);
    setInput('');
    setStreaming(true);
    activeRequestRef.current = requestId;
    try {
      const port = ensurePort();
      const request: ChatPortRequest = { type: 'chat.start', payload };
      port.postMessage(request);
    } catch (error) {
      activeRequestRef.current = null;
      setStreaming(false);
      applyMessages((previous) =>
        previous.map((message) =>
          message.id === assistantMessage.id
            ? { ...message, content: `无法连接后台：${asErrorMessage(error)}`, error: true }
            : message,
        ),
      );
    }
  };

  const stopChat = () => {
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    try {
      const request: ChatPortRequest = { type: 'chat.abort', requestId };
      portRef.current?.postMessage(request);
    } catch {
      // 端口可能已经断开。
    }
    activeRequestRef.current = null;
    setStreaming(false);
    applyMessages((previous) =>
      previous.map((message) =>
        message.id === `assistant_${requestId}` && !message.content.trim()
          ? { ...message, content: '已停止生成。' }
          : message,
      ),
    );
    syncMessagesToRecord();
  };

  const capturePage = async (): Promise<StudyRecord | null> => {
    if (!page || tabId === null) {
      showNotice('当前页面还没有可记录的大纲。', 'error');
      return null;
    }
    let freshPage = page;
    try {
      const response = await sendTabMessage<PageContextResponse>(tabId, { type: 'PS_GET_PAGE_CONTEXT' });
      if (response.ok && response.page) freshPage = response.page;
    } catch {
      // 沿用上一次读取到的大纲，避免因页面短暂失联导致记录失败。
    }
    setPage(freshPage);
    const existing = recordRef.current;
    const isSameContent = existing?.page.contentHash === freshPage.contentHash;
    const next: StudyRecord = {
      id: existing?.id ?? createId('record'),
      page: freshPage,
      summary: isSameContent ? existing?.summary ?? null : null,
      messages: messagesRef.current,
      selections: contextsRef.current,
      notes: existing?.notes ?? '',
      tags: existing?.tags ?? [],
      status: isSameContent && existing?.summary ? 'ready' : 'captured',
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      feishu: isSameContent ? existing?.feishu ?? null : null,
      error: null,
    };
    await persistRecord(next);
    setSideTab('record');
    showNotice(isSameContent ? '记录已更新。' : '本页已记录，正在整理大纲。', 'success');
    return next;
  };

  const summarizeRecord = async (target: StudyRecord) => {
    if (!hasApiKey) {
      showNotice('请先在设置页配置模型 API Key。', 'error');
      return;
    }
    if (!target.page.outline.length) {
      showNotice('没有识别到可总结的大纲。', 'error');
      return;
    }
    setSummaryLoading(true);
    const request: SummaryRequest = {
      page: target.page,
      messages: target.messages.map((message) => ({ role: message.role, content: message.content })),
      selections: target.selections,
      language: settings?.outputLanguage ?? '中文',
      model: provider?.model ?? '',
    };
    try {
      const response = await sendRuntimeMessage<SummarizeResponse>({ type: 'PS_SUMMARIZE', request });
      if (!response.ok || !response.summary) throw new Error(response.error ?? '生成总结失败');
      const next: StudyRecord = {
        ...target,
        summary: response.summary,
        tags: uniqueStrings([...target.tags, ...response.summary.tags]),
        status: 'ready',
        error: null,
        updatedAt: Date.now(),
      };
      await persistRecord(next);
      showNotice('总结已保存。', 'success');
    } catch (error) {
      const next: StudyRecord = {
        ...target,
        status: 'error',
        error: asErrorMessage(error),
        updatedAt: Date.now(),
      };
      await persistRecord(next);
      showNotice(asErrorMessage(error), 'error');
    } finally {
      setSummaryLoading(false);
    }
  };

  const recordPage = async (withSummary: boolean) => {
    const next = await capturePage();
    if (next && withSummary) await summarizeRecord(next);
  };

  const resummarize = async () => {
    const current = recordRef.current;
    if (!current) {
      await recordPage(true);
      return;
    }
    await summarizeRecord(current);
  };

  const openOptions = () => {
    void chrome.runtime.openOptionsPage();
  };

  const openDashboard = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  };

  const jumpToAnchor = (anchor: string) => {
    if (!anchor || tabId === null) return;
    void sendTabMessage<{ ok: boolean }>(tabId, { type: 'PS_SCROLL_TO_ANCHOR', anchor }).catch(() => {
      showNotice('当前页面已经变化，无法定位到该章节。', 'error');
    });
  };

  const copyMarkdown = async () => {
    if (!record) return;
    try {
      await navigator.clipboard.writeText(recordToMarkdown(record));
      showNotice('Markdown 已复制到剪贴板。', 'success');
    } catch (error) {
      showNotice(`复制失败：${asErrorMessage(error)}`, 'error');
    }
  };

  const downloadMarkdown = () => {
    if (!record) return;
    const blob = new Blob([recordToMarkdown(record)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(record.page.title || 'pagestudy').replace(/[\\/:*?"<>|]+/g, '_')}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const checkBridge = async (): Promise<BridgeHealth | null> => {
    try {
      const response = await sendRuntimeMessage<BridgeHealthResponse & { ok: boolean }>({
        type: 'PS_BRIDGE_HEALTH',
      });
      const health: BridgeHealth = {
        ok: Boolean(response.ok),
        larkCli: Boolean(response.larkCli),
        version: response.version,
        error: response.error,
      };
      setBridgeHealth(health);
      return health;
    } catch (error) {
      const health = { ok: false, larkCli: false, error: asErrorMessage(error) };
      setBridgeHealth(health);
      return health;
    }
  };

  const writeFeishu = async (mode: 'create' | 'append' = 'create') => {
    if (!record) return;
    if (!settings?.feishu.url) {
      showNotice('请先在设置页配置飞书桥接服务地址。', 'error');
      return;
    }
    if (mode === 'create' && !record.summary) {
      showNotice('请先生成总结，再写入飞书。', 'info');
      setSideTab('record');
      return;
    }
    if (mode === 'append' && !record.feishu?.documentId) {
      showNotice('还没有已写入的飞书文档，请先创建。', 'info');
      return;
    }
    setFeishuLoading(true);
    try {
      const health = await checkBridge();
      if (!health?.ok || !health.larkCli) {
        throw new Error(health?.error ?? '飞书桥接服务未运行，请先在项目目录运行 npm run bridge。');
      }
      const response =
        mode === 'append'
          ? await sendRuntimeMessage<FeishuWriteResponse>({
              type: 'PS_APPEND_FEISHU',
              documentId: record.feishu?.documentId ?? '',
              markdown: recordToFeishuAppendMarkdown(record),
            })
          : await sendRuntimeMessage<FeishuWriteResponse>({
              type: 'PS_WRITE_FEISHU',
              title: recordToFeishuTitle(record),
              markdown: recordToMarkdown(record),
            });
      if (!response.ok) throw new Error(response.error ?? '飞书写入失败');
      const next: StudyRecord = {
        ...record,
        feishu: {
          url: response.url ?? record.feishu?.url ?? '',
          documentId: response.documentId ?? record.feishu?.documentId ?? '',
          writtenAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await persistRecord(next);
      showNotice(mode === 'append' ? '已追加到飞书文档。' : '已写入飞书文档。', 'success');
      // 不自动打开飞书标签页：那会让侧栏切换到新标签并丢失当前网页上下文。
      // 文档链接显示在记录卡片里，用户需要时再点击。
    } catch (error) {
      showNotice(asErrorMessage(error), 'error');
    } finally {
      setFeishuLoading(false);
    }
  };

  const openSource = () => {
    if (!record) return;
    void chrome.tabs.create({ url: record.page.url });
  };

  const addTag = () => {
    const value = tagInput.trim();
    if (!value || !recordRef.current) return;
    const nextTags = uniqueStrings([...recordRef.current.tags, value]);
    setTagInput('');
    patchRecord({ tags: nextTags });
  };

  const removeTag = (tag: string) => {
    if (!recordRef.current) return;
    patchRecord({ tags: recordRef.current.tags.filter((item) => item !== tag) });
  };

  const deleteCurrentRecord = async () => {
    if (!recordRef.current) return;
    if (!window.confirm('删除这条学习记录？此操作不可撤销。')) return;
    await deleteRecord(recordRef.current.id);
    recordRef.current = null;
    setRecord(null);
    messagesRef.current = [];
    setMessages([]);
    contextsRef.current = [];
    setContexts([]);
    showNotice('记录已删除。', 'success');
  };

  const selectedSkill = useMemo(() => getSkillById(skills, skillId), [skills, skillId]);
  const outline = record?.page.outline ?? page?.outline ?? [];
  const summary = record?.summary ?? null;
  const readingMinutes = page ? Math.max(1, Math.round(page.wordCount / 450)) : 0;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PS</span>
          <div>
            <strong>PageStudy</strong>
            <span className="brand-sub">阅读 · 提问 · 沉淀</span>
          </div>
        </div>
        <div className="topbar-actions">
          <button type="button" className="icon-button" onClick={openDashboard} title="打开记录库">
            库
          </button>
          <button type="button" className="icon-button" onClick={openOptions} title="设置">
            设
          </button>
        </div>
      </header>

      <section className="page-card">
        {pageLoading ? (
          <div className="page-card-loading">
            <span className="spinner" />
            <span>正在读取网页大纲…</span>
          </div>
        ) : page ? (
          <>
            <div className="page-card-kicker">
              {safeHostname(page.url)}
              {page.author ? ` · ${page.author}` : ''}
              {page.publishedAt ? ` · ${page.publishedAt.slice(0, 10)}` : ''}
            </div>
            <h1 className="page-title" title={page.title}>
              {page.title}
            </h1>
            <div className="page-meta">
              <span>{flattenOutline(outline).length} 个标题</span>
              <span>{page.wordCount.toLocaleString()} 字</span>
              <span>约 {readingMinutes} 分钟</span>
              {record ? <span className="record-state">已记录</span> : null}
            </div>
          </>
        ) : (
          <div className="page-empty">
            <strong>暂无可读取的网页</strong>
            <p>{pageError || '打开一篇博客文章，或刷新当前页面后重试。'}</p>
            <button type="button" className="text-button" onClick={openOptions}>
              检查设置
            </button>
          </div>
        )}
      </section>

      {!hasApiKey && settings ? (
        <div className="config-banner">
          <span>还没有配置模型 API Key。</span>
          <button type="button" onClick={openOptions}>
            去配置
          </button>
        </div>
      ) : null}

      <nav className="tabs" aria-label="侧栏功能">
        <button
          type="button"
          className={sideTab === 'chat' ? 'tab active' : 'tab'}
          onClick={() => setSideTab('chat')}
        >
          对话
          {messages.length > 0 ? <span className="tab-count">{messages.length}</span> : null}
        </button>
        <button
          type="button"
          className={sideTab === 'record' ? 'tab active' : 'tab'}
          onClick={() => setSideTab('record')}
        >
          记录
          {record?.summary ? <span className="tab-count success">✓</span> : null}
        </button>
      </nav>

      {sideTab === 'chat' ? (
        <main className="chat-pane">
          <div className="context-bar">
            <div className="context-head">
              <span>上下文</span>
              <span className="context-count">{contexts.length}/4</span>
            </div>
            {contexts.length > 0 ? (
              <div className="context-chips">
                {contexts.map((item, index) => (
                  <span className="context-chip" key={`${item.anchor}-${index}`} title={item.text}>
                    <span>{truncate(item.text, 30)}</span>
                    <button type="button" onClick={() => removeSelection(index)} aria-label="移除上下文">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="context-empty">在网页中选中一段文字，然后点“加入上下文”。</p>
            )}
            {selection && !contexts.some((item) => item.text === selection.text) ? (
              <div className="selection-preview">
                <div>
                  <span className="selection-label">当前选中</span>
                  <p>{truncate(selection.text, 160)}</p>
                  {selection.headingPath.length > 0 ? (
                    <span className="selection-path">{selection.headingPath.join(' / ')}</span>
                  ) : null}
                </div>
                <button type="button" className="small-button" onClick={addSelection}>
                  加入上下文
                </button>
              </div>
            ) : null}
            <div className="skill-row">
              <label htmlFor="skill-select">Skill</label>
              <select
                id="skill-select"
                value={skillId}
                onChange={(event) => setSkillId(event.target.value)}
                disabled={streaming}
              >
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
              <span className="skill-hint">{selectedSkill.description}</span>
            </div>
          </div>

          <div className="message-list">
            {messages.length === 0 ? (
              <div className="chat-empty">
                <div className="empty-mark">“</div>
                <h2>把文章变成自己的理解</h2>
                <p>选中一段话，或直接提问。PageStudy 会带上当前网页大纲；记录本页后还能生成逐节总结。</p>
                <div className="prompt-suggestions">
                  {['这段话的核心论点是什么？', '用一个例子解释这个概念', '作者有哪些没有证明的假设？'].map(
                    (prompt) => (
                      <button
                        type="button"
                        key={prompt}
                        className="suggestion"
                        onClick={() => setInput(prompt)}
                      >
                        {prompt}
                      </button>
                    ),
                  )}
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article
                  key={message.id}
                  className={`message ${message.role === 'user' ? 'message-user' : 'message-assistant'}${
                    message.error ? ' message-error' : ''
                  }`}
                >
                  <div className="message-avatar">{message.role === 'user' ? '我' : 'PS'}</div>
                  <div className="message-main">
                    <div className="message-role">
                      {message.role === 'user' ? '你' : '助教'}
                      {message.skillId && message.role === 'assistant' ? (
                        <span>{getSkillById(skills, message.skillId).name}</span>
                      ) : null}
                    </div>
                    {message.content ? (
                      message.role === 'assistant' ? (
                        <RichText text={message.content} />
                      ) : (
                        <p className="user-text">{message.content}</p>
                      )
                    ) : (
                      <span className="typing">
                        <span />
                        <span />
                        <span />
                      </span>
                    )}
                  </div>
                </article>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendChat();
                }
              }}
              placeholder="基于当前网页或选中段落提问…"
              rows={2}
              disabled={streaming}
            />
            <div className="composer-actions">
              <span>Enter 发送 · Shift+Enter 换行</span>
              {streaming ? (
                <button type="button" className="send-button stop" onClick={stopChat}>
                  停止
                </button>
              ) : (
                <button type="button" className="send-button" onClick={sendChat} disabled={!input.trim()}>
                  发送
                </button>
              )}
            </div>
          </div>
        </main>
      ) : (
        <main className="record-pane">
          {record ? (
            <RecordView
              record={record}
              summary={summary}
              outline={outline}
              summaryLoading={summaryLoading}
              feishuLoading={feishuLoading}
              bridgeHealth={bridgeHealth}
              tagInput={tagInput}
              setTagInput={setTagInput}
              onJump={jumpToAnchor}
              onOpenSource={openSource}
              onResummarize={resummarize}
              onWriteFeishu={writeFeishu}
              onCopyMarkdown={copyMarkdown}
              onDownloadMarkdown={downloadMarkdown}
              onDelete={deleteCurrentRecord}
              onNotesChange={(notes) => patchRecord({ notes })}
              onAddTag={addTag}
              onRemoveTag={removeTag}
              onOpenDashboard={openDashboard}
              onOpenOptions={openOptions}
            />
          ) : (
            <div className="record-empty">
              <div className="record-empty-icon">▤</div>
              <h2>记录本页，形成学习档案</h2>
              <p>
                点击后先保存网页链接、大纲和当前对话，再按大纲生成逐节总结。网页以后变化，记录仍保留当时的快照。
              </p>
              {outline.length > 0 ? (
                <div className="outline-preview">
                  <div className="section-heading">
                    <span>网页大纲</span>
                    <span>{outline.length} 节</span>
                  </div>
                  <OutlineTree nodes={outline.slice(0, 4)} summary={null} onJump={jumpToAnchor} />
                  {outline.length > 4 ? <p className="muted">还有更多章节，记录后完整查看。</p> : null}
                </div>
              ) : null}
              <div className="record-actions">
                <button type="button" className="primary-button" onClick={() => void recordPage(true)}>
                  记录并总结
                </button>
                <button type="button" className="secondary-button" onClick={() => void recordPage(false)}>
                  仅记录
                </button>
              </div>
              {!hasApiKey ? <p className="muted">配置 API Key 后才能生成 AI 总结，但“仅记录”不需要模型。</p> : null}
            </div>
          )}
        </main>
      )}

      {notice ? <div className={`notice notice-${notice.kind}`}>{notice.text}</div> : null}
    </div>
  );
}

interface RecordViewProps {
  record: StudyRecord;
  summary: PageSummary | null;
  outline: PageContext['outline'];
  summaryLoading: boolean;
  feishuLoading: boolean;
  bridgeHealth: BridgeHealth | null;
  tagInput: string;
  setTagInput: (value: string) => void;
  onJump: (anchor: string) => void;
  onOpenSource: () => void;
  onResummarize: () => void;
  onWriteFeishu: (mode: 'create' | 'append') => void;
  onCopyMarkdown: () => void;
  onDownloadMarkdown: () => void;
  onDelete: () => void;
  onNotesChange: (notes: string) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
  onOpenDashboard: () => void;
  onOpenOptions: () => void;
}

function RecordView({
  record,
  summary,
  outline,
  summaryLoading,
  feishuLoading,
  bridgeHealth,
  tagInput,
  setTagInput,
  onJump,
  onOpenSource,
  onResummarize,
  onWriteFeishu,
  onCopyMarkdown,
  onDownloadMarkdown,
  onDelete,
  onNotesChange,
  onAddTag,
  onRemoveTag,
  onOpenDashboard,
  onOpenOptions,
}: RecordViewProps) {
  const statusText =
    record.status === 'ready'
      ? '已总结'
      : record.status === 'error'
        ? '总结失败'
        : '已捕获';
  return (
    <div className="record-view">
      <div className="record-head">
        <div>
          <span className={`status-pill status-${record.status}`}>{statusText}</span>
          <span className="record-time">记录于 {formatDate(record.createdAt)}</span>
        </div>
        <button type="button" className="text-button" onClick={onOpenSource}>
          打开原文
        </button>
      </div>

      {record.error ? <div className="error-box">{record.error}</div> : null}

      <div className="record-actions">
        <button
          type="button"
          className="primary-button"
          onClick={onResummarize}
          disabled={summaryLoading}
        >
          {summaryLoading ? '总结中…' : summary ? '重新总结' : '生成总结'}
        </button>
        {record.feishu?.documentId ? (
          <>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onWriteFeishu('append')}
              disabled={feishuLoading}
              title="把最新笔记和总结追加到已有飞书文档"
            >
              {feishuLoading ? '写入中…' : '追加到飞书'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onWriteFeishu('create')}
              disabled={feishuLoading || !summary}
              title={!summary ? '请先生成总结' : '创建一份新的飞书文档'}
            >
              新建文档
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary-button"
            onClick={() => onWriteFeishu('create')}
            disabled={feishuLoading || !summary}
            title={!summary ? '请先生成总结' : '通过本地桥接写入飞书'}
          >
            {feishuLoading ? '写入中…' : '写入飞书'}
          </button>
        )}
      </div>

      {summary ? (
        <section className="record-section">
          <div className="section-heading">
            <span>内容概览</span>
            <span>{summary.model}</span>
          </div>
          <p className="summary-overview">{summary.overview}</p>
          {summary.tags.length > 0 ? (
            <div className="tag-row">
              {summary.tags.map((tag) => (
                <span className="tag" key={tag}>
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
          {summary.keyConcepts.length > 0 ? (
            <div className="concept-list">
              <div className="concept-label">关键概念</div>
              {summary.keyConcepts.map((concept) => (
                <div className="concept-item" key={concept.term}>
                  <strong>{concept.term}</strong>
                  <span>{concept.explanation}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : (
        <section className="record-section">
          <div className="section-heading">
            <span>内容概览</span>
          </div>
          <p className="muted">
            {record.status === 'error'
              ? '总结生成失败，可以修改模型配置后重试。'
              : '还没有生成总结。大纲与对话已经保存，点击“生成总结”即可整理。'}
          </p>
        </section>
      )}

      <section className="record-section">
        <div className="section-heading">
          <span>大纲树</span>
          <span>{outline.length} 个顶层章节</span>
        </div>
        <OutlineTree nodes={outline} summary={summary} onJump={onJump} />
      </section>

      {record.selections.length > 0 ? (
        <section className="record-section">
          <div className="section-heading">
            <span>选中的原文</span>
            <span>{record.selections.length} 段</span>
          </div>
          {record.selections.map((item, index) => (
            <blockquote className="selection-quote" key={`${item.anchor}-${index}`}>
              {item.headingPath.length > 0 ? <span>{item.headingPath.join(' / ')}</span> : null}
              <p>{truncate(item.text, 240)}</p>
            </blockquote>
          ))}
        </section>
      ) : null}

      <section className="record-section">
        <div className="section-heading">
          <span>我的标签</span>
        </div>
        <div className="tag-row">
          {record.tags.length > 0 ? (
            record.tags.map((tag) => (
              <span className="tag editable-tag" key={tag}>
                #{tag}
                <button type="button" onClick={() => onRemoveTag(tag)} aria-label={`删除标签 ${tag}`}>
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
              if (event.key === 'Enter') {
                event.preventDefault();
                onAddTag();
              }
            }}
            placeholder="输入标签后按 Enter"
          />
          <button type="button" className="small-button" onClick={onAddTag}>
            添加
          </button>
        </div>
      </section>

      <section className="record-section">
        <div className="section-heading">
          <span>我的笔记</span>
          <span>自动保存</span>
        </div>
        <textarea
          className="notes-area"
          value={record.notes}
          onChange={(event) => onNotesChange(event.target.value)}
          placeholder="写下自己的理解、反对意见或待验证的问题…"
          rows={5}
        />
      </section>

      <section className="record-section">
        <div className="section-heading">
          <span>导出与归档</span>
        </div>
        <div className="button-grid">
          <button type="button" className="secondary-button" onClick={onCopyMarkdown}>
            复制 Markdown
          </button>
          <button type="button" className="secondary-button" onClick={onDownloadMarkdown}>
            下载 Markdown
          </button>
          <button type="button" className="secondary-button" onClick={onOpenDashboard}>
            打开记录库
          </button>
          <button type="button" className="secondary-button" onClick={onOpenOptions}>
            飞书设置
          </button>
        </div>
        {record.feishu ? (
          <p className="feishu-result">
            已写入飞书：
            {record.feishu.url ? (
              <a href={record.feishu.url} target="_blank" rel="noreferrer">
                {record.feishu.url}
              </a>
            ) : (
              record.feishu.documentId
            )}
          </p>
        ) : (
          <p className="muted bridge-hint">
            {bridgeHealth?.ok && bridgeHealth.larkCli
              ? '飞书桥接已连接；点击“写入飞书”创建新文档。'
              : '需要本地桥接服务复用现有飞书 CLI；在项目目录运行 npm run bridge。'}
          </p>
        )}
      </section>

      <div className="danger-row">
        <button type="button" className="text-button danger" onClick={onDelete}>
          删除这条记录
        </button>
      </div>
    </div>
  );
}
