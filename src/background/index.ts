import { APP_VERSION } from '../shared/constants';
import type {
  BridgeHealthResponse,
  ChatPortEvent,
  ChatPortRequest,
  DocumentWriteResponse,
  FeishuWriteResponse,
  ModelsResponse,
  RecordResponse,
  RuntimeMessage,
  SummarizeResponse,
  SyncEnqueueResponse,
  TestProviderResponse,
  WikiPublishMessageResponse,
  WikiStateResponse,
} from '../shared/messages';
import {
  getActiveProvider,
  loadSettings,
  normalizeSettings,
  saveSettings,
  toPublicSettings,
} from '../shared/settings';
import { buildChatSystemPrompt, getAllSkills, getSkillById } from '../shared/skills';
import { asErrorMessage } from '../shared/utils';
import { fetchModels, requestChat, testProvider } from './providers';
import { generateSummary } from './summary';
import { checkBridge } from './bridge';
import { appendDocument, writeDocument } from './documents';
import {
  autoSyncStatus,
  enqueueRecordSync,
  flushSyncQueue,
  removeRecordSyncJob,
} from './sync';
import {
  clearWikiQueue,
  flushWikiQueue,
  getWikiPublishState,
  publishWikiNow,
  requestWikiPublish,
  wikiQueueStatus,
} from './wiki-sync';
import { getRecord } from '../shared/db';
import { isDocumentTarget } from '../shared/documents';

// API Key 只允许扩展页面（侧栏、设置、记录库）读取，内容脚本不应接触。
if (chrome.storage.local.setAccessLevel) {
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {
    // 个别 Chromium 发行版可能不支持；失败时不影响扩展主要功能。
  });
}

async function setupSidePanel(): Promise<void> {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // Edge 或旧版本可能不支持该行为，保留 action 点击兜底。
  }
}

async function setupContextMenu(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
      id: 'pagestudy-ask',
      title: '用 PageStudy 提问',
      contexts: ['selection'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: 'pagestudy-record',
      title: '打开 PageStudy，记录本页',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
  } catch (error) {
    console.warn('PageStudy context menu setup failed', error);
  }
}

async function openPanel(tabId?: number): Promise<boolean> {
  if (!tabId) return false;
  try {
    await chrome.sidePanel.open({ tabId });
    return true;
  } catch {
    return false;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void setupSidePanel();
  void setupContextMenu();
  void flushSyncQueue();
  void flushWikiQueue();
});

chrome.runtime.onStartup.addListener(() => {
  void setupSidePanel();
  // MV3 的 service worker 不能保证在浏览器关闭时完成网络请求；启动时补传上次待同步队列。
  void flushSyncQueue();
  void flushWikiQueue();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pagestudy-sync') void flushSyncQueue();
  if (alarm.name === 'pagestudy-wiki-sync') void flushWikiQueue();
});

if (chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    // 浏览器关闭/worker 挂起前的 best-effort 冲刷；真正的可靠性来自保存后立即同步和启动补传。
    void flushSyncQueue(true);
    void flushWikiQueue(true);
  });
}

