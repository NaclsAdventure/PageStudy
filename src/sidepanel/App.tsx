import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatHistoryMessage,
  ChatMessage,
  ChatRequest,
  BridgeHealth,
  ContextMode,
  DialogueInsight,
  DistillRequest,
  DocumentTarget,
  OutlineNode,
  PageContext,
  PageSummary,
  PublicSettings,
  SectionSummaryRequest,
  SelectionContext,
  Skill,
  StudyRecord,
  SummaryRequest,
  SummarySection,
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
import {
  applyPdfManualOutline,
  applyPdfSectionOcr,
  isPdfUrl,
  type PdfManualSection,
} from '../shared/pdf';
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
  type DistillResponse,
  type PageContextResponse,
  type SectionSummaryResponse,
  type SelectionResponse,
  type SummarizeResponse,
} from '../shared/messages';
import OutlineTree from './components/OutlineTree';
import PdfFilePicker from './components/PdfFilePicker';
import PdfOutlineEditor from './components/PdfOutlineEditor';
import RichText from './components/RichText';
import { disposeCachedPdfDoc, loadPdfFile, loadPdfPage } from './pdf-loader';
import { ocrPdfSection } from './pdf-ocr';
import './styles.css';

interface PublicSettingsResponse {
  ok: boolean;
  settings?: PublicSettings;
  error?: string;
}

type NoticeKind = 'info' | 'success' | 'error';
interface NoticeAction {
  label: string;
  onClick: () => void;
}
interface Notice {
  text: string;
  kind: NoticeKind;
  action?: NoticeAction;
}

type SideTab = 'chat' | 'record';

interface DistillDraft {
  userMessageId: string;
  assistantMessageId: string;
  sectionId: string;
  question: string;
  insight: string;
  evidence: string;
  concepts: string;
  loading: boolean;
  ready: boolean;
  error: string;
  skipMessage: string;
}

interface DiscussionTurn {
  user: ChatMessage;
  assistant: ChatMessage;
}

interface MergeUndo {
  recordId: string;
  summary: PageSummary;
  distilledMessageIds: string[];
}

function splitList(value: string, pattern: RegExp): string[] {
  return uniqueStrings(
    value
      .split(pattern)
      .map((item) => item.replace(/^[-*]\s*/, '').trim())
      .filter(Boolean),
  );
}

function findTurnSection(message: ChatMessage, outline: OutlineNode[]): OutlineNode | null {
  const nodes = flattenOutline(outline);
  if (message.anchor) {
    const byAnchor = nodes.find(
      (node) => node.anchor === message.anchor || node.id === message.anchor,
    );
    if (byAnchor) return byAnchor;
  }
  const heading = message.headingPath?.[message.headingPath.length - 1]?.trim();
  if (heading) return nodes.find((node) => node.title === heading) ?? null;
  return null;
}

function findPendingTurn(record: StudyRecord): DiscussionTurn | null {
  const distilled = new Set(record.distilledMessageIds ?? []);
  const messages = record.messages;
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const user = messages[index - 1];
    const assistant = messages[index];
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    if (!user.content.trim() || !assistant.content.trim() || assistant.error) continue;
    if (distilled.has(user.id) || distilled.has(assistant.id)) continue;
    return { user, assistant };
  }
  return null;
}

