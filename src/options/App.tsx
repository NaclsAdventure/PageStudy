import { useEffect, useState } from 'react';
import type {
  BridgeHealth,
  ProviderConfig,
  ProviderId,
  ReasoningEffort,
  Settings,
  Skill,
} from '../shared/types';
import { DEFAULT_SKILLS, PROVIDER_LABELS } from '../shared/constants';
import { normalizeSettings } from '../shared/settings';
import { createId, asErrorMessage } from '../shared/utils';
import { clearRecords, exportRecords, importRecords, listRecords } from '../shared/db';
import { sendRuntimeMessage, type BridgeHealthResponse, type ModelsResponse } from '../shared/messages';
import './styles.css';

type Tab = 'model' | 'feishu' | 'documents' | 'skills' | 'data';

interface SettingsResponse {
  ok: boolean;
  settings?: Settings;
  error?: string;
}

interface TestResponse {
  ok: boolean;
  message?: string;
  error?: string;
}

const PROVIDER_ORDER: ProviderId[] = ['deepseek', 'openai', 'anthropic', 'gemini', 'custom'];
const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'default', label: '默认（不指定）' },
  { value: 'low', label: '低 · 快速' },
  { value: 'medium', label: '中 · 平衡' },
  { value: 'high', label: '高 · 深入' },
  { value: 'xhigh', label: '很高 · 复杂分析' },
  { value: 'max', label: '最高 · 尽可能深入' },
];

