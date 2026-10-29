import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../dsh.js';
import { ensureConfig, listRecords, saveConfig, vaultPaths } from '../core/index.mjs';

function makeAgent(id, messages, parent) {
  return {
    id,
    session: {
      id,
      header: {
        cwd: 'D:\\work',
        ...(parent ? { parentSession: parent } : {}),
      },
      deriveMessages: () => messages,
    },
  };
}

function makeCtx() {
  const handlers = new Map();
  const tools = new Map();
  const skills = [];
  const ctx = {
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => {};
      },
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => {};
    },
    get(name) {
      if (name !== 'skills') return undefined;
      return {
        register(def) {
          skills.push(def);
          return () => {};
        },
      };
    },
    effect(fn) {
      const dispose = fn();
      return () => dispose?.();
    },
    logger: { warn() {} },
  };
  return { ctx, handlers, tools, skills };
}

async function setup(autoCapture = true) {
  const home = await mkdtemp(join(tmpdir(), 'cw-dsh-test-'));
  process.env.CONVERSATION_WIKI_HOME = home;
  const config = await ensureConfig();
  config.autoCapture = autoCapture;
  config.autoPublish = false;
  await saveConfig(config);
  return home;
}

async function cleanup(home) {
  await rm(home, { recursive: true, force: true });
  delete process.env.CONVERSATION_WIKI_HOME;
}

function assertStandardSchema(value, path = 'schema') {
  if (!value || typeof value !== 'object') return;
  if (typeof value.required === 'boolean') {
    assert.fail(`${path}.required 必须是数组，不能是布尔值`);
  }
  for (const [key, child] of Object.entries(value)) {
    assertStandardSchema(child, `${path}.${key}`);
  }
}

test('DSH 插件注册工具与技能', async () => {
  const home = await setup();
  try {
    const { ctx, tools, skills } = makeCtx();
    apply(ctx);
    assert.ok(tools.has('conversation_wiki'));
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, 'conversation-wiki');
    assert.match(skills[0].content, /会话知识库/);
    const tool = tools.get('conversation_wiki');
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['action']);
    assert.deepEqual(tool.parameters.properties.action.enum, ['record', 'capture', 'publish', 'status', 'init']);
    assert.deepEqual(tool.parameters.properties.concepts.items.required, ['term']);
    assertStandardSchema(tool.parameters, 'parameters');
    assertStandardSchema(tool.output.schema, 'output.schema');
    assert.ok(tool.output.schema.required.includes('published'));
  } finally {
    await cleanup(home);
  }
});

test('DSH 在回合结束时自动捕获，并在无变化时跳过', async () => {
  const home = await setup(true);
  try {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '把这次会话存下来' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
    ];
    const agent = makeAgent('dsh-s1', messages);
    await handlers.get('agent/turn-stopping')({ agent });
    const records = await listRecords(await ensureConfig());
    assert.equal(records.length, 1);
    assert.equal(records[0].source.agent, 'dsh');
    assert.match(records[0].title, /把这次会话存下来/);

    const firstUpdated = records[0].updatedAt;
    await handlers.get('agent/turn-stopping')({ agent });
    const again = await listRecords(await ensureConfig());
    assert.equal(again[0].updatedAt, firstUpdated);

    messages.push({ role: 'assistant', content: [{ type: 'text', text: '再补充一句。' }] });
    await handlers.get('agent/turn-stopping')({ agent });
    const updated = await listRecords(await ensureConfig());
    assert.equal(updated[0].messages.length, 3);
  } finally {
    await cleanup(home);
  }
});

test('关闭自动捕获或子会话时不会写记录', async () => {
  const home = await setup(false);
  try {
    const { ctx, handlers } = makeCtx();
    apply(ctx);
    const agent = makeAgent('dsh-s2', [
      { role: 'user', content: [{ type: 'text', text: '不要保存' }] },
    ]);
    await handlers.get('agent/turn-stopping')({ agent });
    assert.equal((await listRecords(await ensureConfig())).length, 0);

    const config = await ensureConfig();
    config.autoCapture = true;
    await saveConfig(config);
    const child = makeAgent('dsh-child', [{ role: 'user', content: [{ type: 'text', text: '子任务' }] }], 'parent');
    await handlers.get('agent/turn-stopping')({ agent: child });
    assert.equal((await listRecords(await ensureConfig())).length, 0);
  } finally {
    await cleanup(home);
  }
});

test('DSH record 工具保存结构化摘要并生成 Wiki 页面', async () => {
  const home = await setup();
  try {
    const { ctx, tools } = makeCtx();
    apply(ctx);
    const agent = makeAgent('dsh-s3', [
      { role: 'user', content: [{ type: 'text', text: '讨论发布策略' }] },
      { role: 'assistant', content: [{ type: 'text', text: '默认不发布。' }] },
    ]);
    const result = await tools.get('conversation_wiki').execute(
      {
        action: 'record',
        title: '发布策略',
        overview: '确认默认只写本地。',
        tags: ['隐私', '发布'],
        concepts: [{ term: '默认关闭', explanation: '发布必须显式启用。' }],
        decisions: ['默认 autoPublish=false'],
        publish: false,
      },
      { agent },
    );
    assert.equal(result.ok, true);
    assert.equal(result.title, '发布策略');
    const config = await ensureConfig();
    const record = (await listRecords(config))[0];
    assert.equal(record.title, '发布策略');
    assert.deepEqual(record.tags, ['隐私', '发布']);
    const page = await readFile(join(vaultPaths(config).vault, 'index.md'), 'utf8');
    assert.match(page, /发布策略/);
    assert.doesNotMatch(page, /\{\{cw:/);
  } finally {
    await cleanup(home);
  }
});
