import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../src/server.js';
import { parseToolCalls, ToolCallFilter } from '../src/tools.js';
import { resolveModel, fromOpenAI } from '../src/prompt.js';

const fake = fileURLToPath(new URL('./fake-claude.js', import.meta.url));
const logDir = mkdtempSync(join(tmpdir(), 'use-your-claude-test-'));
const logFile = join(logDir, 'calls.jsonl');
process.env.FAKE_CLAUDE_LOG = logFile;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-removed';

let server;
let base;
const config = { claudeBin: fake, concurrency: 2, quiet: true, timeoutMs: 20000 };

before(async () => {
  ({ server } = createBridge(config));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  config.port = server.address().port;
  base = `http://127.0.0.1:${config.port}`;
});
after(() => {
  server.close();
  rmSync(logDir, { recursive: true, force: true });
});

const post = (path, body, headers = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const lastCall = () => JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop());

async function sse(res) {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((chunk) => {
    const data = chunk.split('\n').find((l) => l.startsWith('data: '))?.slice(6);
    const event = chunk.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

test('anthropic: basic message', async () => {
  const res = await post('/v1/messages', { model: 'claude-haiku-4-5', max_tokens: 100, system: 'Be brief.', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(body.content[0].text, 'Echo: hello');
  assert.equal(body.stop_reason, 'end_turn');
  assert.equal(body.usage.output_tokens, 7);
  const call = lastCall();
  assert.equal(call.args[call.args.indexOf('--system-prompt') + 1], 'Be brief.');
  assert.equal(call.args[call.args.indexOf('--model') + 1], 'claude-haiku-4-5');
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(call.args.includes('--safe-mode'));
  assert.equal(call.apiKey, null, 'ANTHROPIC_API_KEY must not reach Claude Code');
});

test('anthropic: streaming events', async () => {
  const res = await post('/v1/messages', { model: 'claude-sonnet', stream: true, messages: [{ role: 'user', content: 'hi there' }] });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const events = await sse(res);
  assert.deepEqual(events.map((e) => e.event), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const text = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'Echo: hi there');
  assert.equal(lastCall().args[lastCall().args.indexOf('--model') + 1], 'sonnet');
});

test('anthropic: multi-turn becomes a transcript', async () => {
  const res = await post('/v1/messages', {
    model: 'x',
    messages: [
      { role: 'user', content: 'My name is Ada.' },
      { role: 'assistant', content: 'Nice to meet you, Ada.' },
      { role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
    ],
  });
  assert.equal(res.status, 200);
  const call = lastCall();
  const prompt = call.content.at(-1).text;
  assert.match(prompt, /<turn role="user">\nMy name is Ada\.\n<\/turn>/);
  assert.match(prompt, /<turn role="assistant">\nNice to meet you, Ada\.\n<\/turn>/);
  assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /Conversation format/);
  assert.ok(!call.args.includes('--model'), 'unknown model names fall back to the Claude Code default');
});

test('anthropic: images are passed through', async () => {
  const res = await post('/v1/messages', {
    model: 'claude-opus',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
      { type: 'text', text: 'what is this' },
    ] }],
  });
  const body = await res.json();
  assert.equal(body.content[0].text, 'Echo: what is this [1 image(s)]');
  assert.equal(lastCall().content[0].type, 'image');
});

test('anthropic: emulated tool use, non-streaming', async () => {
  const tools = [{ name: 'get_weather', description: 'Weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];
  const res = await post('/v1/messages', { model: 'claude-sonnet', tools, messages: [{ role: 'user', content: 'TOOL weather in Paris?' }] });
  const body = await res.json();
  assert.equal(body.stop_reason, 'tool_use');
  assert.equal(body.content[0].text, 'Let me check the weather.');
  assert.equal(body.content[1].type, 'tool_use');
  assert.equal(body.content[1].name, 'get_weather');
  assert.deepEqual(body.content[1].input, { city: 'Paris' });
  assert.match(body.content[1].id, /^toolu_/);
  assert.match(lastCall().args[lastCall().args.indexOf('--system-prompt') + 1], /<tools>/);

  // Send the tool result back.
  const res2 = await post('/v1/messages', {
    model: 'claude-sonnet',
    tools,
    messages: [
      { role: 'user', content: 'weather in Paris?' },
      { role: 'assistant', content: body.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: body.content[1].id, content: '18C and sunny' }] },
    ],
  });
  assert.equal(res2.status, 200);
  const prompt = lastCall().content.at(-1).text;
  assert.match(prompt, /<tool_call>\{"name":"get_weather","input":\{"city":"Paris"\}\}<\/tool_call>/);
  assert.match(prompt, /<tool_result name="get_weather">\n18C and sunny\n<\/tool_result>/);
});

test('anthropic: emulated tool use, streaming never leaks the tag', async () => {
  const tools = [{ name: 'get_weather', input_schema: { type: 'object' } }];
  const res = await post('/v1/messages', { model: 'claude-sonnet', stream: true, tools, messages: [{ role: 'user', content: 'TOOL' }] });
  const events = await sse(res);
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'Let me check the weather.');
  const toolStart = events.find((e) => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
  assert.equal(toolStart.data.content_block.name, 'get_weather');
  const json = events.find((e) => e.data.delta?.type === 'input_json_delta').data.delta.partial_json;
  assert.deepEqual(JSON.parse(json), { city: 'Paris' });
  assert.equal(events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'tool_use');
});

test('tool filter releases a "<tool" that is not a tag', async () => {
  const res = await post('/v1/messages', { model: 'claude-sonnet', stream: true, tools: [{ name: 't', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'ANGLE' }] });
  const events = await sse(res);
  const text = events.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
  assert.equal(text, 'a < b and <toolbox> is fine');
});

test('anthropic: structured output via output_format', async () => {
  const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } };
  const res = await post('/v1/messages', { model: 'claude-sonnet', output_format: { type: 'json_schema', schema }, messages: [{ role: 'user', content: 'a person' }] });
  const body = await res.json();
  assert.deepEqual(JSON.parse(body.content[0].text), { name: 'Ada', age: 36 });
  assert.deepEqual(JSON.parse(lastCall().args[lastCall().args.indexOf('--json-schema') + 1]), schema);
});

