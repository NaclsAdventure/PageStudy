import { describe, expect, it } from 'vitest';
import { getDefaultSettings } from './constants';
import { normalizeSettings, sanitizeBridgeUrl, toPublicSettings } from './settings';

describe('normalizeSettings', () => {
  it('缺少字段时回退到默认设置', () => {
    const settings = normalizeSettings({});
    const defaults = getDefaultSettings();
    expect(settings.activeProvider).toBe(defaults.activeProvider);
    expect(settings.providers.deepseek.baseUrl).toBe(defaults.providers.deepseek.baseUrl);
    expect(settings.providers.deepseek.reasoning).toBe('default');
    expect(settings.outputLanguage).toBe('中文');
  });

  it('保留有效的服务商、推理强度与自定义 Skill', () => {
    const settings = normalizeSettings({
      activeProvider: 'anthropic',
      providers: {
        anthropic: {
          apiKey: 'sk-ant-test',
          baseUrl: 'https://proxy.example.com/v1/',
          model: 'claude-test',
          reasoning: 'max',
        },
      },
      outputLanguage: 'English',
      customSkills: [
        { name: '面试官', prompt: '从面试官视角提问', description: '模拟面试' },
        { name: '', prompt: '无效' },
      ],
      feishu: { url: ' http://127.0.0.1:17373/ ', token: 'bridge-token', parentToken: ' fld123 ' },
    });
    expect(settings.activeProvider).toBe('anthropic');
    expect(settings.providers.anthropic.apiKey).toBe('sk-ant-test');
    expect(settings.providers.anthropic.reasoning).toBe('max');
    expect(settings.outputLanguage).toBe('English');
    expect(settings.customSkills).toHaveLength(1);
    expect(settings.customSkills[0].name).toBe('面试官');
    expect(settings.feishu.url).toBe('http://127.0.0.1:17373');
    expect(settings.feishu.parentToken).toBe('fld123');
  });

  it('拒绝非法的推理强度和未知服务商', () => {
    const settings = normalizeSettings({
      activeProvider: 'not-a-provider',
      providers: { openai: { reasoning: 'ultra' } },
    });
    expect(settings.activeProvider).toBe('deepseek');
    expect(settings.providers.openai.reasoning).toBe('default');
  });
});

describe('toPublicSettings', () => {
  it('只暴露是否配置 Key，不泄露 API Key 和桥接 Token', () => {
    const settings = getDefaultSettings();
    settings.providers.deepseek.apiKey = 'sk-secret';
    settings.feishu.token = 'bridge-secret';
    settings.feishu.parentToken = 'fld-public';
    const publicSettings = toPublicSettings(settings);
    expect(publicSettings.providers.deepseek.hasApiKey).toBe(true);
    expect('apiKey' in publicSettings.providers.deepseek).toBe(false);
    expect(JSON.stringify(publicSettings)).not.toContain('sk-secret');
    expect(JSON.stringify(publicSettings)).not.toContain('bridge-secret');
    expect(publicSettings.feishu.parentToken).toBe('fld-public');
    expect(publicSettings.feishu.hasToken).toBe(true);
  });
});

describe('sanitizeBridgeUrl', () => {
  it('接受 HTTP 本地地址并去掉末尾斜杠', () => {
    expect(sanitizeBridgeUrl(' http://127.0.0.1:17373/ ')).toBe('http://127.0.0.1:17373');
  });

  it('拒绝非 HTTP 协议和空值', () => {
    expect(sanitizeBridgeUrl('file:///tmp/bridge')).toBe('');
    expect(sanitizeBridgeUrl('')).toBe('');
  });
});
