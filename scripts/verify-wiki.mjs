/**
 * 飞书 Wiki 发布器离线验证：用假的 lark-cli 调用验证创建、复用、覆盖更新、
 * 幂等跳过和内部链接替换。不会访问真实飞书，也不需要 Token。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { publishWiki } from '../bridge/feishu-wiki.mjs';

let sequence = 0;
let updateCount = 0;
let failOnUpdate = 0;
const nodes = new Map();
const contents = new Map();
const children = new Map();
const calls = [];

function nextId(prefix) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

function addNode({ title, parent = '', objType = 'docx' }) {
  const nodeToken = nextId('node');
  const objToken = nextId('obj');
  const node = {
    node_token: nodeToken,
    obj_token: objToken,
    obj_type: objType,
    parent_node_token: parent,
    title,
    url: `https://example.feishu.cn/wiki/${nodeToken}`,
  };
  nodes.set(nodeToken, node);
  const list = children.get(parent) ?? [];
  list.push(node);
  children.set(parent, list);
  return node;
}

async function runLark(args, cwd) {
  calls.push(args);
  if (args[0] === 'wiki' && args[1] === 'spaces' && args[2] === 'get') {
    return JSON.stringify({ ok: true, data: { space: { space_id: 'space-1' } } });
  }
  if (args[0] === 'wiki' && args[1] === '+node-list') {
    const parent = args.includes('--parent-node-token')
      ? args[args.indexOf('--parent-node-token') + 1]
      : '';
    return JSON.stringify({
      ok: true,
      data: {
        nodes: (children.get(parent) ?? []).map((node) => ({
          node_token: node.node_token,
          obj_token: node.obj_token,
          title: node.title,
        })),
        has_more: false,
      },
    });
  }
  if (args[0] === 'wiki' && args[1] === '+node-create') {
    const title = args[args.indexOf('--title') + 1];
    const parent = args.includes('--parent-node-token')
      ? args[args.indexOf('--parent-node-token') + 1]
      : '';
    const node = addNode({ title, parent });
    return JSON.stringify({
      ok: true,
      data: {
        node_token: node.node_token,
        obj_token: node.obj_token,
        url: node.url,
      },
    });
  }
  if (args[0] === 'docs' && args[1] === '+update') {
    updateCount += 1;
    if (failOnUpdate && updateCount === failOnUpdate) {
      failOnUpdate = 0;
      throw new Error('模拟写入失败');
    }
    const docToken = args[args.indexOf('--doc') + 1];
    const contentArg = args[args.indexOf('--content') + 1];
    assert.ok(contentArg.startsWith('@'));
    const markdown = await readFile(path.join(cwd, contentArg.slice(1)), 'utf8');
    contents.set(docToken, markdown);
    return JSON.stringify({
      ok: true,
      data: { document: { url: `https://example.feishu.cn/docx/${docToken}` } },
    });
  }
  throw new Error(`未模拟的 lark-cli 调用：${args.join(' ')}`);
}

function buildPayload() {
  return {
    root: {
      title: 'PageStudy Wiki',
      markdown: '# 占位\n\n- [学习记录]({{pagestudy:category:records}})',
      hash: 'root-hash-1',
    },
    categories: [
      {
        key: 'records',
        title: '学习记录',
        markdown: '- [示例]({{pagestudy:note:test}})',
        hash: 'cat-records-1',
      },
      { key: 'tags', title: '标签主题', markdown: '标签', hash: 'cat-tags-1' },
      { key: 'concepts', title: '概念主题', markdown: '概念', hash: 'cat-concepts-1' },
    ],
    pages: [
      {
        id: 'note:test',
        kind: 'note',
        category: 'records',
        title: '示例记录',
        markdown: `> 来源：示例\n\n## 概览\n\n内容\n\n[返回首页]({{pagestudy:__root__}})`,
        hash: 'page-note-1',
      },
      {
        id: 'tag:阅读-123456',
        kind: 'tag',
        category: 'tags',
        title: '标签 · 阅读',
        markdown: `[示例]({{pagestudy:note:test}})`,
        hash: 'page-tag-1',
      },
    ],
    state: null,
  };
}

const first = await publishWiki({ runLark, payload: buildPayload() });
assert.equal(first.ok, true, first.error);
assert.equal(first.created, 6);
assert.ok(first.state);
assert.equal(first.state.root.title, 'PageStudy Wiki');
assert.equal(first.state.categories.records.title, '学习记录');
assert.equal(first.state.pages['note:test'].title, '示例记录');
assert.match(
  contents.get(first.state.root.objToken),
  /https:\/\/example\.feishu\.cn\/wiki\/node-/,
);
assert.match(
  contents.get(first.state.pages['note:test'].objToken),
  /https:\/\/example\.feishu\.cn\/wiki\/node-/,
);

const second = await publishWiki({
  runLark,
  payload: { ...buildPayload(), state: first.state },
});
assert.equal(second.ok, true, second.error);
assert.equal(second.created, 0);
assert.equal(second.updated, 0);
assert.equal(second.skipped, 6);
assert.equal(second.state.root.nodeToken, first.state.root.nodeToken);

const changed = buildPayload();
changed.state = first.state;
changed.pages[0].markdown += '\n\n新增内容';
changed.pages[0].hash = 'page-note-2';
const third = await publishWiki({ runLark, payload: changed });
assert.equal(third.ok, true, third.error);
assert.equal(third.updated, 1);
assert.match(contents.get(third.state.pages['note:test'].objToken), /新增内容/);

// 页面节点已创建但内容写入失败时，状态里不能提前记下新哈希；
// 重试必须真正写入内容，而不是误判为“已是最新”。
const withNewPage = structuredClone(changed);
withNewPage.state = third.state;
withNewPage.pages.push({
  id: 'note:new',
  kind: 'note',
  category: 'records',
  title: '新记录',
  markdown: '# 新记录\n\n第一次写入应该失败。',
  hash: 'page-new-1',
});
updateCount = 0;
failOnUpdate = 1; // 根节点、分类和旧页面都命中跳过；新页面是本次第一个实际写入
const failed = await publishWiki({ runLark, payload: withNewPage });
assert.equal(failed.ok, false);
assert.equal(failed.state.pages['note:new'].hash, '');
const retryPayload = structuredClone(changed);
retryPayload.state = failed.state;
retryPayload.pages.push(withNewPage.pages[2]);
const retriedAgain = await publishWiki({ runLark, payload: retryPayload });
assert.equal(retriedAgain.ok, true, retriedAgain.error);
assert.equal(retriedAgain.updated, 1);
assert.match(contents.get(retriedAgain.state.pages['note:new'].objToken), /第一次写入应该失败/);

// 本地清单不再包含某页时，发布状态应同步裁剪，避免旧映射无限累积。
const prunedPayload = structuredClone(changed);
prunedPayload.state = retriedAgain.state;
const pruned = await publishWiki({ runLark, payload: prunedPayload });
assert.equal(pruned.ok, true, pruned.error);
assert.equal(pruned.state.pages['note:new'], undefined);
assert.ok(pruned.state.pages['note:test']);

// 本地映射丢失时，按标题复用已有根节点和分类，不重复创建。
const adopted = await publishWiki({
  runLark,
  payload: { ...buildPayload(), state: null },
  webOrigin: 'https://example.feishu.cn',
});
assert.equal(adopted.ok, true, adopted.error);
assert.equal(adopted.state.root.nodeToken, first.state.root.nodeToken);
assert.equal(adopted.state.categories.records.nodeToken, first.state.categories.records.nodeToken);
assert.equal(adopted.created, 0);

console.log('飞书 Wiki 发布器验证通过：创建、复用、幂等跳过、覆盖更新、失败重试、状态裁剪、链接替换。');
console.log(`lark-cli 调用次数：${calls.length}；页面内容数：${contents.size}`);
