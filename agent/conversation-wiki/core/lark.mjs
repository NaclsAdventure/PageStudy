/** 安全地调用 lark-cli：Windows 的 .cmd 通过其 Node 入口执行，避免 shell 拼接。 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';

let cachedLauncher = null;

function cliCommand() {
  return process.env.LARK_CLI || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
}

function resolveLauncher() {
  if (cachedLauncher) return cachedLauncher;
  let cli = cliCommand();
  if (process.platform === 'win32' && !path.isAbsolute(cli)) {
    try {
      const found = execFileSync('where.exe', [cli], {
        encoding: 'utf8',
        windowsHide: true,
      })
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (found) cli = found;
    } catch {
      // 保持原值，让 spawn 给出可诊断的错误。
    }
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    const nodeEntry = path.join(
      path.dirname(cli),
      'node_modules',
      '@larksuite',
      'cli',
      'scripts',
      'run.js',
    );
    if (existsSync(nodeEntry)) {
      cachedLauncher = { command: process.execPath, prefix: [nodeEntry] };
      return cachedLauncher;
    }
  }
  cachedLauncher = { command: cli, prefix: [] };
  return cachedLauncher;
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * @param {string[]} args lark-cli 参数
 * @param {string} cwd 工作目录（文档内容文件必须在此目录下）
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string>} stdout
 */
export function runLark(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const launcher = resolveLauncher();
    const child = spawn(launcher.command, [...launcher.prefix, ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = Math.max(10_000, Math.min(300_000, Number(options.timeoutMs) || 180_000));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 12 * 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 2 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 lark-cli：${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`lark-cli 执行超时（${Math.round(timeoutMs / 1000)} 秒）。`));
        return;
      }
      if (code !== 0) {
        const parsed = parseJsonObject(stdout);
        const message =
          parsed?.error?.message || parsed?.message || stderr.trim() || `lark-cli 退出码 ${code}`;
        reject(new Error(String(message).slice(0, 1200)));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function larkVersion() {
  try {
    const output = await runLark(['--version'], process.cwd(), { timeoutMs: 20_000 });
    return { ok: true, version: output.trim().slice(0, 200) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
