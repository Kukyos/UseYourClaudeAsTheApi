// Runs one headless Claude Code turn (`claude -p`) and turns its stream-json
// output into a small stream of events: { type: 'text', text } chunks followed
// by a single { type: 'done', ... } summary. Errors are thrown as ClaudeError.

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

export const DEFAULT_SYSTEM_PROMPT = 'You are Claude, an AI assistant made by Anthropic.';

export class ClaudeError extends Error {
  constructor(message, { status = 502, type = 'api_error', retryAfter } = {}) {
    super(message);
    this.name = 'ClaudeError';
    this.status = status;
    this.type = type;
    this.retryAfter = retryAfter;
  }
}

/** Map an error message from Claude Code to an HTTP status + Anthropic error type. */
export function classifyError(message) {
  const m = String(message || '');
  if (/usage limit|rate.?limit|limit reached|hit your limit|too many requests|\b429\b/i.test(m)) {
    return { status: 429, type: 'rate_limit_error' };
  }
  if (/not logged in|please run \/login|log ?in|authenticat|unauthori[sz]ed|\b401\b|invalid api key|oauth|credential/i.test(m)) {
    return { status: 401, type: 'authentication_error' };
  }
  if (/overloaded|\b529\b/i.test(m)) return { status: 529, type: 'overloaded_error' };
  return { status: 502, type: 'api_error' };
}

// ---------------------------------------------------------------------------
// Locating the `claude` binary
// ---------------------------------------------------------------------------

function findOnPath(names) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Returns { command, prefixArgs } for spawning Claude Code without a shell.
 * On Windows, npm installs only put a `claude.cmd` shim on PATH, which cannot be
 * spawned without a shell, so we look through it for the real executable.
 */
export function resolveClaudeCommand(explicit) {
  if (explicit) {
    if (/\.(c|m)?js$/i.test(explicit)) return { command: process.execPath, prefixArgs: [explicit] };
    return { command: explicit, prefixArgs: [] };
  }
  if (process.platform !== 'win32') return { command: 'claude', prefixArgs: [] };

  const exe = findOnPath(['claude.exe']);
  if (exe) return { command: exe, prefixArgs: [] };
  const shim = findOnPath(['claude.cmd']);
  if (shim) {
    const pkg = join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code');
    const nativeExe = join(pkg, 'bin', 'claude.exe');
    if (existsSync(nativeExe)) return { command: nativeExe, prefixArgs: [] };
    const cli = join(pkg, 'cli.js');
    if (existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
  }
  const local = join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');
  if (existsSync(local)) return { command: local, prefixArgs: [] };
  return { command: 'claude.exe', prefixArgs: [] };
}

function run(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout))));
  });
}

const capabilityCache = new Map();

/** Reads `claude --version` and `claude --help` once to learn which flags exist. */
export async function getCapabilities(config = {}) {
  const { command, prefixArgs } = resolveClaudeCommand(config.claudeBin);
  const key = [command, ...prefixArgs].join(' ');
  if (capabilityCache.has(key)) return capabilityCache.get(key);
  const promise = (async () => {
    let version = 'unknown';
    let help = '';
    try {
      version = (await run(command, [...prefixArgs, '--version'])).replace(/\(Claude Code\)/i, '').trim();
      help = await run(command, [...prefixArgs, '--help']);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new ClaudeError(
          'Claude Code CLI not found. Install it (https://code.claude.com/docs/en/setup), run `claude` once to log in, ' +
            'or point CLAUDE_BIN at the binary.',
          { status: 500, type: 'api_error' },
        );
      }
      throw new ClaudeError(`Could not run the Claude Code CLI: ${err.message}`, { status: 500 });
    }
    const has = (flag) => help.includes(flag);
    const caps = {
      command,
      prefixArgs,
      version,
      tools: has('--tools '),
      safeMode: has('--safe-mode'),
      strictMcp: has('--strict-mcp-config'),
      disableSlash: has('--disable-slash-commands'),
      noPersist: has('--no-session-persistence'),
      partial: has('--include-partial-messages'),
      jsonSchema: has('--json-schema'),
      effort: has('--effort'),
      streamInput: has('stream-json'),
    };
    if (!caps.tools || !caps.streamInput) {
      throw new ClaudeError(
        `Claude Code ${version} is too old for use-your-claude. Run \`claude update\` and try again.`,
        { status: 500 },
      );
    }
    return caps;
  })();
  capabilityCache.set(key, promise);
  promise.catch(() => capabilityCache.delete(key));
  return promise;
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

