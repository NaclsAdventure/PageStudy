import { APP_VERSION } from '../shared/constants';
import type {
  BridgeHealthResponse,
  ChatPortEvent,
  ChatPortRequest,
  FeishuWriteResponse,
  ModelsResponse,
  RuntimeMessage,
  SummarizeResponse,
  TestProviderResponse,
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
import { appendFeishuDocument, checkBridge, writeFeishuDocument } from './feishu';

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
});

chrome.runtime.onStartup.addListener(() => {
  void setupSidePanel();
});

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
          sendResponse({ ok: true, settings });
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
          sendResponse({ ...health });
          return;
        }
        case 'PS_WRITE_FEISHU': {
          const settings = await loadSettings();
          const response: FeishuWriteResponse = await writeFeishuDocument(settings.feishu, {
            title: message.title,
            markdown: message.markdown,
            parentToken: message.parentToken,
          });
          sendResponse(response);
          return;
        }
        case 'PS_APPEND_FEISHU': {
          const settings = await loadSettings();
          const response: FeishuWriteResponse = await appendFeishuDocument(settings.feishu, {
            documentId: message.documentId,
            markdown: message.markdown,
          });
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
        const system = buildChatSystemPrompt(skill, payload.page, payload.selections, payload.language);
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
