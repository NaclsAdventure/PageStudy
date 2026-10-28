import { APP_VERSION } from '../shared/constants';
import type { ContentMessage, PageContextResponse, SelectionResponse } from '../shared/messages';
import { asErrorMessage } from '../shared/utils';
import { buildPageContext, extractSelection, scrollToAnchor } from './extract';

declare global {
  interface Window {
    __PAGE_STUDY_CONTENT__?: boolean;
  }
}

if (!window.__PAGE_STUDY_CONTENT__) {
  window.__PAGE_STUDY_CONTENT__ = true;
  installMessageBridge();
  installSelectionWatcher();
  installFloatingButton();
}

function installMessageBridge(): void {
  chrome.runtime.onMessage.addListener(
    (message: ContentMessage, _sender, sendResponse) => {
      if (message.type === 'PS_PING_CONTENT') {
        sendResponse({ ok: true, version: APP_VERSION });
        return false;
      }
      if (message.type === 'PS_GET_PAGE_CONTEXT') {
        try {
          const response: PageContextResponse = { ok: true, page: buildPageContext() };
          sendResponse(response);
        } catch (error) {
          sendResponse({ ok: false, error: asErrorMessage(error) } satisfies PageContextResponse);
        }
        return false;
      }
      if (message.type === 'PS_GET_SELECTION') {
        try {
          const response: SelectionResponse = { ok: true, selection: extractSelection(document.body) };
          sendResponse(response);
        } catch (error) {
          sendResponse({ ok: false, error: asErrorMessage(error) } satisfies SelectionResponse);
        }
        return false;
      }
      if (message.type === 'PS_SCROLL_TO_ANCHOR') {
        sendResponse({ ok: scrollToAnchor(message.anchor) });
        return false;
      }
      return false;
    },
  );
}

function installSelectionWatcher(): void {
  let timer: number | null = null;
  let lastKey = '';

  const report = () => {
    timer = null;
    let selection = null;
    try {
      selection = extractSelection(document.body);
    } catch {
      selection = null;
    }
    const key = selection ? `${selection.text}|${selection.anchor}` : '';
    if (key === lastKey) return;
    lastKey = key;
    void chrome.runtime
      .sendMessage({ type: 'PS_SELECTION_CHANGED', selection })
      .catch(() => undefined);
  };

  const schedule = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(report, 240);
  };

  document.addEventListener('selectionchange', schedule, true);
  document.addEventListener('mouseup', schedule, true);
  document.addEventListener('keyup', schedule, true);
}

function installFloatingButton(): void {
  if (window.top !== window.self || !document.body) return;
  if (document.querySelector('[data-pagestudy-fab]')) return;

  const host = document.createElement('div');
  host.setAttribute('data-pagestudy-fab', 'true');
  host.style.cssText = [
    'position:fixed',
    'right:18px',
    'bottom:22px',
    'z-index:2147483647',
    'width:46px',
    'height:46px',
    'margin:0',
    'padding:0',
    'border:0',
    'background:transparent',
    'color-scheme:light',
  ].join(';');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    button {
      width: 46px; height: 46px; border: 0; border-radius: 15px;
      background: linear-gradient(145deg, #0f766e, #115e59);
      color: #f0fdfa; font: 700 17px/1 "Segoe UI", "Microsoft YaHei", sans-serif;
      box-shadow: 0 8px 22px rgba(15, 118, 110, .28), 0 1px 2px rgba(0,0,0,.18);
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    button:hover { transform: translateY(-2px); box-shadow: 0 12px 26px rgba(15,118,110,.36); }
    button:active { transform: translateY(0); }
    .toast {
      position: fixed; right: 0; bottom: 56px; max-width: 240px;
      padding: 8px 10px; border-radius: 9px; background: #0f172a; color: #f8fafc;
      font: 12px/1.5 "Microsoft YaHei", sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.22);
      opacity: 0; pointer-events: none; transform: translateY(4px);
      transition: opacity .2s ease, transform .2s ease;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  `;
  const button = document.createElement('button');
  button.type = 'button';
  button.title = '打开 PageStudy 学习侧栏';
  button.setAttribute('aria-label', '打开 PageStudy 学习侧栏');
  button.textContent = '学';
  const toast = document.createElement('div');
  toast.className = 'toast';

  const showToast = (text: string) => {
    toast.textContent = text;
    toast.classList.add('show');
    window.setTimeout(() => toast.classList.remove('show'), 2600);
  };

  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void chrome.runtime
      .sendMessage({ type: 'PS_OPEN_PANEL' })
      .then((response: { ok?: boolean } | undefined) => {
        if (!response?.ok) showToast('请点击浏览器工具栏的 PageStudy 图标打开侧栏。');
      })
      .catch(() => showToast('请点击浏览器工具栏的 PageStudy 图标打开侧栏。'));
  });

  shadow.append(style, button, toast);
  document.documentElement.append(host);
}