let workdir;
/** An empty directory to run Claude in, so no project CLAUDE.md or settings leak in. */
function getWorkdir() {
  if (!workdir) {
    workdir = join(tmpdir(), 'use-your-claude-workdir');
    mkdirSync(workdir, { recursive: true });
  }
  return workdir;
}

function isSelfUrl(url, config) {
  if (!url || !config.port) return false;
  try {
    const u = new URL(url);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return port === Number(config.port) && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/.test(u.hostname);
  } catch {
    return false;
  }
}

function childEnv(config) {
  const env = { ...process.env };
  // Claude Code prefers ANTHROPIC_API_KEY over your subscription login when it is set.
  // Remove it so requests are always billed to the subscription.
  if (!config.allowApiKey) delete env.ANTHROPIC_API_KEY;
  // If this shell points the Anthropic SDK at the bridge itself, the CLI must not follow
  // it, or every request would loop back into the bridge.
  if (isSelfUrl(env.ANTHROPIC_BASE_URL, config)) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  // Lets the bridge be started from inside a Claude Code terminal.
  delete env.CLAUDECODE;
  env.USE_YOUR_CLAUDE_CHILD = '1';
  return env;
}

/**
 * Run one request through headless Claude Code.
 *
 * @param {object} opts
 * @param {Array}  opts.content     Anthropic-style user content blocks (text/image/document).
 * @param {string} [opts.system]    System prompt (replaces Claude Code's agent prompt).
 * @param {string} [opts.model]     Model alias or full id passed to --model.
 * @param {string} [opts.effort]    low | medium | high | xhigh | max
 * @param {object} [opts.jsonSchema] JSON schema for structured output (--json-schema).
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.config]    Bridge config (claudeBin, timeoutMs, allowApiKey, port, verbose).
 */