test('rate limits become HTTP 429 with retry-after', async () => {
  const res = await post('/v1/messages', { model: 'claude-sonnet', stream: true, messages: [{ role: 'user', content: 'RATELIMIT' }] });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  const body = await res.json();
  assert.equal(body.error.type, 'rate_limit_error');
});

test('not logged in becomes HTTP 401 with a hint', async () => {
  const res = await post('/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'NOLOGIN' }] });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.match(body.error.message, /\/login/);
});

test('openai: basic and streaming chat completion', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'system', content: 'Sys.' }, { role: 'user', content: 'yo' }],
  });
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Echo: yo');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.prompt_tokens, 18);
  assert.equal(lastCall().args[lastCall().args.indexOf('--system-prompt') + 1], 'Sys.');

  const res2 = await post('/v1/chat/completions', { model: 'claude-haiku', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'yo' }] });
  const events = await sse(res2);
  assert.equal(events.at(-1).data, '[DONE]');
  const text = events.slice(0, -1).map((e) => e.data.choices[0]?.delta?.content || '').join('');
  assert.equal(text, 'Echo: yo');
  assert.equal(events.at(-2).data.usage.completion_tokens, 7);
  assert.equal(events.at(-3).data.choices[0].finish_reason, 'stop');
});

test('openai: tool calls round trip', async () => {
  const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const res = await post('/v1/chat/completions', { model: 'gpt-4o', tools, messages: [{ role: 'user', content: 'TOOL' }] });
  const body = await res.json();
  const msg = body.choices[0].message;
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(msg.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { city: 'Paris' });

  const res2 = await post('/v1/chat/completions', {
    model: 'gpt-4o',
    tools,
    messages: [
      { role: 'user', content: 'weather?' },
      msg,
      { role: 'tool', tool_call_id: msg.tool_calls[0].id, content: '18C' },
    ],
  });
  assert.equal(res2.status, 200);
  assert.match(lastCall().content.at(-1).text, /<tool_result name="get_weather">\n18C\n<\/tool_result>/);
});

test('openai: response_format json_schema', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'gpt-4o',
    response_format: { type: 'json_schema', json_schema: { name: 'p', schema: { type: 'object' } } },
    messages: [{ role: 'user', content: 'person' }],
  });
  const body = await res.json();
  assert.deepEqual(JSON.parse(body.choices[0].message.content), { name: 'Ada', age: 36 });
});

test('openai: data-URL images become base64 blocks', () => {
  const req = fromOpenAI({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }, { type: 'text', text: 'x' }] }] });
  assert.deepEqual(req.messages[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
});

