import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildWiki,
  ensureConfig,
  listRecords,
  makeAutoRecord,
  mergeAutoRecord,
  normalizeRecord,
  normalizeTranscript,
  recordConversation,
  recordFilePath,
  redactText,
  saveAutoRecord,
  saveRecord,
  transcriptSignature,
  vaultPaths,
  writeWiki,
} from '../core/index.mjs';

async function tempHome() {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-wiki-test-'));
  process.env.CONVERSATION_WIKI_HOME = dir;
  return dir;
}

async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true });
  delete process.env.CONVERSATION_WIKI_HOME;
}

test('转录归一化会丢弃系统消息、处理内容块并脱敏', () => {
  const transcript = normalizeTranscript(
    [
      { role: 'system', content: '系统提示' },
      { role: 'user', content: [{ type: 'text', text: '我的 key 是 sk-abcdefghijklmnopqrstuvwx' }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到。' }] },
      { role: 'toolResult', content: [{ type: 'text', text: '工具输出' }] },
      { role: 'user', text: '重复' },
      { role: 'user', text: '重复' },
    ],
    { includeToolMessages: false },
  );
  assert.equal(transcript.messages.length, 3);
  assert.equal(transcript.messages[0].role, 'user');
  assert.match(transcript.messages[0].text, /已脱敏/);
  assert.equal(transcript.messages[1].role, 'assistant');
  assert.equal(transcript.messages[2].text, '重复');
  assert.equal(transcript.originalCount, 3);
});

test('脱敏覆盖常见 token 与私钥', () => {
  assert.match(redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /已脱敏/);
  assert.match(redactText('github_pat_abcdefghijklmnopqrstuvwxyz012345'), /已脱敏/);
  assert.match(redactText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'), /已脱敏/);
  assert.doesNotMatch(redactText('普通文本 api 说明'), /已脱敏/);
});

test('自动记录不会覆盖已经整理过的摘要', async () => {
  const home = await tempHome();
  try {
    const config = await ensureConfig();
    const auto = makeAutoRecord({
      id: 'merge-1',
      messages: [
        { role: 'user', text: '第一版需求' },
        { role: 'assistant', text: '第一版回答' },
      ],
      source: { agent: 'cli', sessionId: 'merge-1' },
      maxMessages: 100,
      maxChars: 10_000,
    });
    await saveAutoRecord(config, auto);
    const enriched = await saveRecord(config, {
      ...auto,
      title: '人工标题',
      overview: '人工概览',
      tags: ['人工标签'],
      enriched: true,
    });
    assert.equal(enriched.record.title, '人工标题');

    const nextAuto = makeAutoRecord({
      id: 'merge-1',
      messages: [
        { role: 'user', text: '第一版需求' },
        { role: 'assistant', text: '第一版回答' },
        { role: 'user', text: '追加需求' },
      ],
      source: { agent: 'cli', sessionId: 'merge-1' },
      maxMessages: 100,
      maxChars: 10_000,
    });
    const merged = await saveAutoRecord(config, nextAuto);
    assert.equal(merged.record.title, '人工标题');
    assert.equal(merged.record.overview, '人工概览');
    assert.deepEqual(merged.record.tags, ['人工标签']);
    assert.equal(merged.record.messages.length, 3);
  } finally {
    await cleanup(home);
  }
});

test('Wiki 构建产生会话、标签、概念反链，并保持幂等', async () => {
  const home = await tempHome();
  try {
    const config = await ensureConfig();
    await recordConversation(config, {
      id: 'wiki-1',
      source: { agent: 'pi', sessionId: 'wiki-1' },
      messages: [
        { role: 'user', text: '讨论知识库' },
        { role: 'assistant', text: '可以生成 Markdown。' },
      ],
      enrichment: {
        title: '知识库一',
        overview: '第一条会话。',
        tags: ['阅读', '知识管理'],
        concepts: [{ term: '会话知识库', explanation: '会话派生 Wiki。' }],
      },
    });
    await recordConversation(config, {
      id: 'wiki-2',
      source: { agent: 'dsh', sessionId: 'wiki-2' },
      messages: [
        { role: 'user', text: '继续讨论' },
        { role: 'assistant', text: '补充反链。' },
      ],
      enrichment: {
        title: '知识库二',
        overview: '第二条会话。',
        tags: ['阅读'],
        concepts: [{ term: '反链', explanation: '页面之间互相链接。' }],
      },
    });

    const records = await listRecords(config);
    const wiki = buildWiki(records);
    assert.equal(wiki.counts.sessions, 2);
    assert.equal(wiki.counts.tags, 2);
    assert.equal(wiki.counts.concepts, 2);
    const tagPage = [...wiki.tagPages].find((page) => page.title.includes('阅读'));
    assert.ok(tagPage);
    assert.equal(tagPage.records.length, 2);
    assert.match(tagPage.markdown, /\{\{cw:session:wiki-1\}\}/);

    const first = await writeWiki(config, wiki);
    assert.equal(first.written, 0);
    const second = await writeWiki(config, buildWiki(await listRecords(config)));
    assert.equal(second.written, 0);
    assert.equal(second.pruned, 0);

    const indexPath = vaultPaths(config).rootPage;
    await rm(indexPath);
    const restored = await writeWiki(config, buildWiki(await listRecords(config)));
    assert.ok(restored.written >= 1);
    const index = await readFile(indexPath, 'utf8');
    assert.match(index, /sessions\/知识库一-/);
    assert.doesNotMatch(index, /\{\{cw:/);

    const sessionPage = wiki.pages.get('session:wiki-1');
    assert.match(await readFile(join(vaultPaths(config).vault, sessionPage.localPath), 'utf8'), /知识管理/);

    // 删除一条记录后，旧会话页应被清理，但记录文件本身不在这里自动删除。
    await rm(recordFilePath(config, 'wiki-2'));
    const pruned = await writeWiki(config, buildWiki(await listRecords(config)));
    assert.ok(pruned.pruned >= 1);
    const oldPage = wiki.pages.get('session:wiki-2');
    await assert.rejects(stat(join(vaultPaths(config).vault, oldPage.localPath)));
  } finally {
    await cleanup(home);
  }
});

test('中文标签页 ID 可用且内容哈希稳定', async () => {
  const home = await tempHome();
  try {
    const config = await ensureConfig();
    const record = normalizeRecord({
      id: 'zh-1',
      title: '中文标题',
      messages: [{ role: 'user', text: '你好' }],
      tags: ['阅读'],
      concepts: [{ term: '知识图谱', explanation: '概念之间的关系。' }],
      enriched: true,
    });
    await saveRecord(config, record);
    const wiki = buildWiki(await listRecords(config));
    assert.match(wiki.tagPages[0].id, /^tag:阅读-[a-f0-9]{6}$/u);
    assert.match(wiki.conceptPages[0].id, /^concept:知识图谱-[a-f0-9]{6}$/u);
    const first = transcriptSignature(record);
    assert.equal(first, transcriptSignature(record));
  } finally {
    await cleanup(home);
  }
});
