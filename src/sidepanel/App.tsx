import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatHistoryMessage,
  ChatMessage,
  ChatRequest,
  BridgeHealth,
  DocumentTarget,
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
import { recordToMarkdown } from '../shared/markdown';
import { createManualPage, isRestrictedPageUrl } from '../shared/page';
import { deleteRecord, findRecordsByUrl, getRecord, saveRecord } from '../shared/db';
import {
  DOCUMENT_TARGETS,
  DOCUMENT_TARGET_LABELS,
  DOCUMENT_TARGET_SHORT_LABELS,
  getDocumentRef,
  syncStateText,
  withDocumentRef,
} from '../shared/documents';
import { writeRecordToDocument, type DocumentWriteMode } from '../shared/document-actions';
import { SETTINGS_KEY } from '../shared/constants';
import {
  sendRuntimeMessage,
  sendTabMessage,
  type BridgeHealthResponse,
  type ChatPortEvent,
  type ChatPortRequest,
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
  const [docLoading, setDocLoading] = useState(false);
  const [docTarget, setDocTarget] = useState<DocumentTarget>('feishu');
  const [sideTab, setSideTab] = useState<SideTab>('chat');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [bridgeHealth, setBridgeHealth] = useState<BridgeHealth | null>(null);
  const [manualMode, setManualMode] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const manualContextRef = useRef<{ url: string; title: string; text: string }>({ url: '', title: '', text: '' });
  const autoSyncTimerRef = useRef<number | null>(null);

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

  const queueAutoSync = useCallback(
    async (next: StudyRecord) => {
      if (!settings?.documents.autoSync) return;
      try {
        await sendRuntimeMessage({ type: 'PS_ENQUEUE_SYNC', recordId: next.id });
      } catch {
        // 自动同步失败不阻断本地保存；启动时还有补传队列。
      }
    },
    [settings?.documents.autoSync],
  );

  const patchRecord = useCallback(
    (patch: Partial<StudyRecord>) => {
      const current = recordRef.current;
      if (!current) return;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      void persistRecord(next);
      // 笔记/标签连续输入时不要每个按键都排队；停顿后自动同步一次。
      if (autoSyncTimerRef.current !== null) window.clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = window.setTimeout(() => {
        autoSyncTimerRef.current = null;
        void queueAutoSync(next);
      }, 2500);
    },
    [persistRecord, queueAutoSync],
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
      const nextTabId = targetTab.id;
      tabIdRef.current = nextTabId;
      setTabId(nextTabId);
      const nextUrl = targetTab.url ?? '';
      const nextTitle = targetTab.title ?? '';

      const loadFoundRecord = async (found: StudyRecord | null, fallbackPage: PageContext | null) => {
        if (found) {
          recordRef.current = found;
          setRecord(found);
          setPage(found.page);
          setManualMode(false);
          messagesRef.current = found.messages;
          setMessages(found.messages);
          contextsRef.current = found.selections;
          setContexts(found.selections);
          if (fallbackPage && found.page.contentHash !== fallbackPage.contentHash) {
            showNotice('网页内容与记录快照不一致；当前记录仍保留原快照。', 'info');
          }
        } else {
          recordRef.current = null;
          setRecord(null);
          setPage(fallbackPage);
          messagesRef.current = [];
          setMessages([]);
          contextsRef.current = [];
          setContexts([]);
        }
        setSelection(null);
      };

      if (!nextUrl) {
        // 某些浏览器内置页即使拿到标签页对象也不会暴露 URL；仍然允许按标题手动记录。
        setPage(null);
        setRecord(null);
        recordRef.current = null;
        setManualMode(true);
        setManualTitle(nextTitle || '手动摘录');
        setManualUrl('');
        setManualText('');
        setPageError('当前标签页的地址不可读取；请手动填写标题和摘录内容。');
        setSideTab('record');
        return;
      }

      // 浏览器内置页（chrome://、edge://、扩展页等）禁止内容脚本注入。
      // 这里保留标签页信息，进入手动摘录模式，而不是把整个侧栏置空。
      if (isRestrictedPageUrl(nextUrl)) {
        const found = (await findRecordsByUrl(nextUrl)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (loadSeqRef.current !== seq) return;
        await loadFoundRecord(found, null);
        if (!found) {
          const draft = manualContextRef.current;
          const same = draft.url === nextUrl;
          setManualMode(true);
          setManualTitle(same ? draft.title : nextTitle || '手动摘录');
          setManualUrl(nextUrl);
          setManualText(same ? draft.text : '');
          setPageError('当前是浏览器内置页面，无法自动读取正文；可以在下方手动摘录后记录。');
          setSideTab('record');
        }
        return;
      }

      let nextPage: PageContext | null = null;
      let contentError = '';
      try {
        const response = await sendTabMessage<PageContextResponse>(nextTabId, { type: 'PS_GET_PAGE_CONTEXT' });
        if (response.ok && response.page) nextPage = response.page;
        else throw new Error(response.error ?? '页面内容读取失败');
      } catch (error) {
        contentError = asErrorMessage(error);
      }
      if (loadSeqRef.current !== seq) return;

      if (!nextPage) {
        const found = (await findRecordsByUrl(nextUrl)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (loadSeqRef.current !== seq) return;
        if (found) {
          await loadFoundRecord(found, null);
          setPageError(`无法重新读取网页正文：${contentError}。当前显示已保存的快照。`);
        } else {
          await loadFoundRecord(null, null);
          setManualMode(true);
          setManualTitle(nextTitle || '手动摘录');
          setManualUrl(nextUrl);
          setManualText('');
          setPageError(`无法读取页面正文：${contentError}。可以刷新网页、重新加载扩展，或在下方手动摘录。`);
          setSideTab('record');
        }
        return;
      }

      setManualMode(false);
      setPage(nextPage);
      const found = await findRecordForPage(nextPage);
      if (loadSeqRef.current !== seq) return;
      await loadFoundRecord(found, nextPage);
    } catch (error) {
      if (loadSeqRef.current !== seq) return;
      setPage(null);
      setManualMode(false);
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
    if (settings) setDocTarget(settings.documents.defaultTarget);
  }, [settings?.documents.defaultTarget]);

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current !== null) window.clearTimeout(autoSyncTimerRef.current);
    };
  }, []);

  useEffect(() => {
    manualContextRef.current = { url: manualUrl, title: manualTitle, text: manualText };
  }, [manualUrl, manualTitle, manualText]);

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
    if (tabId === null || !page || page.manual) return;
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

  const buildManualContext = (): PageContext | null => {
    const title = manualTitle.trim() || manualUrl.trim() || '手动摘录';
    if (!manualText.trim() && !manualTitle.trim()) return null;
    return createManualPage({ url: manualUrl, title, text: manualText });
  };

  const capturePage = async (manualOverride?: PageContext | null): Promise<StudyRecord | null> => {
    let freshPage = manualOverride ?? page;
    if (!freshPage && manualMode) freshPage = buildManualContext();
    if (!freshPage || tabId === null) {
      showNotice('当前页面还没有可记录的内容。', 'error');
      return null;
    }
    if (!freshPage.manual) {
      try {
        const response = await sendTabMessage<PageContextResponse>(tabId, { type: 'PS_GET_PAGE_CONTEXT' });
        if (response.ok && response.page) freshPage = response.page;
      } catch {
        // 沿用上一次读取到的大纲，避免因页面短暂失联导致记录失败。
      }
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
    void queueAutoSync(next);
    showNotice(isSameContent ? '记录已更新。' : '本页已记录。', 'success');
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
      void queueAutoSync(next);
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
    const manual = manualMode ? buildManualContext() : null;
    if (manualMode && !manual) {
      showNotice('请先填写标题，或粘贴一段要记录的正文。', 'error');
      return;
    }
    const next = await capturePage(manual);
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

  const openDashboard = (hash = '') => {
    void chrome.tabs.create({ url: chrome.runtime.getURL(`dashboard.html${hash}`) });
  };

  const openWiki = () => openDashboard('#wiki');

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
      const health: BridgeHealth = { ok: false, larkCli: false, notion: false, markdown: false, error: asErrorMessage(error) };
      setBridgeHealth(health);
      return health;
    }
  };

  const refreshRecordSync = async () => {
    const current = recordRef.current;
    if (!current) return;
    try {
      const fresh = await getRecord(current.id);
      if (!fresh) return;
      const next: StudyRecord = {
        ...current,
        feishu: fresh.feishu ?? current.feishu,
        documents: fresh.documents,
        sync: fresh.sync,
      };
      await persistRecord(next);
      showNotice('已刷新文档同步状态。', 'success');
    } catch (error) {
      showNotice(asErrorMessage(error), 'error');
    }
  };

  const writeDocument = async (target: DocumentTarget, mode: DocumentWriteMode = 'auto') => {
    const current = recordRef.current;
    if (!current) return;
    if (!settings?.feishu.url) {
      showNotice('请先在设置页配置本地文档桥接服务地址。', 'error');
      return;
    }
    if (mode === 'append' && !getDocumentRef(current, target)) {
      showNotice('还没有已写入该平台的文档，请先创建。', 'info');
      return;
    }
    // 手动写入与“停顿后自动同步”可能并发；先取消尚未触发的自动任务，避免重复追加。
    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
      autoSyncTimerRef.current = null;
    }
    setDocLoading(true);
    try {
      const health = await checkBridge();
      if (!health?.ok) throw new Error(health?.error ?? '本地文档桥接服务未运行，请先运行 npm run bridge。');
      if (target === 'feishu' && !health.larkCli) throw new Error('飞书 CLI 未就绪，请检查 lark-cli 登录状态。');
      if (target === 'notion' && !health.notion) throw new Error('Notion 未配置，请先在桥接环境变量中设置 NOTION_TOKEN。');
      if (target === 'markdown' && !health.markdown) {
        throw new Error('本地 Markdown 未配置，请先设置 PAGESTUDY_MARKDOWN_DIR。');
      }
      const response = await writeRecordToDocument(current, target, mode);
      if (!response.ok || !response.documentId) {
        throw new Error(response.error ?? `${DOCUMENT_TARGET_LABELS[target]}写入失败`);
      }
      const next = withDocumentRef(current, {
        target,
        documentId: response.documentId,
        url: response.url ?? '',
        writtenAt: Date.now(),
        title: current.page.title,
      });
      await persistRecord(next);
      showNotice(mode === 'append' ? `已追加到${DOCUMENT_TARGET_SHORT_LABELS[target]}。` : `已写入${DOCUMENT_TARGET_SHORT_LABELS[target]}。`, 'success');
      // 不自动打开外部文档标签页：切换标签会丢失侧栏的当前网页上下文。
    } catch (error) {
      showNotice(asErrorMessage(error), 'error');
    } finally {
      setDocLoading(false);
    }
  };

  const openSource = () => {
    if (!record) return;
    if (!record.page.url) {
      showNotice('这条手动摘录没有填写地址。', 'info');
      return;
    }
    void chrome.tabs.create({ url: record.page.url }).catch((error) => {
      showNotice(`无法打开原文：${asErrorMessage(error)}`, 'error');
    });
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
          <button type="button" className="icon-button" onClick={() => openDashboard()} title="打开记录库">
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
              {page.manual ? '手动摘录' : safeHostname(page.url)}
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
              {page.manual ? <span>手动摘录</span> : null}
              {record ? <span className="record-state">已记录</span> : null}
            </div>
          </>
        ) : (
          <div className="page-empty">
            <strong>{manualMode ? '手动摘录模式' : '暂无可读取的网页'}</strong>
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
              docLoading={docLoading}
              bridgeHealth={bridgeHealth}
              docTarget={docTarget}
              setDocTarget={setDocTarget}
              autoSync={Boolean(settings?.documents.autoSync)}
              tagInput={tagInput}
              setTagInput={setTagInput}
              onJump={jumpToAnchor}
              onOpenSource={openSource}
              onResummarize={resummarize}
              onWriteDocument={writeDocument}
              onRefreshSync={refreshRecordSync}
              onCopyMarkdown={copyMarkdown}
              onDownloadMarkdown={downloadMarkdown}
              onDelete={deleteCurrentRecord}
              onNotesChange={(notes) => patchRecord({ notes })}
              onAddTag={addTag}
              onRemoveTag={removeTag}
              onOpenDashboard={() => openDashboard()}
              onOpenWiki={openWiki}
              onOpenOptions={openOptions}
            />
          ) : (
            <div className="record-empty">
              <div className="record-empty-icon">▤</div>
              <h2>{manualMode ? '手动摘录浏览器内置页' : '记录本页，形成学习档案'}</h2>
              <p>
                {manualMode
                  ? '浏览器内置页面不能被扩展自动读取。把标题、地址和要学习的段落粘贴到下面，PageStudy 仍会保存记录、生成总结并归入 Wiki。'
                  : '点击后先保存网页链接、大纲和当前对话，再按大纲生成逐节总结。网页以后变化，记录仍保留当时的快照。'}
              </p>
              {manualMode ? (
                <ManualCaptureFields
                  title={manualTitle}
                  url={manualUrl}
                  text={manualText}
                  onTitleChange={setManualTitle}
                  onUrlChange={setManualUrl}
                  onTextChange={setManualText}
                />
              ) : outline.length > 0 ? (
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
                  {manualMode ? '记录摘录并总结' : '记录并总结'}
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
  docLoading: boolean;
  bridgeHealth: BridgeHealth | null;
  docTarget: DocumentTarget;
  setDocTarget: (target: DocumentTarget) => void;
  autoSync: boolean;
  tagInput: string;
  setTagInput: (value: string) => void;
  onJump: (anchor: string) => void;
  onOpenSource: () => void;
  onResummarize: () => void;
  onWriteDocument: (target: DocumentTarget, mode: DocumentWriteMode) => void;
  onRefreshSync: () => void;
  onCopyMarkdown: () => void;
  onDownloadMarkdown: () => void;
  onDelete: () => void;
  onNotesChange: (notes: string) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
  onOpenDashboard: () => void;
  onOpenWiki: () => void;
  onOpenOptions: () => void;
}

function RecordView({
  record,
  summary,
  outline,
  summaryLoading,
  docLoading,
  bridgeHealth,
  docTarget,
  setDocTarget,
  autoSync,
  tagInput,
  setTagInput,
  onJump,
  onOpenSource,
  onResummarize,
  onWriteDocument,
  onRefreshSync,
  onCopyMarkdown,
  onDownloadMarkdown,
  onDelete,
  onNotesChange,
  onAddTag,
  onRemoveTag,
  onOpenDashboard,
  onOpenWiki,
  onOpenOptions,
}: RecordViewProps) {
  const activeRef = getDocumentRef(record, docTarget);
  const targetReady =
    docTarget === 'feishu'
      ? Boolean(bridgeHealth?.larkCli)
      : docTarget === 'notion'
        ? Boolean(bridgeHealth?.notion)
        : Boolean(bridgeHealth?.markdown);
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
          {record.page.manual ? <span className="manual-badge">手动摘录</span> : null}
        </div>
        <div className="record-head-actions">
          <button type="button" className="text-button" onClick={onOpenWiki}>
            Wiki
          </button>
          <button type="button" className="text-button" onClick={onOpenSource}>
            打开原文
          </button>
        </div>
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
        <button type="button" className="secondary-button" onClick={onOpenDashboard}>
          记录库
        </button>
      </div>

      <section className="document-panel">
        <div className="document-panel-head">
          <div>
            <strong>保存到文档</strong>
            <span className="muted">{autoSync ? '保存后自动同步已开启' : '自动同步未开启'}</span>
          </div>
          <div className="document-panel-controls">
            <select
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
            <button type="button" className="text-button" onClick={onRefreshSync} disabled={docLoading}>
              刷新状态
            </button>
          </div>
        </div>
        <div className="document-buttons">
          <button
            type="button"
            className="secondary-button"
            onClick={() => onWriteDocument(docTarget, activeRef ? 'append' : 'create')}
            disabled={docLoading}
            title={targetReady ? undefined : '桥接尚未就绪，点击后会先检查服务状态'}
          >
            {docLoading
              ? '写入中…'
              : `${activeRef ? '追加到' : '写入'}${DOCUMENT_TARGET_SHORT_LABELS[docTarget]}`}
          </button>
          {activeRef ? (
            <button
              type="button"
              className="text-button"
              onClick={() => onWriteDocument(docTarget, 'create')}
              disabled={docLoading}
              title="为当前记录再创建一份新文档"
            >
              新建一份
            </button>
          ) : null}
        </div>
        <div className="document-refs">
          {DOCUMENT_TARGETS.map((target) => {
            const ref = getDocumentRef(record, target);
            if (!ref) return null;
            const sync = record.sync?.[target];
            return (
              <div className="document-ref" key={target}>
                <span className="document-ref-label">{DOCUMENT_TARGET_SHORT_LABELS[target]}</span>
                {ref.url ? (
                  <a href={ref.url} target="_blank" rel="noreferrer" title={ref.documentId}>
                    打开文档
                  </a>
                ) : (
                  <span className="document-path" title={ref.documentId}>
                    {ref.documentId}
                  </span>
                )}
                {sync ? <span className={`sync-state sync-${sync.status}`}>{syncStateText(sync)}</span> : null}
              </div>
            );
          })}
          {DOCUMENT_TARGETS.every((target) => !getDocumentRef(record, target)) ? (
            <span className="muted">尚未写入文档。配置桥接后可以手动写入，或开启自动同步。</span>
          ) : null}
        </div>
        {bridgeHealth && !bridgeHealth.ok ? (
          <p className="muted">桥接未连接：{bridgeHealth.error ?? '请先运行 npm run bridge'}</p>
        ) : null}
      </section>

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
          <button type="button" className="secondary-button" onClick={onOpenWiki}>
            打开 Wiki
          </button>
          <button type="button" className="secondary-button" onClick={onOpenOptions}>
            文档与同步设置
          </button>
        </div>
        <p className="muted bridge-hint">
          {bridgeHealth?.ok
            ? `本地桥接已连接：飞书 ${bridgeHealth.larkCli ? '就绪' : '未就绪'} · Notion ${
                bridgeHealth.notion ? '就绪' : '未配置'
              } · 本地 Markdown ${bridgeHealth.markdown ? '就绪' : '未配置'}`
            : '需要本地桥接服务：在项目目录运行 npm run bridge。'}
        </p>
      </section>

      <div className="danger-row">
        <button type="button" className="text-button danger" onClick={onDelete}>
          删除这条记录
        </button>
      </div>
    </div>
  );
}

interface ManualCaptureFieldsProps {
  title: string;
  url: string;
  text: string;
  onTitleChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onTextChange: (value: string) => void;
}

function ManualCaptureFields({
  title,
  url,
  text,
  onTitleChange,
  onUrlChange,
  onTextChange,
}: ManualCaptureFieldsProps) {
  return (
    <div className="manual-capture">
      <label>
        <span>标题</span>
        <input
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="例如：浏览器设置页 / 扩展管理页"
        />
      </label>
      <label>
        <span>地址（可留空）</span>
        <input
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          placeholder="chrome://settings 或 edge://extensions"
        />
      </label>
      <label>
        <span>摘录正文</span>
        <textarea
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="粘贴页面文字。没有正文也可以只保存标题和链接，稍后手动补充笔记。"
          rows={8}
        />
      </label>
      <p className="muted">
        手动摘录不会伪装成自动读取；记录会标记为“手动摘录”，并照常进入总结、文档同步和本地 Wiki。
      </p>
    </div>
  );
}
