#!/usr/bin/env node
/** Conversation Wiki 的命令行入口，便于不依赖 Agent 的调试与手动发布。 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  conversationWikiStatus,
  initConversationWiki,
  publishConversationWikiNow,
  rebuildConversationWiki,
  recordConversation,
} from './core/index.mjs';

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() || 'help';
  const options = { _: [] };
  while (args.length) {
    const value = args.shift();
    if (value === '--home') options.home = args.shift();
    else if (value === '--file') options.file = args.shift();
    else if (value === '--json') options.json = true;
    else if (value === '--force') options.force = true;
    else if (value === '--no-publish') options.noPublish = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else options._.push(value);
  }
  return { command, options };
}

async function readInput(file) {
  if (!file) throw new Error('record 需要 --file <record.json|->。');
  const text = file === '-' ? await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  }) : await readFile(file, 'utf8');
  return JSON.parse(text);
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function help() {
  print(`Conversation Wiki

用法：
  conversation-wiki init [--home <目录>]
  conversation-wiki status [--json] [--home <目录>]
  conversation-wiki build [--home <目录>]
  conversation-wiki record --file <record.json|-> [--home <目录>] [--no-publish]
  conversation-wiki publish [--home <目录>] [--force]

配置文件默认在 ~/.conversation-wiki/config.json。
record 输入格式见 skills/conversation-wiki/references/record-schema.md。`);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.home) process.env.CONVERSATION_WIKI_HOME = options.home;
  if (command === 'help' || options.help) {
    help();
    return;
  }
  const config = undefined;

  if (command === 'init') {
    const result = await initConversationWiki(config);
    print(options.json ? result : `已初始化：${result.config.vault}\n${result.config.configFile}`);
    return;
  }
  if (command === 'status') {
    const status = await conversationWikiStatus(config);
    if (options.json) print(status);
    else {
      print(`本地记录：${status.recordCount}`);
      print(`Wiki 页面：${status.wiki.pages}`);
      print(`根页面：${status.wiki.root}`);
      print(`飞书：${status.feishu.enabled ? '已启用' : '未启用'}${status.feishu.published ? ` · ${status.feishu.pages} 页` : ''}`);
    }
    return;
  }
  if (command === 'build') {
    const result = await rebuildConversationWiki(config);
    print(`已生成 ${result.wiki.counts.sessions} 条会话、${result.wiki.counts.tags} 个标签、${result.wiki.counts.concepts} 个概念。`);
    return;
  }
  if (command === 'record') {
    const input = await readInput(options.file);
    if (options.noPublish) input.publish = false;
    const result = await recordConversation(config, input);
    print({
      saved: result.saved.changed,
      title: result.record.title,
      file: result.wiki.root.localPath,
      pages: result.wiki.counts,
      publish: result.publish || null,
    });
    return;
  }
  if (command === 'publish') {
    const { wiki, result } = await publishConversationWikiNow(config, { force: options.force });
    print({
      ok: result.ok,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      pages: wiki.counts,
      error: result.error || null,
      rootUrl: result.state?.root?.url || '',
    });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
