import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishWiki } from '../core/feishu-publisher.mjs';

const ORIGIN = 'https://example.feishu.cn';

function makePayload(overrides = {}) {
  const page = {
    id: 'session:s1',
    kind: 'note',
    category: 'records',
    title: '会话一',
    markdown: '# 会话一\n\n[返回]({{cw:__root__}}) · [分类]({{cw:category:records}})',
    hash: 'page-1',
  };
  return {
    root: {
      title: '会话知识库',
      markdown: '# 会话知识库\n\n[会话记录]({{cw:category:records}})',
      hash: 'root-1',
    },
    categories: ['records', 'tags', 'concepts'].map((key) => ({
      key,
      title: key === 'records' ? '会话记录' : key === 'tags' ? '标签主题' : '概念主题',
      markdown: `# ${key}\n\n[返回]({{cw:__root__}})`,
      hash: `cat-${key}`,
    })),
    pages: [page],
    ...overrides,
  };
}

function fakeLark(options = {}) {
  let sequence = 0;
  const nodes = new Map();
  const updates = [];
  let failToken = options.failToken || '';

  function addNode(parent, title) {
    sequence += 1;
    const node = {
      node_token: `n${sequence}`,
      obj_token: `d${sequence}`,
      url: `${ORIGIN}/wiki/n${sequence}`,
      title,
    };
    if (!nodes.has(parent)) nodes.set(parent, []);
    nodes.get(parent).push(node);
    return node;
  }

  async function run(args, cwd) {
    if (args[0] === 'wiki' && args[1] === 'spaces' && args[2] === 'get') {
      return JSON.stringify({ ok: true, data: { space: { space_id: 'space-1' } } });
    }
    if (args[0] === 'wiki' && args[1] === '+node-list') {
      const parentIndex = args.indexOf('--parent-node-token');
      const parent = parentIndex >= 0 ? args[parentIndex + 1] : '';
      const result = nodes.get(parent) || [];
      return JSON.stringify({ ok: true, data: { nodes: result, has_more: false } });
    }
    if (args[0] === 'wiki' && args[1] === '+node-create') {
      const titleIndex = args.indexOf('--title');
      const parentIndex = args.indexOf('--parent-node-token');
      const title = args[titleIndex + 1];
      const parent = parentIndex >= 0 ? args[parentIndex + 1] : '';
      const node = addNode(parent, title);
      return JSON.stringify({ ok: true, data: node });
    }
    if (args[0] === 'docs' && args[1] === '+update') {
      const docIndex = args.indexOf('--doc');
      const contentIndex = args.indexOf('--content');
      const doc = args[docIndex + 1];
      const file = args[contentIndex + 1].replace(/^@/, '');
      const markdown = await readFile(join(cwd, file), 'utf8');
      updates.push({ doc, markdown });
      if (failToken && doc === failToken) {
        return JSON.stringify({ ok: false, error: { message: 'timeout while updating' } });
      }
      return JSON.stringify({ ok: true, data: { document: { url: `${ORIGIN}/docx/${doc}` } } });
    }
    return JSON.stringify({ ok: false, error: { message: `unexpected command ${args.join(' ')}` } });
  }

  return {
    run,
    nodes,
    updates,
    setFailToken(value) {
      failToken = value;
    },
  };
}

test('飞书发布创建节点、替换链接，并在第二次发布跳过未变化页面', async () => {
  const fake = fakeLark();
  const dir = await mkdtemp(join(tmpdir(), 'cw-feishu-'));
  try {
    const first = await publishWiki({
      runLark: fake.run,
      payload: makePayload(),
      webOrigin: ORIGIN,
    });
    assert.equal(first.ok, true);
    assert.equal(first.created, 5);
    assert.equal(first.updated, 5);
    assert.equal(first.skipped, 0);
    assert.equal(fake.updates.length, 5);
    assert.match(fake.updates[0].markdown, /\[会话记录\]\(https:\/\/example\.feishu\.cn\/wiki\/n2\)/);
    assert.doesNotMatch(fake.updates[0].markdown, /\{\{cw:/);

    const second = await publishWiki({
      runLark: fake.run,
      payload: makePayload({ state: first.state }),
      webOrigin: ORIGIN,
    });
    assert.equal(second.ok, true);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.skipped, 5);
    assert.equal(fake.updates.length, 5);

    const changedPage = makePayload({ state: second.state });
    changedPage.pages[0].hash = 'page-2';
    changedPage.pages[0].markdown += '\n\n新增内容';
    const third = await publishWiki({
      runLark: fake.run,
      payload: changedPage,
      webOrigin: ORIGIN,
    });
    assert.equal(third.ok, true);
    assert.equal(third.updated, 1);
    assert.equal(third.skipped, 4);
    assert.equal(fake.updates.length, 6);
    assert.match(fake.updates.at(-1).markdown, /新增内容/);
    assert.equal(third.state.pages['session:s1'].hash, 'page-2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('发布失败只保留已成功写入的哈希，重试时只补未完成页面', async () => {
  const fake = fakeLark();
  const dir = await mkdtemp(join(tmpdir(), 'cw-feishu-'));
  try {
    fake.setFailToken('d5');
    const failed = await publishWiki({
      runLark: fake.run,
      payload: makePayload(),
      webOrigin: ORIGIN,
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error, /timeout/);
    assert.ok(failed.state);
    assert.equal(failed.state.pages['session:s1'].hash, '');

    fake.setFailToken('');
    const retried = await publishWiki({
      runLark: fake.run,
      payload: makePayload({ state: failed.state }),
      webOrigin: ORIGIN,
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.updated, 1);
    assert.equal(retried.skipped, 4);
    assert.equal(retried.state.pages['session:s1'].hash, 'page-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('本地页面减少后状态映射会被裁剪，但云端文档不会被自动删除', async () => {
  const fake = fakeLark();
  const dir = await mkdtemp(join(tmpdir(), 'cw-feishu-'));
  try {
    const first = await publishWiki({
      runLark: fake.run,
      payload: makePayload(),
      webOrigin: ORIGIN,
    });
    assert.ok(first.state.pages['session:s1']);
    const second = await publishWiki({
      runLark: fake.run,
      payload: makePayload({ state: first.state, pages: [] }),
      webOrigin: ORIGIN,
    });
    assert.equal(second.ok, true);
    assert.deepEqual(second.state.pages, {});
    assert.ok([...fake.nodes.values()].flat().some((node) => node.title === '会话记录'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('只创建部分节点后失败，也会返回可复用的部分状态', async () => {
  const fake = fakeLark();
  const dir = await mkdtemp(join(tmpdir(), 'cw-feishu-'));
  try {
    fake.setFailToken('d2');
    const failed = await publishWiki({
      runLark: fake.run,
      payload: makePayload(),
      webOrigin: ORIGIN,
    });
    assert.equal(failed.ok, false);
    assert.ok(failed.state);
    assert.ok(failed.state.root.nodeToken);
    assert.ok(failed.created >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