export default function OptionsApp() {
  const [tab, setTab] = useState<Tab>('model');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [testLoading, setTestLoading] = useState(false);
  const [bridge, setBridge] = useState<BridgeHealth | null>(null);
  const [bridgeLoading, setBridgeLoading] = useState(false);
  const [skillDraft, setSkillDraft] = useState({ name: '', description: '', prompt: '' });
  const [importText, setImportText] = useState('');
  const [recordCount, setRecordCount] = useState<number | null>(null);

  const activeProvider = settings ? settings.providers[settings.activeProvider] : null;

  useEffect(() => {
    void (async () => {
      try {
        const response = await sendRuntimeMessage<SettingsResponse>({ type: 'PS_GET_SETTINGS' });
        if (!response.ok || !response.settings) throw new Error(response.error ?? '读取设置失败');
        setSettings(normalizeSettings(response.settings));
      } catch (error) {
        setNotice({ text: asErrorMessage(error), error: true });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (tab === 'data') void refreshRecordCount();
  }, [tab]);

  const flash = (text: string, error = false) => {
    setNotice({ text, error });
    window.setTimeout(() => setNotice(null), 4200);
  };

  const save = async (value = settings): Promise<Settings | null> => {
    if (!value) return null;
    setSaving(true);
    try {
      const response = await sendRuntimeMessage<SettingsResponse>({
        type: 'PS_SAVE_SETTINGS',
        settings: value,
      });
      if (!response.ok || !response.settings) throw new Error(response.error ?? '保存失败');
      const normalized = normalizeSettings(response.settings);
      setSettings(normalized);
      flash('设置已保存。');
      return normalized;
    } catch (error) {
      flash(asErrorMessage(error), true);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const updateProvider = (patch: Partial<ProviderConfig>) => {
    if (!settings) return;
    const nextProvider = { ...settings.providers[settings.activeProvider], ...patch };
    setSettings({
      ...settings,
      providers: { ...settings.providers, [settings.activeProvider]: nextProvider },
    });
  };

  const changeActiveProvider = (id: ProviderId) => {
    if (!settings) return;
    setSettings({ ...settings, activeProvider: id });
    setModels([]);
  };

  const saveAndFetchModels = async () => {
    const saved = await save();
    if (!saved) return;
    setModelLoading(true);
    try {
      const response = await sendRuntimeMessage<ModelsResponse>({ type: 'PS_FETCH_MODELS' });
      if (!response.ok) throw new Error(response.error ?? '模型列表获取失败');
      const next = response.models ?? [];
      setModels(next);
      if (next.length === 0) flash('接口没有返回模型列表，可以手动填写模型名。');
      else flash(`已获取 ${next.length} 个模型。`);
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setModelLoading(false);
    }
  };

  const saveAndTest = async () => {
    const saved = await save();
    if (!saved) return;
    setTestLoading(true);
    try {
      const response = await sendRuntimeMessage<TestResponse>({ type: 'PS_TEST_PROVIDER' });
      if (!response.ok) throw new Error(response.error ?? '连接失败');
      flash(`连接成功：${response.message ?? '模型有响应'}`);
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setTestLoading(false);
    }
  };

  const checkBridge = async () => {
    const saved = await save();
    if (!saved) return;
    setBridgeLoading(true);
    try {
      const response = await sendRuntimeMessage<BridgeHealthResponse>({ type: 'PS_BRIDGE_HEALTH' });
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
        wikiPending: response.wikiPending,
        wikiError: response.wikiError,
        error: response.error,
      };
      setBridge(health);
      if (health.ok) {
        const ready = [
          health.larkCli ? '飞书' : '',
          health.notion ? 'Notion' : '',
          health.markdown ? '本地 Markdown' : '',
        ].filter(Boolean);
        flash(ready.length > 0 ? `桥接连接成功：${ready.join('、')}。` : '桥接已连接，但还没有启用任何文档目标。');
      } else {
        flash(health.error ?? '桥接服务未运行。', true);
      }
    } catch (error) {
      setBridge({ ok: false, larkCli: false, wiki: false, notion: false, markdown: false, error: asErrorMessage(error) });
      flash(asErrorMessage(error), true);
    } finally {
      setBridgeLoading(false);
    }
  };

  const flushSync = async () => {
    setBridgeLoading(true);
    try {
      const response = await sendRuntimeMessage<{
        ok: boolean;
        synced?: number;
        pending?: number;
        error?: number;
      }>({ type: 'PS_FLUSH_SYNC' });
      if (!response.ok) throw new Error('同步队列处理失败。');
      flash(`同步完成：本次处理 ${response.synced ?? 0} 条；剩余待处理 ${response.pending ?? 0} 条。`);
      await checkBridge();
    } catch (error) {
      flash(asErrorMessage(error), true);
    } finally {
      setBridgeLoading(false);
    }
  };

  const addSkill = () => {
    if (!settings) return;
    const name = skillDraft.name.trim();
    const prompt = skillDraft.prompt.trim();
    if (!name || !prompt) {
      flash('Skill 名称和指令不能为空。', true);
      return;
    }
    const skill: Skill = {
      id: createId('skill'),
      name,
      description: skillDraft.description.trim(),
      prompt,
      builtin: false,
    };
    setSettings({ ...settings, customSkills: [...settings.customSkills, skill] });
    setSkillDraft({ name: '', description: '', prompt: '' });
    flash('Skill 已添加，记得保存设置。');
  };

  const importSkillJson = () => {
    if (!settings) return;
    try {
      const parsed = JSON.parse(importText) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const skills: Skill[] = [];
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
        if (!name || !prompt) continue;
        skills.push({
          id: createId('skill'),
          name,
          description: typeof record.description === 'string' ? record.description.trim() : '',
          prompt,
          builtin: false,
          sourceUrl: typeof record.sourceUrl === 'string' ? record.sourceUrl.trim() : undefined,
        });
      }
      if (skills.length === 0) throw new Error('没有找到包含 name 和 prompt 的 Skill。');
      setSettings({ ...settings, customSkills: [...settings.customSkills, ...skills] });
      setImportText('');
      flash(`已导入 ${skills.length} 个 Skill，记得保存设置。`);
    } catch (error) {
      flash(asErrorMessage(error), true);
    }
  };

  const removeSkill = (id: string) => {
    if (!settings) return;
    setSettings({
      ...settings,
      customSkills: settings.customSkills.filter((skill) => skill.id !== id),
    });
  };

  const refreshRecordCount = async () => {
    try {
      const records = await listRecords();
      setRecordCount(records.length);
    } catch {
      setRecordCount(null);
    }
  };

  const exportData = async () => {
    try {
      const records = await exportRecords();
      const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `pagestudy-records-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      flash(`已导出 ${records.length} 条记录。`);
    } catch (error) {
      flash(asErrorMessage(error), true);
    }
  };

  const importData = async (file: File) => {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) throw new Error('备份文件必须是记录数组。');
      const count = await importRecords(parsed);
      await refreshRecordCount();
      flash(`已导入 ${count} 条记录。`);
    } catch (error) {
      flash(asErrorMessage(error), true);
    }
  };

  const clearData = async () => {
    if (!window.confirm('清空本地全部学习记录？建议先导出备份。此操作不可撤销。')) return;
    try {
      await clearRecords();
      await refreshRecordCount();
      flash('本地记录已清空。');
    } catch (error) {
      flash(asErrorMessage(error), true);
    }
  };

  if (loading) {
    return (
      <div className="options-loading">
        <span className="options-spinner" />
        正在读取设置…
      </div>
    );
  }

  if (!settings) {
    return <div className="options-error">无法读取设置：{notice?.text ?? '未知错误'}</div>;
  }

  return (
    <div className="options-shell">
      <aside className="options-sidebar">
        <div className="options-brand">
          <span className="options-logo">PS</span>
          <div>
            <strong>PageStudy</strong>
            <span>阅读学习助手</span>
          </div>
        </div>
        <nav className="options-nav">
          {(
            [
              ['model', '模型与推理'],
              ['documents', '文档与同步'],
              ['feishu', '桥接与飞书'],
              ['skills', 'Skills'],
              ['data', '数据与记录'],
            ] as Array<[Tab, string]>
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={tab === value ? 'options-nav-item active' : 'options-nav-item'}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="options-sidebar-footer">
          <span>v0.3.0 · MV3</span>
          <button type="button" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
            打开记录库
          </button>
        </div>
      </aside>

      <main className="options-main">
        <header className="options-header">
          <div>
            <span className="eyebrow">PAGE STUDY / SETTINGS</span>
            <h1>{tab === 'model' && '模型与推理'}{tab === 'documents' && '文档与同步'}{tab === 'feishu' && '桥接与飞书'}{tab === 'skills' && 'Skills'}{tab === 'data' && '数据与记录'}</h1>
          </div>
          <button type="button" className="save-button" onClick={() => void save()} disabled={saving}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </header>

        {tab === 'model' && activeProvider ? (
          <div className="options-content">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>当前服务商</h2>
                  <p>API Key 只保存在浏览器本地，不会进入网页内容脚本。</p>
                </div>
              </div>
              <div className="provider-tabs">
                {PROVIDER_ORDER.map((id) => (
                  <button
                    type="button"
                    key={id}
                    className={settings.activeProvider === id ? 'provider-tab active' : 'provider-tab'}
                    onClick={() => changeActiveProvider(id)}
                  >
                    {PROVIDER_LABELS[id]}
                  </button>
                ))}
              </div>

              <div className="form-grid">
                <label className="field full">
                  <span>API Key</span>
                  <div className="secret-field">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={activeProvider.apiKey}
                      onChange={(event) => updateProvider({ apiKey: event.target.value })}
                      placeholder="sk-…"
                      autoComplete="off"
                    />
                    <button type="button" className="ghost-button" onClick={() => setShowKey((value) => !value)}>
                      {showKey ? '隐藏' : '显示'}
                    </button>
                  </div>
                </label>

                <label className="field full">
                  <span>Base URL</span>
                  <input
                    value={activeProvider.baseUrl}
                    onChange={(event) => updateProvider({ baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    spellCheck={false}
                  />
                  <small>OpenAI 兼容接口通常以 /v1 结尾；Anthropic 和 Gemini 使用各自默认地址。</small>
                </label>

                <label className="field">
                  <span>模型</span>
                  <div className="inline-field">
                    <input
                      value={activeProvider.model}
                      onChange={(event) => updateProvider({ model: event.target.value })}
                      placeholder="模型名称"
                      list="model-options"
                      spellCheck={false}
                    />
                    <datalist id="model-options">
                      {models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </datalist>
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => void saveAndFetchModels()}
                      disabled={modelLoading}
                    >
                      {modelLoading ? '获取中…' : '拉取列表'}
                    </button>
                  </div>
                  <small>拉取列表前会先保存当前 API Key 和 Base URL。</small>
                </label>

                <label className="field">
                  <span>推理强度</span>
                  <select
                    value={activeProvider.reasoning}
                    onChange={(event) => updateProvider({ reasoning: event.target.value as ReasoningEffort })}
                  >
                    {REASONING_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <small>不同服务商支持程度不同；不支持时会自动映射到可用的强度。</small>
                </label>

                <label className="field">
                  <span>输出语言</span>
                  <input
                    value={settings.outputLanguage}
                    onChange={(event) => setSettings({ ...settings, outputLanguage: event.target.value })}
                    placeholder="中文"
                  />
                </label>

                <div className="field">
                  <span>连接测试</span>
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => void saveAndTest()}
                    disabled={testLoading}
                  >
                    {testLoading ? '测试中…' : '测试当前模型'}
                  </button>
                </div>
              </div>
            </section>

            <section className="panel subtle-panel">
              <h2>推理强度说明</h2>
              <p>
                推理强度会按服务商分别映射：OpenAI 兼容接口使用 reasoning_effort，Anthropic 使用 thinking
                budget，Gemini 使用 thinkingConfig。它只影响模型思考预算，不改变网页内容和本地记录。
              </p>
              <p className="muted">聊天、生成知识卡共用当前服务商配置；后续可以拆成独立任务模型。</p>
            </section>
          </div>
        ) : null}

        {tab === 'documents' ? (
          <div className="options-content">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>文档目标</h2>
                  <p>飞书、Notion 和本地 Markdown 共用同一个本地桥接；所有 Token 只放在桥接进程环境变量里。</p>
                </div>
              </div>
              <div className="form-grid">
                <label className="field">
                  <span>默认保存目标</span>
                  <select
                    value={settings.documents.defaultTarget}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        documents: {
                          ...settings.documents,
                          defaultTarget: event.target.value as Settings['documents']['defaultTarget'],
                        },
                      })
                    }
                  >
                    <option value="feishu">飞书文档</option>
                    <option value="notion">Notion 页面</option>
                    <option value="markdown">本地 Markdown（Obsidian / Logseq）</option>
                  </select>
                  <small>侧栏和记录库会默认选中这个目标，仍可临时切换。</small>
                </label>
                <div className="field">
                  <span>保存后自动同步</span>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.documents.autoSync}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          documents: { ...settings.documents, autoSync: event.target.checked },
                        })
                      }
                    />
                    记录或知识卡保存后，自动创建/追加到默认目标
                  </label>
                  <small>失败会保留队列并退避重试；扩展启动时补传。</small>
                </div>
                <div className="field">
                  <span>保存后自动更新飞书 Wiki</span>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={settings.documents.wikiAutoSync}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          documents: { ...settings.documents, wikiAutoSync: event.target.checked },
                        })
                      }
                    />
                    记录变化后，自动同步到飞书个人文档库的 PageStudy Wiki
                  </label>
                  <small>
                    需要桥接的 lark-cli 已授权 wiki 权限；首次发布会创建根节点和分类，之后按内容哈希覆盖更新。
                  </small>
                </div>
                <label className="field full">
                  <span>Notion 父页面 ID</span>
                  <input
                    value={settings.documents.notionParentPageId}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        documents: { ...settings.documents, notionParentPageId: event.target.value },
                      })
                    }
                    placeholder="32 位 page ID 或含 ID 的 Notion 页面 URL"
                    spellCheck={false}
                  />
                  <small>父页面必须已分享给 Notion Integration；桥接环境变量 NOTION_PARENT_PAGE_ID 可作为兜底。</small>
                </label>
                <label className="field full">
                  <span>Markdown 子目录（可选）</span>
                  <input
                    value={settings.documents.markdownDirectory}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        documents: { ...settings.documents, markdownDirectory: event.target.value },
                      })
                    }
                    placeholder="例如：PageStudy（相对桥接的 PAGESTUDY_MARKDOWN_DIR）"
                    spellCheck={false}
                  />
                  <small>文件名会自动加时间戳；追加时使用桥接返回的相对路径。Obsidian 和 Logseq 可直接打开该目录。</small>
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="secondary-action" onClick={() => void checkBridge()} disabled={bridgeLoading}>
                  {bridgeLoading ? '检测中…' : '保存并检测桥接'}
                </button>
                {bridge ? (
                  <span className={bridge.ok ? 'health ok' : 'health bad'}>
                    {bridge.ok ? `桥接已连接${bridge.version ? ` · ${bridge.version}` : ''}` : bridge.error ?? '桥接未运行'}
                  </span>
                ) : null}
                <button type="button" className="ghost-button" onClick={() => void flushSync()} disabled={bridgeLoading}>
                  立即处理同步队列
                </button>
              </div>
              {bridge?.ok ? (
                <div className="health-grid">
                  <span className={bridge.larkCli ? 'health ok' : 'health bad'}>飞书 {bridge.larkCli ? '就绪' : '未就绪'}</span>
                  <span className={bridge.wiki ? 'health ok' : 'health bad'}>飞书 Wiki 接口 {bridge.wiki ? '就绪' : '未就绪'}</span>
                  <span className={bridge.notion ? 'health ok' : 'health bad'}>Notion {bridge.notion ? '已配置' : '未配置 Token'}</span>
                  <span className={bridge.markdown ? 'health ok' : 'health bad'}>
                    本地 Markdown {bridge.markdown ? `已启用：${bridge.markdownDir ?? ''}` : '未配置目录'}
                  </span>
                  {bridge.syncPending || bridge.syncError ? (
                    <span className="health bad">
                      自动同步队列：待处理 {bridge.syncPending ?? 0} · 失败 {bridge.syncError ?? 0}
                    </span>
                  ) : null}
                  {bridge.wikiPending || bridge.wikiError ? (
                    <span className="health bad">
                      飞书 Wiki 队列：待处理 {bridge.wikiPending ?? 0} · 失败 {bridge.wikiError ?? 0}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="panel subtle-panel">
              <h2>启动桥接</h2>
              <p>在 PageStudy 项目目录先设置环境变量，再启动桥接（PowerShell 示例）：</p>
              <pre className="command-block">{`$env:NOTION_TOKEN="secret_xxx"
$env:NOTION_PARENT_PAGE_ID="你的父页面 ID"
$env:PAGESTUDY_MARKDOWN_DIR="D:\\Notes\\PageStudy"
npm run bridge`}</pre>
              <p>
                Notion：在 Notion 创建 Integration，复制 Internal Integration Secret；打开父页面 → 分享 →
                邀请该 Integration。扩展只支持父页面，暂不支持直接写入 database。
              </p>
              <p>
                Obsidian / Logseq：把 PAGESTUDY_MARKDOWN_DIR 指向 vault 内的一个目录。桥接会写入
                <code> .md </code>文件，追加时保留原文并插入分隔线。
              </p>
            </section>

            <section className="panel subtle-panel">
              <h2>自动同步的边界</h2>
              <p>
                保存学习记录或知识卡后会立即尝试同步；失败任务写入 chrome.storage.local，并用 alarm
                退避重试，浏览器下次启动时继续补传。
              </p>
              <p className="muted">
                Manifest V3 不能保证在关闭浏览器的瞬间完成网络请求，因此“关闭时自动上传”是尽力而为：
                真正的保障是保存后立即同步 + 持久队列 + 启动补偿，而不是依赖 onSuspend 的异步请求。
              </p>
            </section>
          </div>
        ) : null}

        {tab === 'feishu' ? (
          <div className="options-content">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>本地桥接服务</h2>
                  <p>
                    浏览器扩展不能直接调用代理侧的 MCP，本项目用本地桥接服务复用当前机器的 lark-cli，
                    不把飞书 App Secret 放进扩展。
                  </p>
                </div>
              </div>
              <div className="form-grid">
                <label className="field full">
                  <span>桥接地址</span>
                  <input
                    value={settings.feishu.url}
                    onChange={(event) =>
                      setSettings({ ...settings, feishu: { ...settings.feishu, url: event.target.value } })
                    }
                    placeholder="http://127.0.0.1:17373"
                    spellCheck={false}
                  />
                </label>
                <label className="field">
                  <span>桥接 Token（可选）</span>
                  <input
                    type="password"
                    value={settings.feishu.token}
                    onChange={(event) =>
                      setSettings({ ...settings, feishu: { ...settings.feishu, token: event.target.value } })
                    }
                    placeholder="如果启动时设置了 PAGE_STUDY_BRIDGE_TOKEN"
                  />
                </label>
                <label className="field">
                  <span>父文件夹 / 知识库节点 Token（可选）</span>
                  <input
                    value={settings.feishu.parentToken}
                    onChange={(event) =>
                      setSettings({ ...settings, feishu: { ...settings.feishu, parentToken: event.target.value } })
                    }
                    placeholder="folder token 或 wiki node token"
                    spellCheck={false}
                  />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="secondary-action" onClick={() => void checkBridge()} disabled={bridgeLoading}>
                  {bridgeLoading ? '检测中…' : '检测桥接'}
                </button>
                {bridge ? (
                  <span className={bridge.ok && bridge.larkCli ? 'health ok' : 'health bad'}>
                    {bridge.ok && bridge.larkCli
                      ? `已连接${bridge.version ? ` · ${bridge.version}` : ''}`
                      : bridge.error ?? 'lark-cli 未就绪'}
                  </span>
                ) : null}
              </div>
            </section>

            <section className="panel subtle-panel">
              <h2>启动方式</h2>
              <p>在 PageStudy 项目目录执行：</p>
              <pre className="command-block">npm run bridge</pre>
              <p>
                桥接服务只监听 127.0.0.1。它调用当前已经登录的 lark-cli 创建飞书文档；文档创建完成后会返回 URL。
                如果飞书 CLI 的用户登录过期，首次写入时会自动尝试刷新，失败时会在侧栏显示错误。
              </p>
              <p className="muted">
                飞书写入由你点击“写入飞书”或明确开启自动同步后触发，模型不能自行发布或修改外部文档。
                Notion 和本地 Markdown 的配置在“文档与同步”页。
              </p>
            </section>
          </div>
        ) : null}

        {tab === 'skills' ? (
          <div className="options-content">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>内置 Skill</h2>
                  <p>内置 Skill 是只读提示词模板，可在侧栏会话中切换。</p>
                </div>
              </div>
              <div className="skill-list">
                {DEFAULT_SKILLS.map((skill) => (
                  <div className="skill-item" key={skill.id}>
                    <div>
                      <strong>{skill.name}</strong>
                      <p>{skill.description}</p>
                      {skill.sourceUrl ? (
                        <a className="skill-source" href={skill.sourceUrl} target="_blank" rel="noreferrer">
                          方法来源
                        </a>
                      ) : null}
                    </div>
                    <span className="builtin-badge">内置</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>自定义 Skill</h2>
                  <p>Skill 只包含提示词和输出规范，不会执行任意代码，也不会自动调用写入工具。</p>
                </div>
              </div>
              {settings.customSkills.length > 0 ? (
                <div className="skill-list">
                  {settings.customSkills.map((skill) => (
                    <div className="skill-item" key={skill.id}>
                      <div>
                        <strong>{skill.name}</strong>
                        <p>{skill.description || '没有描述'}</p>
                      </div>
                      <button type="button" className="danger-link" onClick={() => removeSkill(skill.id)}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">还没有自定义 Skill。</p>
              )}

              <div className="form-grid">
                <label className="field">
                  <span>名称</span>
                  <input
                    value={skillDraft.name}
                    onChange={(event) => setSkillDraft({ ...skillDraft, name: event.target.value })}
                    placeholder="例如：面试官视角"
                  />
                </label>
                <label className="field">
                  <span>一句话描述</span>
                  <input
                    value={skillDraft.description}
                    onChange={(event) => setSkillDraft({ ...skillDraft, description: event.target.value })}
                    placeholder="这个 Skill 适合什么场景"
                  />
                </label>
                <label className="field full">
                  <span>提示词</span>
                  <textarea
                    value={skillDraft.prompt}
                    onChange={(event) => setSkillDraft({ ...skillDraft, prompt: event.target.value })}
                    placeholder="写下角色、任务、输出结构、约束…"
                    rows={5}
                  />
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="secondary-action" onClick={addSkill}>
                  添加 Skill
                </button>
                <button type="button" className="secondary-action" onClick={() => void save()}>
                  保存当前设置
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>导入 JSON</h2>
              <p className="muted">支持单个对象或数组，字段：name、description、prompt。</p>
              <textarea
                className="import-area"
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder={'[{"name":"示例","description":"说明","prompt":"你是一位…"}]'}
                rows={4}
              />
              <button type="button" className="secondary-action" onClick={importSkillJson}>
                解析并加入
              </button>
            </section>
          </div>
        ) : null}

        {tab === 'data' ? (
          <div className="options-content">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>本地记录</h2>
                  <p>记录、对话、正文快照和知识卡保存在 IndexedDB；API Key 保存在 chrome.storage.local。</p>
                </div>
                <span className="big-count">{recordCount ?? '—'}</span>
              </div>
              <div className="button-row">
                <button type="button" className="secondary-action" onClick={() => void exportData()}>
                  导出全部记录 JSON
                </button>
                <label className="file-button">
                  导入 JSON
                  <input
                    type="file"
                    accept="application/json"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void importData(file);
                      event.target.value = '';
                    }}
                  />
                </label>
                <button type="button" className="danger-button" onClick={() => void clearData()}>
                  清空本地记录
                </button>
              </div>
            </section>

            <section className="panel subtle-panel">
              <h2>数据边界</h2>
              <p>
                打开普通网页时，扩展会读取正文、图注和图片地址，作为本地快照与上下文。聊天按侧栏的“上下文范围”发送：
                智能全文只带相关片段，始终全文发送全文，仅选段只带选中段落；生成知识卡时会发送正文、图注和对话摘要。
                API Key 只在后台 Service Worker 读取，网页里的内容不会被当成指令执行。
              </p>
              <p className="muted">
                当前版本不做云同步。网页改版或删除后，记录中的正文快照、知识卡和笔记仍保存在本地，但点击锚点可能无法回到原文。
              </p>
            </section>
          </div>
        ) : null}

        {notice ? <div className={notice.error ? 'options-notice error' : 'options-notice'}>{notice.text}</div> : null}
      </main>
    </div>
  );
}