if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    void openPanel(tab.id);
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId !== 'pagestudy-ask' && info.menuItemId !== 'pagestudy-record') return;
  void openPanel(tab.id);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  void (async () => {
    try {
      switch (message.type) {
        case 'PS_PING': {
          sendResponse({ ok: true, version: APP_VERSION });
          return;
        }
        case 'PS_GET_SETTINGS': {
          const settings = await loadSettings();
          sendResponse({ ok: true, settings });
          return;
        }
        case 'PS_GET_PUBLIC_SETTINGS': {
          const settings = await loadSettings();
          sendResponse({ ok: true, settings: toPublicSettings(settings) });
          return;
        }
        case 'PS_SAVE_SETTINGS': {
          const settings = normalizeSettings(message.settings);
          await saveSettings(settings);
          if (!settings.documents.wikiAutoSync) await clearWikiQueue();
          sendResponse({ ok: true, settings });
          return;
        }
        case 'PS_SAVE_CONTEXT_SETTINGS': {
          const settings = await loadSettings();
          const next = normalizeSettings({ ...settings, context: message.context });
          await saveSettings(next);
          sendResponse({ ok: true, context: next.context });
          return;
        }
        case 'PS_FETCH_MODELS': {
          const settings = await loadSettings();
          const response: ModelsResponse = { ok: true, models: [] };
          try {
            response.models = await fetchModels(getActiveProvider(settings));
          } catch (error) {
            response.ok = false;
            response.error = asErrorMessage(error);
          }
          sendResponse(response);
          return;
        }
        case 'PS_TEST_PROVIDER': {
          const settings = await loadSettings();
          const response: TestProviderResponse = { ok: true };
          try {
            response.message = await testProvider(getActiveProvider(settings));
          } catch (error) {
            response.ok = false;
            response.error = asErrorMessage(error);
          }
          sendResponse(response);
          return;
        }
        case 'PS_SUMMARIZE': {
          const settings = await loadSettings();
          const response: SummarizeResponse = { ok: true };
          try {
            response.summary = await generateSummary(message.request, getActiveProvider(settings));
          } catch (error) {
            response.ok = false;
            response.error = asErrorMessage(error);
          }
          sendResponse(response);
          return;
        }
        case 'PS_BRIDGE_HEALTH': {
          const settings = await loadSettings();
          const health: BridgeHealthResponse = await checkBridge(settings.feishu);
          const queue = await autoSyncStatus();
          const wikiQueue = await wikiQueueStatus();
          sendResponse({
            ...health,
            syncPending: queue.pending,
            syncError: queue.error,
            wikiPending: wikiQueue.pending,
            wikiError: wikiQueue.error,
          });
          return;
        }
        case 'PS_WRITE_DOCUMENT': {
          if (!isDocumentTarget(message.target)) {
            sendResponse({ ok: false, target: message.target, error: '不支持的文档目标。' });
            return;
          }
          const settings = await loadSettings();
          const response: DocumentWriteResponse = await writeDocument(
            { bridge: settings.feishu, documents: settings.documents },
            {
              target: message.target,
              title: message.title,
              markdown: message.markdown,
              xml: message.xml,
            },
          );
          if (message.recordId) {
            try {
              await removeRecordSyncJob(message.recordId, message.target);
            } catch {
              // 文档已经写入成功；队列清理失败不应把成功结果改成失败。
            }
          }
          sendResponse(response);
          return;
        }
        case 'PS_APPEND_DOCUMENT': {
          if (!isDocumentTarget(message.target)) {
            sendResponse({ ok: false, target: message.target, error: '不支持的文档目标。' });
            return;
          }
          const settings = await loadSettings();
          const response: DocumentWriteResponse = await appendDocument(
            { bridge: settings.feishu, documents: settings.documents },
            {
              target: message.target,
              documentId: message.documentId,
              markdown: message.markdown,
              xml: message.xml,
            },
          );
          if (message.recordId) {
            try {
              await removeRecordSyncJob(message.recordId, message.target);
            } catch {
              // 文档已经写入成功；队列清理失败不应把成功结果改成失败。
            }
          }
          sendResponse(response);
          return;
        }
        case 'PS_WRITE_FEISHU': {
          const settings = await loadSettings();
          const response = await writeDocument(
            { bridge: settings.feishu, documents: settings.documents },
            { target: 'feishu', title: message.title, markdown: message.markdown, xml: message.xml },
          );
          const legacy: FeishuWriteResponse = {
            ok: response.ok,
            documentId: response.documentId,
            url: response.url,
            error: response.error,
          };
          sendResponse(legacy);
          return;
        }
        case 'PS_APPEND_FEISHU': {
          const settings = await loadSettings();
          const response = await appendDocument(
            { bridge: settings.feishu, documents: settings.documents },
            { target: 'feishu', documentId: message.documentId, markdown: message.markdown, xml: message.xml },
          );
          const legacy: FeishuWriteResponse = {
            ok: response.ok,
            documentId: response.documentId,
            url: response.url,
            error: response.error,
          };
          sendResponse(legacy);
          return;
        }
        case 'PS_ENQUEUE_SYNC': {
          if (message.target !== undefined && !isDocumentTarget(message.target)) {
            sendResponse({ ok: false, error: '不支持的文档目标。' });
            return;
          }
          const response: SyncEnqueueResponse = await enqueueRecordSync(
            message.recordId,
            message.target,
          );
          sendResponse(response);
          return;
        }
        case 'PS_FLUSH_SYNC': {
          const synced = await flushSyncQueue(true);
          const wikiSynced = await flushWikiQueue(true);
          const queue = await autoSyncStatus();
          const wikiQueue = await wikiQueueStatus();
          sendResponse({
            ok: true,
            synced,
            wikiSynced,
            ...queue,
            wikiPending: wikiQueue.pending,
            wikiError: wikiQueue.error,
          });
          return;
        }
        case 'PS_PUBLISH_WIKI': {
          const result: WikiPublishMessageResponse = await publishWikiNow();
          if (result.ok) await clearWikiQueue();
          sendResponse(result);
          return;
        }
        case 'PS_REQUEST_WIKI_PUBLISH': {
          const response = await requestWikiPublish();
          sendResponse(response);
          return;
        }
        case 'PS_GET_WIKI_STATE': {
          const state = await getWikiPublishState();
          const response: WikiStateResponse = { ok: true, state };
          sendResponse(response);
          return;
        }
        case 'PS_GET_RECORD': {
          const record = await getRecord(message.recordId);
          const response: RecordResponse = record
            ? { ok: true, record }
            : { ok: false, error: '记录不存在。' };
          sendResponse(response);
          return;
        }
        case 'PS_OPEN_PANEL': {
          const tabId = sender.tab?.id;
          const opened = await openPanel(tabId);
          sendResponse({ ok: opened });
          return;
        }
        case 'PS_SELECTION_CHANGED': {
          // 侧栏通过定时轮询读取选区；这里只需确认消息，避免内容脚本重试。
          sendResponse({ ok: true });
          return;
        }
        default: {
          sendResponse({ ok: false, error: '未知消息类型。' });
          return;
        }
      }
    } catch (error) {
      sendResponse({ ok: false, error: asErrorMessage(error) });
    }
  })();
  return true;
});