test('api key is enforced when configured', async () => {
  config.apiKey = 'secret';
  try {
    const bad = await post('/v1/messages', { messages: [{ role: 'user', content: 'x' }] });
    assert.equal(bad.status, 401);
    const good = await post('/v1/messages', { messages: [{ role: 'user', content: 'x' }] }, { 'x-api-key': 'secret' });
    assert.equal(good.status, 200);
    const bearer = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'x' }] }, { authorization: 'Bearer secret' });
    assert.equal(bearer.status, 200);
  } finally {
    delete config.apiKey;
  }
});

test('browser safety: foreign origins, non-JSON bodies and foreign Host headers are refused', async () => {
  const foreign = await post('/v1/messages', { messages: [{ role: 'user', content: 'x' }] }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
  const local = await post('/v1/messages', { messages: [{ role: 'user', content: 'x' }] }, { origin: 'http://localhost:5173' });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const form = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(form.status, 415);
  const { request } = await import('node:http');
  const status = await new Promise((resolve) => {
    request({ host: '127.0.0.1', port: config.port, path: '/v1/models', headers: { host: 'evil.example' } }, (r) => resolve(r.statusCode)).end();
  });
  assert.equal(status, 403);
});

test('validation errors are 400', async () => {
  const res = await post('/v1/messages', { model: 'x', messages: [] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.type, 'invalid_request_error');
});

test('models and health endpoints', async () => {
  const models = await (await fetch(base + '/v1/models')).json();
  assert.ok(models.data.some((m) => m.id === 'claude-sonnet'));
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.ok, true);
  assert.equal(health.claude_code, '9.9.9');
});

test('client disconnect kills the Claude run', async () => {
  const controller = new AbortController();
  const p = post('/v1/messages', { model: 'claude-sonnet', messages: [{ role: 'user', content: 'SLOW' }] }).catch(() => {});
  void p;
  const p2 = fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'SLOW' }] }),
    signal: controller.signal,
  }).catch((e) => e);
  await new Promise((r) => setTimeout(r, 400));
  controller.abort();
  await p2;
  // The aborted run's slot is freed quickly, so a third request is not stuck behind it.
  const t0 = Date.now();
  const res = await post('/v1/messages', { model: 'claude-sonnet', messages: [{ role: 'user', content: 'quick' }] });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < 4000, 'slot should be released after abort');
  await p;
});

test('unit: parseToolCalls', () => {
  assert.deepEqual(parseToolCalls('just text'), { text: 'just text', calls: [] });
  const r = parseToolCalls('Sure.\n<tool_call>{"name":"a","input":{"x":1}}</tool_call>\n<tool_call>```json\n{"name":"b","arguments":"{\\"y\\":2}"}\n```</tool_call> trailing');
  assert.equal(r.text, 'Sure.');
  assert.deepEqual(r.calls, [{ name: 'a', input: { x: 1 } }, { name: 'b', input: { y: 2 } }]);
  assert.deepEqual(parseToolCalls('<tool_call>not json</tool_call>').calls, []);
  assert.deepEqual(parseToolCalls('<tool_call>{"name":"c","input":{}}').calls, [{ name: 'c', input: {} }]);
});

test('unit: ToolCallFilter', () => {
  const f = new ToolCallFilter();
  assert.equal(f.push('Hello <'), 'Hello');
  assert.equal(f.push('b>'), ' <b>');
  assert.equal(f.push(' ok <tool_'), ' ok');
  assert.equal(f.push('call>{...'), '');
  assert.equal(f.flush(), '');
});

test('unit: resolveModel', () => {
  assert.equal(resolveModel('claude-sonnet-4-5'), 'claude-sonnet-4-5');
  assert.equal(resolveModel('claude-opus'), 'opus');
  assert.equal(resolveModel('claude-haiku-latest'), 'haiku');
  assert.equal(resolveModel('sonnet'), 'sonnet');
  assert.equal(resolveModel('gpt-4o'), undefined);
  assert.equal(resolveModel('gpt-4o', { defaultModel: 'haiku' }), 'haiku');
  assert.equal(resolveModel('claude-opus', { forceModel: 'sonnet' }), 'sonnet');
});

test('the skill ships the same Python client as clients/python', () => {
  const a = readFileSync(new URL('../clients/python/claude_local.py', import.meta.url), 'utf8');
  const b = readFileSync(new URL('../skills/use-claude-as-api/claude_local.py', import.meta.url), 'utf8');
  assert.equal(a, b, 'run: cp clients/python/claude_local.py skills/use-claude-as-api/');
});
