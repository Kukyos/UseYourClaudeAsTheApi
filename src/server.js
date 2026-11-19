// The HTTP server: routing, auth, CORS, request limits and logging.

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getCapabilities, ClaudeError } from './claude.js';
import { complete, createLimiter } from './engine.js';
import { handleMessages, handleCountTokens, anthropicError } from './anthropic.js';
import { handleChatCompletions, openaiError } from './openai.js';

const MAX_BODY = 60 * 1024 * 1024;

export const MODELS = [
  ['claude-opus', 'Latest Opus (Claude Code alias "opus")'],
  ['claude-sonnet', 'Latest Sonnet (Claude Code alias "sonnet")'],
  ['claude-haiku', 'Latest Haiku (Claude Code alias "haiku")'],
  ['default', 'Your Claude Code default model'],
];

const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

function isLoopbackBind(host) {
  return !host || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ClaudeError('Request body is larger than 60MB', { status: 413, type: 'request_too_large' }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function providedKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return req.headers['x-api-key'] || req.headers['api-key'] || '';
}

export function createBridge(config) {
  const limiter = createLimiter(config.concurrency || 3);
  const log = (...a) => !config.quiet && console.log(new Date().toISOString().slice(11, 19), ...a);

  const corsOrigin = (origin) => {
    if (!origin) return null;
    if (config.cors === '*') return '*';
    if (config.cors) return config.cors.split(',').map((s) => s.trim()).includes(origin) ? origin : null;
    return LOCAL_ORIGIN.test(origin) ? origin : null;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const isOpenAI = path.includes('/chat/completions');
    const fail = (err) => (isOpenAI ? openaiError(res, err) : anthropicError(res, err));

    // A local server can be reached by any web page you visit. Refuse requests whose
    // Host header is not local (DNS rebinding) when bound to loopback.
    if (isLoopbackBind(config.host) && req.headers.host && !LOOPBACK_HOST.test(req.headers.host)) {
      return fail(new ClaudeError('Host not allowed', { status: 403, type: 'permission_error' }));
    }

    const origin = corsOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', '*');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    } else if (req.headers.origin) {
      return fail(new ClaudeError(`Origin ${req.headers.origin} is not allowed. Start the bridge with --cors to allow it.`, { status: 403, type: 'permission_error' }));
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (config.apiKey && path !== '/health' && !safeEqual(providedKey(req), config.apiKey)) {
      return fail(new ClaudeError('Invalid API key for this use-your-claude bridge.', { status: 401, type: 'authentication_error' }));
    }

    try {
      if (req.method === 'GET' && (path === '/' || path === '/health')) {
        const caps = await getCapabilities(config).catch((e) => ({ error: e.message }));
        return json(res, caps.error ? 500 : 200, {
          ok: !caps.error,
          service: 'use-your-claude',
          claude_code: caps.version,
          error: caps.error,
          active: limiter.active,
          queued: limiter.queued,
          endpoints: ['POST /v1/messages', 'POST /v1/chat/completions', 'GET /v1/models'],
        });
      }
      if (req.method === 'GET' && path.endsWith('/models')) {
        const data = MODELS.map(([id, display]) => ({ id, object: 'model', type: 'model', display_name: display, created: 0, created_at: '2025-01-01T00:00:00Z', owned_by: 'anthropic' }));
        return json(res, 200, { object: 'list', data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id });
      }
      if (req.method !== 'POST') return fail(new ClaudeError(`Not found: ${req.method} ${path}`, { status: 404, type: 'not_found_error' }));

      const ctype = String(req.headers['content-type'] || '');
      // Requiring JSON forces browsers to send a CORS preflight, which blocks cross-site form posts.
      if (!ctype.includes('application/json')) {
        return fail(new ClaudeError('Content-Type must be application/json', { status: 415, type: 'invalid_request_error' }));
      }
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        if (err instanceof ClaudeError) throw err;
        throw new ClaudeError('Request body is not valid JSON', { status: 400, type: 'invalid_request_error' });
      }

      const ctx = { run: (normReq, consume) => runRequest(normReq, consume, req, res, path) };
      if (path.endsWith('/messages/count_tokens')) return handleCountTokens(body, res);
      if (path.endsWith('/messages')) return await handleMessages(body, res, ctx);
      if (path.endsWith('/chat/completions')) return await handleChatCompletions(body, res, ctx);
      return fail(new ClaudeError(`Not found: POST ${path}`, { status: 404, type: 'not_found_error' }));
    } catch (err) {
      if (!(err instanceof ClaudeError)) {
        console.error(err);
        err = new ClaudeError(err.message || 'Internal error', { status: 500 });
      }
      if (err.status !== 499) log(`✗ ${path} ${err.status} ${err.message.split('\n')[0]}`);
      fail(err);
    }
  });

  async function runRequest(normReq, consume, req, res, path) {
    const controller = new AbortController();
    const onClose = () => !res.writableEnded && controller.abort();
    res.on('close', onClose);
    try {
      await limiter.acquire(controller.signal);
    } catch {
      throw new ClaudeError('Request aborted by client.', { status: 499 });
    }
    const t0 = Date.now();
    try {
      const done = await consume(complete(normReq, config, controller.signal));
      if (done) {
        const u = done.usage;
        log(`✓ ${path} ${done.model} ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
          `in=${u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens} out=${u.output_tokens}` +
          (done.calls?.length ? ` tool_calls=${done.calls.length}` : '') + (normReq.stream ? ' (stream)' : ''));
      }
      return done;
    } finally {
      res.off('close', onClose);
      limiter.release();
    }
  }

  return { server, limiter };
}