interface ActiveChat {
  controller: AbortController;
}

const activeChats = new Map<string, ActiveChat>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ps-chat') return;
  const portChats = new Set<string>();

  const safePost = (event: ChatPortEvent) => {
    try {
      port.postMessage(event);
    } catch {
      // 侧栏关闭后端口不可用，忽略。
    }
  };

  port.onMessage.addListener((message: ChatPortRequest) => {
    if (message.type === 'chat.abort') {
      activeChats.get(message.requestId)?.controller.abort();
      return;
    }
    if (message.type !== 'chat.start') return;

    const { payload } = message;
    const requestId = payload.requestId;
    const controller = new AbortController();
    activeChats.set(requestId, { controller });
    portChats.add(requestId);

    void (async () => {
      try {
        const settings = await loadSettings();
        const provider = getActiveProvider(settings);
        if (!provider.apiKey.trim()) {
          safePost({ type: 'error', requestId, error: '还没有配置 API Key，请先在设置页填写。' });
          return;
        }
        const skill = getSkillById(getAllSkills(settings.customSkills), payload.skill.id);
        const query =
          payload.query?.trim() ||
          [...payload.messages].reverse().find((message) => message.role === 'user')?.content ||
          '';
        const system = buildChatSystemPrompt(
          skill,
          payload.page,
          payload.selections,
          payload.language,
          payload.contextMode ?? settings.context.mode,
          query,
        );
        safePost({ type: 'start', requestId });
        await requestChat({
          provider,
          system,
          messages: payload.messages,
          signal: controller.signal,
          onDelta: (text) => safePost({ type: 'delta', requestId, text }),
        });
        safePost({ type: 'done', requestId });
      } catch (error) {
        safePost({ type: 'error', requestId, error: asErrorMessage(error) });
      } finally {
        activeChats.delete(requestId);
        portChats.delete(requestId);
      }
    })();
  });

  port.onDisconnect.addListener(() => {
    // 只中止属于当前端口的请求；其他侧栏标签的生成不应被一并打断。
    for (const requestId of portChats) {
      activeChats.get(requestId)?.controller.abort();
      activeChats.delete(requestId);
    }
    portChats.clear();
  });
});
