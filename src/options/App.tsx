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

type Tab = 'model' | 'feishu' | 'skills' | 'data';

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
        version: response.version,
        error: response.error,
      };
      setBridge(health);
      if (health.ok && health.larkCli) flash('本地飞书桥接服务连接成功。');
      else flash(health.error ?? '桥接服务未运行。', true);
    } catch (error) {
      setBridge({ ok: false, larkCli: false, error: asErrorMessage(error) });
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
              ['feishu', '飞书桥接'],
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
          <span>v0.1.0 · MV3</span>
          <button type="button" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') })}>
            打开记录库
          </button>
        </div>
      </aside>

      <main className="options-main">
        <header className="options-header">
          <div>
            <span className="eyebrow">PAGE STUDY / SETTINGS</span>
            <h1>{tab === 'model' && '模型与推理'}{tab === 'feishu' && '飞书桥接'}{tab === 'skills' && 'Skills'}{tab === 'data' && '数据与记录'}</h1>
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
              <p className="muted">聊天、逐节总结共用当前服务商配置；后续可以拆成独立任务模型。</p>
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
                写入动作必须由你在侧栏点击“写入飞书”触发，模型不能自行发布或修改外部文档。
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
                  <p>记录、对话、大纲和总结保存在 IndexedDB；API Key 保存在 chrome.storage.local。</p>
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
                扩展不会自动上传整页内容。聊天时只发送页面标题、URL、大纲标题和必要段落，以及你选中的上下文；
                生成总结时会发送大纲和对话。API Key 只在后台 Service Worker 中使用。
              </p>
              <p className="muted">
                当前版本不做云同步。网页改版或删除后，记录中的大纲、总结和笔记仍保存在本地，但点击锚点可能无法回到原文。
              </p>
            </section>
          </div>
        ) : null}

        {notice ? <div className={notice.error ? 'options-notice error' : 'options-notice'}>{notice.text}</div> : null}
      </main>
    </div>
  );
}