function turnIsDistilled(record: StudyRecord | null, turn: DiscussionTurn): boolean {
  if (!record) return false;
  const ids = new Set(record.distilledMessageIds ?? []);
  return ids.has(turn.user.id) || ids.has(turn.assistant.id);
}

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
  const [contextMode, setContextMode] = useState<ContextMode>('smart');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [record, setRecord] = useState<StudyRecord | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [sectionSummaryId, setSectionSummaryId] = useState<string | null>(null);
  const [pdfSectionId, setPdfSectionId] = useState('');
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
  const [pdfFileLoading, setPdfFileLoading] = useState(false);
  const [pdfFallback, setPdfFallback] = useState(false);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState('');
  const [distillDraft, setDistillDraft] = useState<DistillDraft | null>(null);
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

  const showNotice = useCallback((text: string, kind: NoticeKind = 'info', action?: NoticeAction) => {
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    setNotice({ text, kind, action });
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), action ? 8000 : 4200);
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

  const queueWikiAutoSync = useCallback(async () => {
    if (!settings?.documents.wikiAutoSync) return;
    try {
      await sendRuntimeMessage({ type: 'PS_REQUEST_WIKI_PUBLISH' });
    } catch {
      // 自动 Wiki 发布失败不阻断本地保存。
    }
  }, [settings?.documents.wikiAutoSync]);

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
        void queueWikiAutoSync();
      }, 2500);
    },
    [persistRecord, queueAutoSync, queueWikiAutoSync],
  );

  const loadSettings = useCallback(async () => {
    try {
      const response = await sendRuntimeMessage<PublicSettingsResponse>({ type: 'PS_GET_PUBLIC_SETTINGS' });
      if (!response.ok || !response.settings) throw new Error(response.error ?? '读取设置失败');
      setSettings(response.settings);
      setSettingsError('');
      setContextMode(response.settings.context?.mode ?? 'smart');
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
    setPdfFallback(false);
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
      const localFile = /^file:/i.test(nextUrl);
      const restricted = isRestrictedPageUrl(nextUrl);
      const likelyPdf =
        isPdfUrl(nextUrl) || /\.pdf(?:$|[?#])/i.test(nextTitle.trim());

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
        setPdfSectionId('');
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
        setPdfFallback(likelyPdf);
        setPageError('当前标签页的地址不可读取；请手动填写标题和摘录内容。');
        setSideTab('record');
        return;
      }

      let pdfError = '';
      // file:// 也属于“受限 URL”，但 PDF 可以绕过 content script 直接解析或让用户选文件。
      if (likelyPdf && nextUrl && (!restricted || localFile)) {
        try {
          const pdfPage = await loadPdfPage(nextUrl, nextTitle);
          if (pdfPage) {
            if (loadSeqRef.current !== seq) return;
            setManualMode(false);
            setPage(pdfPage);
            if (pdfPage.needsOcr) {
              showNotice('这是扫描版 PDF：补目录后按小节实时 OCR，不会上传整本文件。', 'info');
            }
            const found = await findRecordForPage(pdfPage);
            if (loadSeqRef.current !== seq) return;
            await loadFoundRecord(found, pdfPage);
            setSideTab((found?.page ?? pdfPage).outline.length > 0 ? 'chat' : 'record');
            return;
          }
        } catch (error) {
          pdfError = asErrorMessage(error);
        }
      }
      if (loadSeqRef.current !== seq) return;

      // 浏览器内置页（chrome://、edge://、扩展页等）禁止内容脚本注入。
      // file:// 的 PDF 读取失败也走这里，但会额外显示“选择本地 PDF”入口。
      if (restricted) {
        setPdfFallback(localFile && likelyPdf);
        // 本地 PDF 读取失败时不抢先显示旧快照，否则用户看不到“选择本地 PDF”入口。
        const found = localFile && pdfError
          ? null
          : (await findRecordsByUrl(nextUrl)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (loadSeqRef.current !== seq) return;
        await loadFoundRecord(found, null);
        if (!found) {
          const draft = manualContextRef.current;
          const same = draft.url === nextUrl;
          setManualMode(true);
          setManualTitle(same ? draft.title : nextTitle || '手动摘录');
          setManualUrl(nextUrl);
          setManualText(same ? draft.text : '');
          setPageError(
            pdfError
              ? `PDF 读取失败：${pdfError}`
              : '当前是浏览器内置页面，无法自动读取正文；可以在下方手动摘录后记录。',
          );
          setSideTab('record');
        } else if (pdfError) {
          setPageError(`PDF 读取失败：${pdfError}。当前显示已保存的快照。`);
        }
        return;
      }

      let nextPage: PageContext | null = null;
      let contentError = '';
      // PDF 已明确解析失败时不再让 content script 去读 PDF 占位页，否则会把空壳当普通网页。
      if (!pdfError) {
        try {
          const response = await sendTabMessage<PageContextResponse>(nextTabId, { type: 'PS_GET_PAGE_CONTEXT' });
          if (response.ok && response.page) nextPage = response.page;
          else throw new Error(response.error ?? '页面内容读取失败');
        } catch (error) {
          contentError = asErrorMessage(error);
        }
      }
      if (loadSeqRef.current !== seq) return;

      if (!nextPage) {
        const failureText = pdfError ? `PDF 读取失败：${pdfError}` : contentError;
        const found = (await findRecordsByUrl(nextUrl)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
        if (loadSeqRef.current !== seq) return;
        if (found) {
          await loadFoundRecord(found, null);
          setPageError(`${failureText}。当前显示已保存的快照。`);
        } else {
          await loadFoundRecord(null, null);
          setManualMode(true);
          setManualTitle(nextTitle || '手动摘录');
          setManualUrl(nextUrl);
          setManualText('');
          setPageError(
            `${failureText}。可以刷新网页、重新加载扩展，或把要学习的文字粘到下方手动摘录。`,
          );
          setSideTab('record');
        }
        return;
      }

      setManualMode(false);
      setPage(nextPage);
      // 当前已是普通网页，之前扫描版 PDF 的渲染句柄不再需要。
      if (nextPage.sourceType !== 'pdf') void disposeCachedPdfDoc();
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
  const indexedChars = page?.wordCount ?? 0;
  const imageCount = page?.images?.length ?? 0;
  const contextReady = Boolean(page?.blocks?.length || page?.outline.length);

  const activeSelections = (): SelectionContext[] => {
    if (!selection) return contextsRef.current;
    return mergeSelections(contextsRef.current, selection);
  };

  const changeContextMode = (mode: ContextMode) => {
    const previous = contextMode;
    setContextMode(mode);
    void sendRuntimeMessage({
      type: 'PS_SAVE_CONTEXT_SETTINGS',
      context: {
        mode,
        includeImages: settings?.context.includeImages ?? true,
      },
    }).catch(() => {
      setContextMode(previous);
      showNotice('上下文设置保存失败，请重试。', 'error');
    });
  };

  const removeSelection = (index: number) => {
    const next = contextsRef.current.filter((_, itemIndex) => itemIndex !== index);
    contextsRef.current = next;
    setContexts(next);
    if (recordRef.current) patchRecord({ selections: next });
  };

  const toggleImage = (imageId: string) => {
    const current = recordRef.current;
    if (!current) return;
    const allIds = (current.page.images ?? []).map((image) => image.id);
    const selected = new Set(current.selectedImageIds ?? allIds);
    if (selected.has(imageId)) selected.delete(imageId);
    else selected.add(imageId);
    patchRecord({ selectedImageIds: allIds.filter((id) => selected.has(id)) });
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

  const ensurePdfSectionOcr = async (
    sourcePage: PageContext,
    section: OutlineNode,
  ): Promise<{ page: PageContext; section: OutlineNode } | null> => {
    if (section.text.trim()) return { page: sourcePage, section };
    if (!sourcePage.needsOcr) return null;
    if (ocrLoading) {
      showNotice('正在 OCR 当前小节，请稍等。', 'info');
      return null;
    }
    setOcrLoading(true);
    setOcrProgress(`准备 OCR《${section.title}》…`);
    try {
      const result = await ocrPdfSection(sourcePage, section, (progress) => {
        setOcrProgress(
          `正在 OCR《${section.title}》第 ${progress.current}/${progress.total} 页…`,
        );
      });
      const nextPage = applyPdfSectionOcr(sourcePage, section.id, result.text, result.pages);
      const latest = recordRef.current;
      if (latest && latest.page.url === sourcePage.url) {
        await persistRecord({ ...latest, page: nextPage, updatedAt: Date.now() });
      }
      setPage(nextPage);
      const nextSection =
        flattenOutline(nextPage.outline).find((node) => node.id === section.id) ?? section;
      setPdfSectionId(nextSection.id);
      showNotice(`已识别《${section.title}》的 ${result.pages.length} 页。`, 'success');
      return { page: nextPage, section: nextSection };
    } catch (error) {
      showNotice(asErrorMessage(error), 'error');
      return null;
    } finally {
      setOcrLoading(false);
      setOcrProgress('');
    }
  };

  const sendChat = async () => {
    const text = input.trim();
    if (!text || streaming || ocrLoading) return;
    if (!hasApiKey) {
      showNotice('请先在设置页配置模型 API Key。', 'error');
      return;
    }
    let chatPage = activePage;
    let focus = pdfFocusSection;
    if (isPdf && chatPage?.needsOcr && (!focus || !focus.text.trim())) {
      if (!focus) {
        showNotice('请先在记录页补 PDF 目录，再选择一个小节。', 'error');
        return;
      }
      const recognized = await ensurePdfSectionOcr(chatPage, focus);
      if (!recognized) return;
      chatPage = recognized.page;
      focus = recognized.section;
    }
    if (isPdf && !focus?.text.trim()) {
      showNotice('请先在记录页补 PDF 目录，或选择一个有正文的小节。', 'error');
      return;
    }
    const messageAnchor = focus?.anchor ?? selection?.anchor;
    const messageHeadingPath = focus ? [focus.title] : selection?.headingPath;
    const requestId = createId('req');
    const userMessage: ChatMessage = {
      id: createId('user'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      skillId,
      anchor: messageAnchor,
      headingPath: messageHeadingPath,
    };
    const assistantMessage: ChatMessage = {
      id: `assistant_${requestId}`,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      skillId,
      anchor: messageAnchor,
      headingPath: messageHeadingPath,
    };
    const history: ChatHistoryMessage[] = [...messagesRef.current, userMessage]
      .filter((message) => message.content.trim() && !message.error)
      .slice(-20)
      .map((message) => ({ role: message.role, content: message.content }));
    const skill = getSkillById(skills, skillId);
    const payload: ChatRequest = {
      requestId,
      messages: history,
      page: chatPage,
      selections: isPdf ? [] : activeSelections(),
      skill,
      language: settings?.outputLanguage ?? '中文',
      model: provider?.model ?? '',
      contextMode: isPdf ? 'selection' : contextMode,
      focusSectionId: isPdf ? focus?.id : undefined,
      query: text,
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
    if (freshPage.sourceType === 'pdf' && freshPage.outline.length === 0) {
      showNotice('这个 PDF 还没有目录；请先在记录页按页码范围补目录。', 'error');
      return null;
    }
    if (!freshPage.manual && freshPage.sourceType !== 'pdf') {
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
      selections: activeSelections(),
      selectedImageIds: isSameContent
        ? existing?.selectedImageIds
        : settings?.context.includeImages === false
          ? []
          : (freshPage.images ?? []).map((image) => image.id),
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
    void queueWikiAutoSync();
    showNotice(isSameContent ? '记录已更新。' : '本页已记录。', 'success');
    return next;
  };

  const summarizeRecord = async (target: StudyRecord) => {
    if (target.page.sourceType === 'pdf') {
      showNotice('PDF 按小节总结：请在下方选择一个小节，点“总结本节”。', 'info');
      return;
    }
    if (!hasApiKey) {
      showNotice('请先在设置页配置模型 API Key。', 'error');
      return;
    }
    if (!target.page.blocks?.some((block) => block.text.trim()) && !target.page.outline.length) {
      showNotice('没有识别到可用于知识卡的正文。', 'error');
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
      if (!response.ok || !response.summary) throw new Error(response.error ?? '生成知识卡失败');
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
      void queueWikiAutoSync();
      showNotice('知识卡已保存。', 'success');
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

  const applyPdfOutline = (entries: PdfManualSection[]) => {
    if (!activePage || activePage.sourceType !== 'pdf') {
      throw new Error('当前页面不是 PDF。');
    }
    const next = applyPdfManualOutline(activePage, entries);
    setPage(next);
    setPageError('');
    setPdfSectionId(next.outline[0]?.id ?? '');
    const current = recordRef.current;
    if (current && current.page.sourceType === 'pdf' && current.page.outline.length === 0) {
      const nextRecord: StudyRecord = {
        ...current,
        page: next,
        updatedAt: Date.now(),
      };
      void persistRecord(nextRecord);
    }
    setSideTab('record');
    showNotice(`已应用目录：${next.outline.length} 个小节。`, 'success');
  };

  const loadLocalPdf = async (file: File) => {
    const seq = loadSeqRef.current;
    setPdfFileLoading(true);
    setPageError('');
    try {
      const sourceUrl = manualUrl.trim() || `file:///${file.name}`;
      const sourceTitle = manualTitle.trim() || file.name;
      const pdfPage = await loadPdfFile(file, sourceUrl, sourceTitle);
      if (loadSeqRef.current !== seq) return;
      const found = await findRecordForPage(pdfPage);
      if (loadSeqRef.current !== seq) return;
      const target = found?.page ?? pdfPage;
      setManualMode(false);
      if (found) {
        recordRef.current = found;
        setRecord(found);
        setPage(found.page);
        messagesRef.current = found.messages;
        setMessages(found.messages);
        contextsRef.current = found.selections;
        setContexts(found.selections);
        if (found.page.contentHash !== pdfPage.contentHash) {
          showNotice('本地 PDF 与已保存快照不一致；当前仍显示原快照。', 'info');
        }
      } else {
        recordRef.current = null;
        setRecord(null);
        setPage(pdfPage);
        messagesRef.current = [];
        setMessages([]);
        contextsRef.current = [];
        setContexts([]);
      }
      setSelection(null);
      setPdfSectionId(target.outline[0]?.id ?? '');
      setSideTab(target.outline.length > 0 ? 'chat' : 'record');
      showNotice(
        target.needsOcr
          ? `已读取扫描版 PDF：${target.pdfPageCount ?? '?'} 页。补目录后按小节实时 OCR。`
          : `已读取本地 PDF：${target.pdfPageCount ?? '?'} 页。`,
        target.needsOcr ? 'info' : 'success',
      );
    } catch (error) {
      setPageError(`读取本地 PDF 失败：${asErrorMessage(error)}`);
      setSideTab('record');
    } finally {
      setPdfFileLoading(false);
    }
  };

  const summarizePdfSection = async (section: OutlineNode) => {
    const current = recordRef.current;
    if (!current) {
      showNotice('请先“仅保存原文”，再逐节总结。', 'info');
      return;
    }
    if (current.page.sourceType !== 'pdf') return;
    if (!hasApiKey) {
      showNotice('请先在设置页配置模型 API Key。', 'error');
      return;
    }
    let summaryPage = current.page;
    let summarySection = section;
    if (!section.text.trim() && summaryPage.needsOcr) {
      const recognized = await ensurePdfSectionOcr(summaryPage, section);
      if (!recognized) return;
      summaryPage = recognized.page;
      summarySection = recognized.section;
    }
    if (!summarySection.text.trim()) {
      showNotice('这一节没有可总结的文字。', 'info');
      return;
    }
    setSectionSummaryId(summarySection.id);
    try {
      const request: SectionSummaryRequest = {
        page: summaryPage,
        section: summarySection,
        language: settings?.outputLanguage ?? '中文',
        model: provider?.model ?? '',
      };
      const response = await sendRuntimeMessage<SectionSummaryResponse>({
        type: 'PS_SUMMARIZE_SECTION',
        request,
      });
      if (!response.ok || !response.section) {
        throw new Error(response.error ?? '生成小节笔记失败');
      }
      if (recordRef.current?.id !== current.id) return;
      const latest = recordRef.current;
      if (!latest) return;
      const existing = latest.summary;
      const sections = [...(existing?.sections ?? [])];
      const index = sections.findIndex(
        (item) => item.outlineId === response.section?.outlineId,
      );
      if (index >= 0) sections[index] = response.section;
      else sections.push(response.section);
      const summarizedCount = sections.filter((item) => item.summary.trim()).length;
      const nextSummary: PageSummary = {
        overview: `PDF 分节笔记：已总结 ${summarizedCount} 节。`,
        thesis: existing?.thesis || '按小节整理 PDF 笔记，未生成全文总览。',
        quickRead: uniqueStrings(sections.flatMap((item) => item.keyPoints)).slice(0, 6),
        tags: existing?.tags ?? [],
        sections,
        keyConcepts: existing?.keyConcepts ?? [],
        argumentMap: existing?.argumentMap ?? [],
        dialogueInsights: existing?.dialogueInsights ?? [],
        generatedAt: Date.now(),
        model: provider?.model ?? existing?.model ?? '',
      };
      const nextRecord: StudyRecord = {
        ...latest,
        summary: nextSummary,
        status: 'ready',
        error: null,
        updatedAt: Date.now(),
      };
      await persistRecord(nextRecord);
      void queueAutoSync(nextRecord);
      void queueWikiAutoSync();
      showNotice(`已生成《${summarySection.title}》的小节笔记。`, 'success');
    } catch (error) {
      showNotice(asErrorMessage(error), 'error');
    } finally {
      setSectionSummaryId(null);
    }
  };

  const openDistill = (turn: DiscussionTurn) => {
    const current = recordRef.current;
    if (!current) return;
    if (!current.summary) {
      showNotice(
        current.page.sourceType === 'pdf'
          ? '先总结至少一个小节，再把讨论收进本节。'
          : '先生成全文总览，再把讨论收进本节。',
        'info',
      );
      return;
    }
    const match = findTurnSection(turn.user, current.page.outline);
    const fallback = flattenOutline(current.page.outline)[0];
    setDistillDraft({
      userMessageId: turn.user.id,
      assistantMessageId: turn.assistant.id,
      sectionId: match?.id ?? fallback?.id ?? '',
      question: '',
      insight: '',
      evidence: '',
      concepts: '',
      loading: false,
      ready: false,
      error: '',
      skipMessage: '',
    });
  };

  const runDistill = async () => {
    const draft = distillDraft;
    const current = recordRef.current;
    if (!draft || !current) return;
    const user = current.messages.find((message) => message.id === draft.userMessageId);
    const assistant = current.messages.find((message) => message.id === draft.assistantMessageId);
    if (!user || !assistant) {
      setDistillDraft(null);
      showNotice('这轮对话已不存在，请重新提问后再整理。', 'error');
      return;
    }
    const section = distillSections.find((item) => item.id === draft.sectionId) ?? distillSections[0];
    const existingSection = current.summary?.sections.find((item) => item.outlineId === section.id);
    const request: DistillRequest = {
      page: current.page,
      section: {
        outlineId: section.id,
        title: section.title,
        anchor: section.anchor,
        summary: existingSection?.summary ?? '',
        keyPoints: existingSection?.keyPoints ?? [],
        questions: existingSection?.questions ?? [],
      },
      messages: [
        { role: 'user', content: user.content },
        { role: 'assistant', content: assistant.content },
      ],
      selection:
        current.selections.find((item) => item.anchor === user.anchor) ??
        (selection && selection.anchor === user.anchor ? selection : null),
      language: settings?.outputLanguage ?? '中文',
    };
    setDistillDraft((previous) =>
      previous
        ? { ...previous, loading: true, ready: false, error: '', skipMessage: '' }
        : previous,
    );
    try {
      const response = await sendRuntimeMessage<DistillResponse>({
        type: 'PS_DISTILL_DISCUSSION',
        request,
      });
      if (!response.ok) throw new Error(response.error ?? '讨论精炼失败');
      if (response.skip || !response.insight) {
        setDistillDraft((previous) =>
          previous
            ? {
                ...previous,
                loading: false,
                ready: true,
                question: previous.question || truncate(user.content, 160),
                insight: '',
                skipMessage: response.reason ?? '这轮讨论没有检测到需要新增的结论。',
              }
            : previous,
        );
        return;
      }
      setDistillDraft((previous) =>
        previous
          ? {
              ...previous,
              loading: false,
              ready: true,
              question: response.insight?.question ?? '',
              insight: response.insight?.insight ?? '',
              evidence: response.insight?.evidence.join('；') ?? '',
              concepts: response.insight?.concepts.join('、') ?? '',
              skipMessage: '',
            }
          : previous,
      );
    } catch (error) {
      setDistillDraft((previous) =>
        previous ? { ...previous, loading: false, error: asErrorMessage(error) } : previous,
      );
    }
  };

  const restoreMerge = async (undo: MergeUndo) => {
    const current = recordRef.current;
    if (!current || current.id !== undo.recordId) return;
    const next: StudyRecord = {
      ...current,
      summary: undo.summary,
      distilledMessageIds: undo.distilledMessageIds,
      updatedAt: Date.now(),
    };
    await persistRecord(next);
    void queueAutoSync(next);
    void queueWikiAutoSync();
    showNotice('已撤销本次并入。', 'info');
  };

  const mergeDistill = async () => {
    const draft = distillDraft;
    const current = recordRef.current;
    if (!draft || !current?.summary) return;
    if (!draft.question.trim() || !draft.insight.trim()) {
      showNotice('先补全问题和结论，再并入本节。', 'info');
      return;
    }
    const section = distillSections.find((item) => item.id === draft.sectionId) ?? distillSections[0];
    const insight: DialogueInsight = {
      question: draft.question.trim(),
      insight: draft.insight.trim(),
      evidence: splitList(draft.evidence, /[；;\n]/),
      concepts: splitList(draft.concepts, /[，,、；;\n]/),
      outlineId: section.id || undefined,
      sectionTitle: section.id ? section.title : undefined,
      sourceMessageIds: [draft.userMessageId, draft.assistantMessageId],
    };
    const existing = current.summary.dialogueInsights ?? [];
    const duplicate = existing.some(
      (item) => item.question === insight.question && item.insight === insight.insight,
    );
    const nextSummary = duplicate
      ? current.summary
      : { ...current.summary, dialogueInsights: [...existing, insight] };
    const next: StudyRecord = {
      ...current,
      summary: nextSummary,
      distilledMessageIds: uniqueStrings([
        ...(current.distilledMessageIds ?? []),
        draft.userMessageId,
        draft.assistantMessageId,
      ]),
      status: 'ready',
      updatedAt: Date.now(),
    };
    const undo: MergeUndo = {
      recordId: current.id,
      summary: current.summary,
      distilledMessageIds: [...(current.distilledMessageIds ?? [])],
    };
    setDistillDraft(null);
    await persistRecord(next);
    void queueAutoSync(next);
    void queueWikiAutoSync();
    if (duplicate) {
      showNotice('这条结论已存在，本轮已标记整理。', 'success');
      return;
    }
    showNotice('已并入本节笔记。', 'success', {
      label: '撤销',
      onClick: () => void restoreMerge(undo),
    });
  };

  const updateSectionNotes = () => {
    const current = recordRef.current;
    if (!current) return;
    if (!current.summary) {
      showNotice(
        current.page.sourceType === 'pdf'
          ? '先总结至少一个小节，再更新本节笔记。'
          : '先生成全文总览，再更新本节笔记。',
        'info',
      );
      return;
    }
    const pending = findPendingTurn(current);
    if (!pending) {
      showNotice('没有待整理的讨论。先在对话里提问，再点回答下方的“收进本节”。', 'info');
      return;
    }
    openDistill(pending);
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
    if (!anchor) return;
    const targetPage = recordRef.current?.page ?? page;
    if (targetPage?.sourceType === 'pdf') {
      const section = flattenOutline(targetPage.outline).find((node) => node.anchor === anchor);
      if (section) {
        setPdfSectionId(section.id);
        setSideTab('chat');
      }
      return;
    }
    if (tabId === null) return;
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
        ocr: Boolean(response.ocr),
        ocrEngine: response.ocrEngine,
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
      const warning = response.warnings?.length
        ? `；${response.warnings.slice(0, 2).join('；')}`
        : '';
      showNotice(
        `${mode === 'append' ? '已追加到' : '已写入'}${DOCUMENT_TARGET_SHORT_LABELS[target]}${warning}`,
        warning ? 'info' : 'success',
      );
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
  const activePage = record?.page ?? page;
  const outline = activePage?.outline ?? [];
  const summary = record?.summary ?? null;
  const isPdf = activePage?.sourceType === 'pdf';
  const pdfNeedsOutline = isPdf && outline.length === 0;
  const manualLocalPdf = manualMode && pdfFallback;
  const readingMinutes = activePage ? Math.max(1, Math.round(activePage.wordCount / 450)) : 0;
  const flatOutline = useMemo(() => flattenOutline(outline), [outline]);
  const pdfFocusSection = useMemo(
    () =>
      isPdf
        ? flatOutline.find((node) => node.id === pdfSectionId) ??
          flatOutline.find((node) => Boolean(node.text.trim())) ??
          flatOutline[0] ??
          null
        : null,
    [flatOutline, isPdf, pdfSectionId],
  );
  const distillSections = useMemo(
    () =>
      flatOutline.length > 0
        ? flatOutline.map((node) => ({ id: node.id, title: node.title, anchor: node.anchor, level: node.level }))
        : [{ id: '', title: '整篇笔记', anchor: '', level: 1 }],
    [flatOutline],
  );
  const distillTurn = distillDraft
    ? {
        user: messages.find((message) => message.id === distillDraft.userMessageId),
        assistant: messages.find((message) => message.id === distillDraft.assistantMessageId),
      }
    : null;

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
            <span>正在读取页面或 PDF 大纲…</span>
          </div>
        ) : activePage ? (
          <>
            <div className="page-card-kicker">
              {activePage.manual
                ? '手动摘录'
                : isPdf
                  ? `PDF · ${activePage.pdfPageCount ?? '?'} 页`
                  : safeHostname(activePage.url)}
              {activePage.author ? ` · ${activePage.author}` : ''}
              {activePage.publishedAt ? ` · ${activePage.publishedAt.slice(0, 10)}` : ''}
            </div>
            <h1 className="page-title" title={activePage.title}>
              {activePage.title}
            </h1>
            <div className="page-meta">
              <span>{flattenOutline(outline).length} {isPdf ? '个小节' : '个标题'}</span>
              {activePage.needsOcr ? (
                <span>扫描版 · 按节 OCR</span>
              ) : (
                <>
                  <span>{activePage.wordCount.toLocaleString()} 字</span>
                  <span>约 {readingMinutes} 分钟</span>
                </>
              )}
              {isPdf ? <span>只按小节发送</span> : null}
              {activePage.manual ? <span>手动摘录</span> : null}
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
              {isPdf ? (
                <select
                  className="context-mode-select pdf-section-select"
                  aria-label="PDF 当前小节"
                  value={pdfFocusSection?.id ?? ''}
                  onChange={(event) => setPdfSectionId(event.target.value)}
                  disabled={streaming || flatOutline.length === 0}
                >
                  {flatOutline.length === 0 ? <option value="">先补 PDF 目录</option> : null}
                  {flatOutline.map((node) => (
                    <option key={node.id} value={node.id}>
                      {`${'　'.repeat(Math.max(0, node.level - 1))}${node.title}${node.page ? ` · P${node.page}` : ''}`}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  className="context-mode-select"
                  aria-label="上下文范围"
                  value={contextMode}
                  onChange={(event) => changeContextMode(event.target.value as ContextMode)}
                  disabled={streaming}
                >
                  <option value="smart">智能全文</option>
                  <option value="full">始终全文</option>
                  <option value="selection">仅选段</option>
                  <option value="off">关闭</option>
                </select>
              )}
            </div>
            <div className="context-meta">
              {isPdf
                ? pdfFocusSection
                  ? activePage?.needsOcr && !pdfFocusSection.text.trim()
                    ? `PDF · ${activePage?.pdfPageCount ?? '?'} 页 · 扫描版，当前小节待 OCR，全文不会发送`
                    : `PDF · ${activePage?.pdfPageCount ?? '?'} 页 · 当前小节 ${pdfFocusSection.text.length.toLocaleString('zh-CN')} 字，全文不会发送`
                  : pdfNeedsOutline
                    ? 'PDF 已解析，等待补目录'
                    : 'PDF 没有可选小节'
                : contextReady
                  ? `已索引 ${indexedChars.toLocaleString('zh-CN')} 字${imageCount > 0 ? ` · ${imageCount} 张图` : ''}${
                      page?.tokenEstimate ? ` · 约 ${page.tokenEstimate.toLocaleString('zh-CN')} tokens` : ''
                    }`
                  : '尚未读取到正文'}
            </div>
            {isPdf ? (
              <p className="context-empty">
                {pdfNeedsOutline
                  ? '这个 PDF 没有书签目录；请到“记录”页按页码范围补目录，再选择小节提问。'
                  : activePage?.needsOcr
                    ? '扫描版 PDF 没有文字层；总结或提问时会实时 OCR 当前小节，只发送这一节。'
                    : '每次只发送当前小节；切换小节不会把其他小节带入。'}
              </p>
            ) : contextMode === 'off' ? (
              <p className="context-empty">网页正文不会发送；选中段落仍可作为聚焦。</p>
            ) : contextMode === 'selection' ? (
              <p className="context-empty">只发送当前聚焦段和页面简报，不发送全文。</p>
            ) : null}
            {!isPdf && contexts.length > 0 ? (
              <div className="context-chips">
                {contexts.map((item, index) => (
                  <span className="context-chip" key={`${item.anchor}-${index}`} title={item.text}>
                    <span>{truncate(item.text, 30)}</span>
                    <button type="button" onClick={() => removeSelection(index)} aria-label="移除固定上下文">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {isPdf ? (
              pdfFocusSection ? (
                <div className="selection-preview focus-preview">
                  <div>
                    <span className="selection-label">当前小节 · 只发送这一节</span>
                    <strong className="pdf-focus-title">{pdfFocusSection.title}</strong>
                    <p>
                      {pdfFocusSection.text.trim()
                        ? truncate(pdfFocusSection.text, 160)
                        : activePage?.needsOcr
                          ? `点击“OCR 并总结”或直接提问时，会实时识别第 ${pdfFocusSection.page ?? 1}–${pdfFocusSection.pageEnd ?? pdfFocusSection.page ?? 1} 页。`
                          : '这一节没有可用的正文。'}
                    </p>
                    <span className="selection-path">
                      {pdfFocusSection.page ? `第 ${pdfFocusSection.page} 页` : 'PDF'} ·{' '}
                      {pdfFocusSection.text.length.toLocaleString('zh-CN')} 字
                      {ocrLoading && ocrProgress ? ` · ${ocrProgress}` : ''}
                    </span>
                  </div>
                  <span className="focus-badge">本节</span>
                </div>
              ) : (
                <p className="context-empty">先补目录，或选择一个小节。</p>
              )
            ) : selection ? (
              <div className="selection-preview focus-preview">
                <div>
                  <span className="selection-label">当前聚焦 · 自动带入</span>
                  <p>{truncate(selection.text, 160)}</p>
                  {selection.headingPath.length > 0 ? (
                    <span className="selection-path">{selection.headingPath.join(' / ')}</span>
                  ) : null}
                </div>
                <span className="focus-badge">聚焦</span>
              </div>
            ) : (
              <p className="context-empty">直接提问即可；在网页中选中文字会自动聚焦。</p>
            )}
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
                <h2>{isPdf ? '一节一节读透 PDF' : '把文章变成自己的理解'}</h2>
                <p>
                  {isPdf
                    ? '先选择一个小节，再围绕这一节提问。每次只发送本节正文；记录后可以逐节点“总结本节”。'
                    : '直接提问即可。全文会在提问时按上下文范围自动带入；选中段落会自动聚焦，记录后生成知识卡。'}
                </p>
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
              messages.map((message, index) => {
                const previous = index > 0 ? messages[index - 1] : null;
                const turn =
                  previous?.role === 'user' && message.role === 'assistant'
                    ? { user: previous, assistant: message }
                    : null;
                const canDistill = Boolean(
                  turn && record && message.content.trim() && !message.error,
                );
                const distilled = turn ? turnIsDistilled(record, turn) : false;
                const section = turn ? findTurnSection(turn.user, outline) : null;
                return (
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
                      {canDistill && turn ? (
                        <div className="message-actions">
                          <button
                            type="button"
                            className="message-save-button"
                            disabled={distilled}
                            onClick={() => openDistill(turn)}
                          >
                            {distilled ? '已收进本节' : '收进本节'}
                          </button>
                          <span className="message-section">
                            {section ? `§ ${section.title}` : '整篇笔记'}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })
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
                  void sendChat();
                }
              }}
              placeholder={
                isPdf
                  ? activePage?.needsOcr
                    ? '扫描版：发送时会实时 OCR 当前小节…'
                    : pdfFocusSection
                      ? '只问当前小节；不会发送 PDF 全文…'
                      : '先补 PDF 目录，或选择一个小节…'
                  : '基于全文提问；选中文字会自动聚焦…'
              }
              rows={2}
              disabled={streaming || ocrLoading || (isPdf && flatOutline.length === 0)}
            />
            <div className="composer-actions">
              <span>Enter 发送 · Shift+Enter 换行</span>
              {streaming ? (
                <button type="button" className="send-button stop" onClick={stopChat}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="send-button"
                  onClick={() => void sendChat()}
                  disabled={
                    !input.trim() ||
                    ocrLoading ||
                    (isPdf && flatOutline.length === 0)
                  }
                >
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
              isPdf={isPdf}
              summaryLoading={summaryLoading}
              sectionSummaryId={sectionSummaryId}
              onSummarizeSection={(node) => void summarizePdfSection(node)}
              onApplyPdfOutline={applyPdfOutline}
              ocrProgress={ocrProgress}
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
              onUpdateSection={updateSectionNotes}
              onWriteDocument={writeDocument}
              onRefreshSync={refreshRecordSync}
              onCopyMarkdown={copyMarkdown}
              onDownloadMarkdown={downloadMarkdown}
              onDelete={deleteCurrentRecord}
              onNotesChange={(notes) => patchRecord({ notes })}
              onAddTag={addTag}
              onRemoveTag={removeTag}
              onToggleImage={toggleImage}
              onOpenDashboard={() => openDashboard()}
              onOpenWiki={openWiki}
              onOpenOptions={openOptions}
            />
          ) : (
            <div className="record-empty">
              <div className="record-empty-icon">▤</div>
              <h2>
                {manualLocalPdf
                  ? '读取本地 PDF'
                  : manualMode
                    ? '手动摘录浏览器内置页'
                    : pdfNeedsOutline
                      ? 'PDF 缺少书签目录'
                      : isPdf
                        ? '保存 PDF，按小节精读'
                        : '记录本页，生成知识卡'}
              </h2>
              <p>
                {manualLocalPdf
                  ? '浏览器默认不允许扩展直接读取本地文件。请选择你刚才打开的 PDF；文件只在扩展内解析，不会上传，也不会改变原文件。'
                  : manualMode
                    ? '浏览器内置页面不能被扩展自动读取。把标题、地址和要学习的段落粘贴到下面，PageStudy 仍会保存记录、生成知识卡并归入 Wiki。'
                    : pdfNeedsOutline
                      ? activePage?.needsOcr
                        ? '这是扫描版 PDF，没有文字层，也没有可读取的书签目录。请补一份小节页码范围；之后总结或提问时只 OCR 当前小节，不会上传整本文件。'
                        : '扩展已经解析出 PDF 文字层，但这个文件没有可读取的书签目录。请补一份小节页码范围，之后每次只聚焦一个小节。'
                      : isPdf
                        ? '先保存 PDF 文字快照；之后在记录页逐个点击“总结本节”，每次只发送一个小节，不发送整份 PDF。'
                        : '点击“记录本页”会读取全文和图片，一次生成速读、核心论证、概念卡、章节笔记和问答沉淀。网页以后变化，记录仍保留当时的快照。'}
              </p>
              {manualLocalPdf ? (
                <PdfFilePicker
                  busy={pdfFileLoading}
                  onFile={(file) => void loadLocalPdf(file)}
                />
              ) : manualMode ? (
                <ManualCaptureFields
                  title={manualTitle}
                  url={manualUrl}
                  text={manualText}
                  onTitleChange={setManualTitle}
                  onUrlChange={setManualUrl}
                  onTextChange={setManualText}
                />
              ) : pdfNeedsOutline ? (
                <PdfOutlineEditor
                  pageCount={activePage?.pdfPageCount ?? 0}
                  needsOcr={Boolean(activePage?.needsOcr)}
                  onApply={applyPdfOutline}
                />
              ) : outline.length > 0 ? (
                <div className="outline-preview">
                  <div className="section-heading">
                    <span>{isPdf ? 'PDF 小节' : '网页大纲'}</span>
                    <span>{outline.length} 节</span>
                  </div>
                  <OutlineTree nodes={outline.slice(0, 4)} summary={null} onJump={jumpToAnchor} />
                  {outline.length > 4 ? <p className="muted">还有更多章节，记录后完整查看。</p> : null}
                </div>
              ) : null}
              {!pdfNeedsOutline && !manualLocalPdf ? (
                <div className="record-actions">
                  {isPdf ? (
                    <button
                      type="button"
                      className="primary-button"
                      onClick={() => void recordPage(false)}
                    >
                      保存 PDF 原文
                    </button>
                  ) : (
                    <button type="button" className="primary-button" onClick={() => void recordPage(true)}>
                      {manualMode ? '记录摘录并生成知识卡' : '记录本页'}
                    </button>
                  )}
                  {!isPdf ? (
                    <button type="button" className="secondary-button" onClick={() => void recordPage(false)}>
                      仅保存原文
                    </button>
                  ) : null}
                </div>
              ) : null}
              {!hasApiKey && !pdfNeedsOutline && !manualLocalPdf ? (
                <p className="muted">
                  {isPdf
                    ? '保存 PDF 不需要模型；逐节总结前请配置 API Key。'
                    : '配置 API Key 后会自动生成知识卡；“仅保存原文”不需要模型。'}
                </p>
              ) : null}
            </div>
          )}
        </main>
      )}

      {distillDraft ? (
        <div className="modal-backdrop" role="presentation">
          <section
            className="distill-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="收进本节笔记"
          >
            <div className="distill-dialog-head">
              <div>
                <strong>收进本节笔记</strong>
                <p>只提炼这一轮讨论，不会重新生成全文知识卡。</p>
              </div>
              <button
                type="button"
                className="dialog-close"
                onClick={() => setDistillDraft(null)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>

            <label className="distill-field">
              <span>归属章节</span>
              <select
                value={distillDraft.sectionId}
                onChange={(event) =>
                  setDistillDraft((previous) =>
                    previous ? { ...previous, sectionId: event.target.value } : previous,
                  )
                }
                disabled={distillDraft.loading}
              >
                {distillSections.map((section) => (
                  <option key={section.id || 'whole'} value={section.id}>
                    {section.level > 1 ? `${'　'.repeat(Math.min(3, section.level - 1))}` : ''}
                    {section.title}
                  </option>
                ))}
              </select>
            </label>

            {distillTurn?.user ? (
              <details className="distill-source">
                <summary>查看本轮讨论</summary>
                <p>
                  <strong>你：</strong>
                  {truncate(distillTurn.user.content, 500)}
                </p>
                {distillTurn.assistant ? (
                  <p>
                    <strong>助教：</strong>
                    {truncate(distillTurn.assistant.content, 800)}
                  </p>
                ) : null}
              </details>
            ) : null}

            {distillDraft.error ? <div className="error-box">{distillDraft.error}</div> : null}
            {distillDraft.skipMessage ? (
              <p className="distill-skip">{distillDraft.skipMessage}</p>
            ) : null}

            {distillDraft.loading ? (
              <div className="distill-loading">
                <span className="spinner" />
                <span>正在提炼这一轮讨论…</span>
              </div>
            ) : null}

            {distillDraft.ready ? (
              <div className="distill-fields">
                <label className="distill-field">
                  <span>问题</span>
                  <input
                    value={distillDraft.question}
                    onChange={(event) =>
                      setDistillDraft((previous) =>
                        previous ? { ...previous, question: event.target.value } : previous,
                      )
                    }
                    placeholder="这轮讨论真正想解决的问题"
                  />
                </label>
                <label className="distill-field">
                  <span>结论</span>
                  <textarea
                    value={distillDraft.insight}
                    onChange={(event) =>
                      setDistillDraft((previous) =>
                        previous ? { ...previous, insight: event.target.value } : previous,
                      )
                    }
                    placeholder="讨论后得到的新理解、纠正或判断"
                    rows={4}
                  />
                </label>
                <label className="distill-field">
                  <span>依据</span>
                  <input
                    value={distillDraft.evidence}
                    onChange={(event) =>
                      setDistillDraft((previous) =>
                        previous ? { ...previous, evidence: event.target.value } : previous,
                      )
                    }
                    placeholder="[§锚点] 或 对话补充，用分号分隔"
                  />
                </label>
                <label className="distill-field">
                  <span>概念</span>
                  <input
                    value={distillDraft.concepts}
                    onChange={(event) =>
                      setDistillDraft((previous) =>
                        previous ? { ...previous, concepts: event.target.value } : previous,
                      )
                    }
                    placeholder="相关概念，用顿号或逗号分隔"
                  />
                </label>
              </div>
            ) : null}

            <div className="distill-actions">
              {distillDraft.ready ? (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void mergeDistill()}
                    disabled={!distillDraft.question.trim() || !distillDraft.insight.trim()}
                  >
                    并入本节笔记
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void runDistill()}
                    disabled={distillDraft.loading}
                  >
                    重新提炼
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void runDistill()}
                  disabled={distillDraft.loading}
                >
                  {distillDraft.loading ? '提炼中…' : '提炼这一轮'}
                </button>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() => setDistillDraft(null)}
              >
                取消
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {notice ? (
        <div className={`notice notice-${notice.kind}`}>
          <span>{notice.text}</span>
          {notice.action ? (
            <button
              type="button"
              className="notice-action"
              onClick={() => {
                notice.action?.onClick();
                setNotice(null);
              }}
            >
              {notice.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface RecordViewProps {
  record: StudyRecord;
  summary: PageSummary | null;
  outline: PageContext['outline'];
  isPdf: boolean;
  summaryLoading: boolean;
  sectionSummaryId: string | null;
  onSummarizeSection: (node: OutlineNode) => void;
  onApplyPdfOutline: (entries: PdfManualSection[]) => void;
  ocrProgress?: string;
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
  onUpdateSection: () => void;
  onWriteDocument: (target: DocumentTarget, mode: DocumentWriteMode) => void;
  onRefreshSync: () => void;
  onCopyMarkdown: () => void;
  onDownloadMarkdown: () => void;
  onDelete: () => void;
  onNotesChange: (notes: string) => void;
  onAddTag: () => void;
  onRemoveTag: (tag: string) => void;
  onToggleImage: (imageId: string) => void;
  onOpenDashboard: () => void;
  onOpenWiki: () => void;
  onOpenOptions: () => void;
}

function RecordView({
  record,
  summary,
  outline,
  isPdf,
  summaryLoading,
  sectionSummaryId,
  onSummarizeSection,
  onApplyPdfOutline,
  ocrProgress = '',
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
  onUpdateSection,
  onWriteDocument,
  onRefreshSync,
  onCopyMarkdown,
  onDownloadMarkdown,
  onDelete,
  onNotesChange,
  onAddTag,
  onRemoveTag,
  onToggleImage,
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
      ? '已生成知识卡'
      : record.status === 'error'
        ? '知识卡生成失败'
        : '已保存原文';
  const pageImages = record.page.images ?? [];
  const selectedImages = new Set(
    record.selectedImageIds ?? pageImages.map((image) => image.id),
  );
  const outlineIds = new Set(flattenOutline(outline).map((node) => node.id));
  const visibleDialogueInsights = (summary?.dialogueInsights ?? []).filter(
    (insight) => !insight.outlineId || !outlineIds.has(insight.outlineId),
  );
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

      {isPdf && outline.length === 0 ? (
        <PdfOutlineEditor
          key={record.page.contentHash}
          pageCount={record.page.pdfPageCount ?? 0}
          onApply={onApplyPdfOutline}
        />
      ) : null}

      <div className="record-actions">
        {isPdf ? (
          <span className="pdf-summary-hint" title="PDF 只按小节总结，不发送整份全文">
            PDF 按小节总结
          </span>
        ) : (
          <button
            type="button"
            className="primary-button"
            onClick={onResummarize}
            disabled={summaryLoading}
            title="重新读取全文，生成整份知识卡"
          >
            {summaryLoading ? '生成中…' : summary ? '重新生成全文总览' : '生成全文总览'}
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          onClick={onUpdateSection}
          disabled={summaryLoading || !summary}
          title={
            isPdf
              ? '把最近一轮讨论收进对应 PDF 小节'
              : '把最近一轮还没整理的讨论收进对应章节'
          }
        >
          更新本节笔记
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

      {isPdf && outline.length > 0 ? (
        <section className="record-section">
          <div className="section-heading">
            <span>PDF 分节笔记</span>
            <span>
              {(summary?.sections ?? []).filter((section) => section.summary.trim()).length}/{outline.length} 节
            </span>
          </div>
          <p className="muted">
            每次只把一个小节发给模型；点小节右侧的“总结本节”，不会重新上传整份 PDF。
          </p>
          {ocrProgress ? <p className="pdf-ocr-progress">{ocrProgress}</p> : null}
          <OutlineTree
            nodes={outline}
            summary={summary}
            onJump={onJump}
            onSummarizeSection={onSummarizeSection}
            summarizingId={sectionSummaryId}
          />
        </section>
      ) : null}

      {!isPdf && summary ? (
        <>
          <section className="record-section">
            <div className="section-heading">
              <span>30 秒速读</span>
              <span>{summary.model}</span>
            </div>
            <p className="summary-overview">{summary.thesis || summary.overview}</p>
            {summary.quickRead && summary.quickRead.length > 0 ? (
              <ul className="quick-read">
                {summary.quickRead.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            ) : null}
            {summary.tags.length > 0 ? (
              <div className="tag-row">
                {summary.tags.map((tag) => (
                  <span className="tag" key={tag}>
                    #{tag}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {summary.argumentMap && summary.argumentMap.length > 0 ? (
            <section className="record-section">
              <div className="section-heading">
                <span>核心论证</span>
                <span>主张 · 证据 · 边界</span>
              </div>
              <div className="argument-list">
                {summary.argumentMap.map((argument, index) => (
                  <div className="argument-item" key={`${argument.claim}-${index}`}>
                    <strong>
                      {index + 1}. {argument.claim}
                    </strong>
                    {argument.evidence ? <p><span>证据</span>{argument.evidence}</p> : null}
                    {argument.assumptions ? <p><span>假设</span>{argument.assumptions}</p> : null}
                    {argument.boundary ? <p><span>边界</span>{argument.boundary}</p> : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {summary.keyConcepts.length > 0 ? (
            <section className="record-section">
              <div className="section-heading">
                <span>概念卡</span>
                <span>{summary.keyConcepts.length} 个</span>
              </div>
              <div className="concept-list">
                {summary.keyConcepts.map((concept) => (
                  <div className="concept-item" key={concept.term}>
                    <strong>{concept.term}</strong>
                    <span>{concept.explanation}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : !isPdf ? (
        <section className="record-section">
          <div className="section-heading">
            <span>知识卡</span>
          </div>
          <p className="muted">
            {record.status === 'error'
              ? '知识卡生成失败，可以修改模型配置后重试。'
              : '原文快照已经保存；点击上方“生成全文总览”即可整理全文、概念与对话。'}
          </p>
        </section>
      ) : null}

      {!isPdf ? (
        <section className="record-section">
          <div className="section-heading">
            <span>章节笔记</span>
            <span>{outline.length} 个顶层章节</span>
          </div>
          <OutlineTree nodes={outline} summary={summary} onJump={onJump} />
        </section>
      ) : null}

      {pageImages.length > 0 ? (
        <section className="record-section">
          <div className="section-heading">
            <span>图表与图片</span>
            <span>
              保留 {selectedImages.size}/{pageImages.length}
            </span>
          </div>
          <div className="image-grid">
            {pageImages.map((image) => (
              <label className="image-card" key={image.id}>
                <img src={image.src} alt={image.alt || image.caption} loading="lazy" />
                <span className="image-caption">{image.caption || image.alt || '正文图片'}</span>
                <span className="image-meta">
                  {image.headingPath.length > 0 ? image.headingPath.join(' / ') : '页面开头'}
                </span>
                <input
                  type="checkbox"
                  checked={selectedImages.has(image.id)}
                  onChange={() => onToggleImage(image.id)}
                  aria-label={`保留图片：${image.caption || image.alt || image.id}`}
                />
              </label>
            ))}
          </div>
          <p className="muted">当前保留图片原链接和图注；导出文档时不下载图片本体。</p>
        </section>
      ) : null}

      {visibleDialogueInsights.length > 0 ? (
        <section className="record-section">
          <div className="section-heading">
            <span>问答沉淀</span>
            <span>{visibleDialogueInsights.length} 条</span>
          </div>
          <div className="insight-list">
            {visibleDialogueInsights.map((insight, index) => (
              <div className="insight-item" key={`${insight.question}-${index}`}>
                <strong>{insight.question}</strong>
                <p>{insight.insight}</p>
                {insight.evidence.length > 0 ? (
                  <span>依据：{insight.evidence.join('；')}</span>
                ) : null}
                {insight.concepts.length > 0 ? (
                  <span>概念：{insight.concepts.join('、')}</span>
                ) : null}
              </div>
            ))}
          </div>
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
          <span>我的判断</span>
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
              } · 本地 Markdown ${bridgeHealth.markdown ? '就绪' : '未配置'} · 扫描版 OCR ${
                bridgeHealth.ocr ? '就绪' : '不可用'
              }`
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
        手动摘录不会伪装成自动读取；记录会标记为“手动摘录”，并照常进入知识卡、文档同步和本地 Wiki。
      </p>
    </div>
  );
}