export async function* runClaude(opts) {
  const config = opts.config || {};
  const caps = await getCapabilities(config);
  const system = opts.system && opts.system.trim() ? opts.system : config.defaultSystem || DEFAULT_SYSTEM_PROMPT;

  const args = [
    ...caps.prefixArgs,
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
  ];
  if (caps.partial) args.push('--include-partial-messages');
  if (caps.noPersist) args.push('--no-session-persistence');
  if (caps.safeMode) args.push('--safe-mode');
  else {
    if (caps.strictMcp) args.push('--strict-mcp-config');
    if (caps.disableSlash) args.push('--disable-slash-commands');
  }

  let tempDir;
  // Very long system prompts go through a file to stay under OS argument limits.
  if (system.length > 16000) {
    tempDir = mkdtempSync(join(tmpdir(), 'use-your-claude-'));
    const file = join(tempDir, 'system.txt');
    writeFileSync(file, system);
    args.push('--system-prompt-file', file);
  } else {
    args.push('--system-prompt', system);
  }
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort && caps.effort) args.push('--effort', opts.effort);
  if (opts.jsonSchema) {
    if (!caps.jsonSchema) {
      throw new ClaudeError(`Claude Code ${caps.version} does not support --json-schema. Run \`claude update\`.`, { status: 400, type: 'invalid_request_error' });
    }
    args.push('--json-schema', JSON.stringify(opts.jsonSchema));
  }

  const child = spawn(caps.command, args, {
    cwd: getWorkdir(),
    env: childEnv(config),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ code: null, error: err }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  let killedReason = null;
  const kill = (reason) => {
    if (killedReason || child.exitCode !== null) return;
    killedReason = reason;
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
  };
  const onAbort = () => kill('aborted');
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = config.timeoutMs ? setTimeout(() => kill('timeout'), config.timeoutMs) : null;
  timer?.unref?.();

  child.stdin.on('error', () => {}); // child may exit before reading stdin
  child.stdin.end(JSON.stringify({
    type: 'user',
    message: { role: 'user', content: opts.content },
    parent_tool_use_id: null,
    session_id: '',
  }) + '\n');

  let text = '';
  let sawDelta = false;
  let model = opts.model || null;
  let result = null;
  let rateLimit = null;
  let finished = false;

  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (config.verbose) process.stderr.write(`[claude] ${line.slice(0, 300)}\n`);
      if (msg.parent_tool_use_id) continue;

      if (msg.type === 'system' && msg.subtype === 'init') {
        model = msg.model || model;
      } else if (msg.type === 'stream_event') {
        const ev = msg.event || {};
        if (ev.type === 'message_start' && ev.message?.model) model = ev.message.model;
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          sawDelta = true;
          text += ev.delta.text;
          if (!opts.jsonSchema) yield { type: 'text', text: ev.delta.text };
        }
      } else if (msg.type === 'assistant') {
        if (msg.message?.model) model = msg.message.model;
        if (!sawDelta) {
          for (const block of msg.message?.content || []) {
            if (block.type === 'text' && block.text) {
              text += block.text;
              if (!opts.jsonSchema) yield { type: 'text', text: block.text };
            }
          }
        }
      } else if (msg.type === 'rate_limit_event') {
        if (msg.rate_limit_info?.status === 'rejected') rateLimit = msg.rate_limit_info;
      } else if (msg.type === 'result') {
        result = msg;
      }
    }

    const exit = await exited;
    if (killedReason === 'aborted') throw new ClaudeError('Request aborted by client.', { status: 499 });
    if (killedReason === 'timeout') {
      throw new ClaudeError(`Claude Code did not finish within ${Math.round(config.timeoutMs / 1000)}s.`, { status: 504, type: 'timeout_error' });
    }
    if (exit.error) throw new ClaudeError(`Could not start Claude Code: ${exit.error.message}`, { status: 500 });

    const retryAfter = rateLimit?.resetsAt ? Math.max(1, Math.round(rateLimit.resetsAt - Date.now() / 1000)) : undefined;
    if (!result) {
      const detail = stderr.trim().split('\n').slice(-5).join('\n') || `claude exited with code ${exit.code}`;
      const cls = classifyError(detail);
      throw new ClaudeError(withLoginHint(detail, cls), { ...cls, retryAfter });
    }
    if (result.is_error || (result.subtype && result.subtype !== 'success')) {
      const detail = (typeof result.result === 'string' && result.result) ||
        (Array.isArray(result.errors) && result.errors.join('; ')) || `Claude Code returned ${result.subtype}`;
      const cls = rateLimit ? { status: 429, type: 'rate_limit_error' } : classifyError(detail);
      throw new ClaudeError(withLoginHint(detail, cls), { ...cls, retryAfter });
    }

    let structured = result.structured_output;
    let finalText = text || (typeof result.result === 'string' ? result.result : '');
    if (opts.jsonSchema) {
      if (structured === undefined) {
        try {
          structured = JSON.parse(result.result);
        } catch {
          /* leave undefined */
        }
      }
      finalText = structured !== undefined ? JSON.stringify(structured) : finalText;
    }

    finished = true;
    yield {
      type: 'done',
      text: finalText,
      structured,
      model: model || Object.keys(result.modelUsage || {})[0] || 'claude',
      stopReason: result.stop_reason || 'end_turn',
      usage: normalizeUsage(result.usage),
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
    };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
    if (!finished) kill('aborted');
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLoginHint(detail, cls) {
  if (cls.status !== 401) return detail;
  return `${detail}\n\nClaude Code is not logged in to your subscription. Run \`claude\` and use /login, ` +
    'or run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for headless machines.';
}

function normalizeUsage(u = {}) {
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
  };
}

/** Convenience: run a turn and return only the final `done` event. */
export async function runClaudeToCompletion(opts) {
  let done;
  for await (const ev of runClaude(opts)) if (ev.type === 'done') done = ev;
  return done;
}
