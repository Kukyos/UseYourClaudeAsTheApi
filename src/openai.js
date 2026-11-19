// POST /v1/chat/completions: OpenAI Chat Completions API, streaming and non-streaming.

import { fromOpenAI } from './prompt.js';
import { newId } from './tools.js';

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

const OPENAI_ERROR_TYPES = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  429: 'rate_limit_exceeded',
  504: 'timeout',
};

export function openaiError(res, err) {
  const status = err.status === 499 ? 400 : err.status || 500;
  const body = { error: { message: err.message, type: OPENAI_ERROR_TYPES[status] || 'api_error', code: err.type || null, param: null } };
  if (!res.headersSent) {
    const headers = { 'content-type': 'application/json' };
    if (err.retryAfter) headers['retry-after'] = String(err.retryAfter);
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  } else if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
    res.end();
  }
}

function usage(u) {
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens,
    total_tokens: prompt + u.output_tokens,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens },
  };
}

function toolCalls(calls) {
  return calls.map((c) => ({ id: newId('call_'), type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } }));
}

export async function handleChatCompletions(body, res, ctx) {
  const req = fromOpenAI(body);
  const id = newId('chatcmpl-');
  const created = Math.floor(Date.now() / 1000);

  if (!req.stream) {
    const done = await ctx.run(req, async (events) => {
      let last;
      for await (const ev of events) if (ev.type === 'done') last = ev;
      return last;
    });
    const message = { role: 'assistant', content: done.text || (done.calls.length ? null : ''), refusal: null };
    if (done.calls.length) message.tool_calls = toolCalls(done.calls);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id,
      object: 'chat.completion',
      created,
      model: done.model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: FINISH[done.stopReason] || 'stop' }],
      usage: usage(done.usage),
    }));
    return done;
  }

  return ctx.run(req, async (events) => {
    let started = false;
    let model = req.model || 'claude';
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
      ...extra,
    })}\n\n`);
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      chunk({ role: 'assistant', content: '' });
    };
    let done;
    for await (const ev of events) {
      if (ev.type === 'text') {
        start();
        chunk({ content: ev.text });
      } else if (ev.type === 'done') {
        done = ev;
        model = ev.model;
        start();
        const calls = toolCalls(ev.calls);
        if (calls.length) {
          chunk({ tool_calls: calls.map((c, index) => ({ index, ...c })) });
        }
        chunk({}, FINISH[ev.stopReason] || 'stop');
        if (req.includeUsage) {
          res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usage(ev.usage) })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
    return done;
  });
}
