// POST /v1/messages: Anthropic Messages API, streaming and non-streaming.

import { fromAnthropic } from './prompt.js';
import { newId } from './tools.js';

export function anthropicError(res, err) {
  const status = err.status || 500;
  const body = { type: 'error', error: { type: err.type || 'api_error', message: err.message } };
  if (!res.headersSent) {
    const headers = { 'content-type': 'application/json' };
    if (err.retryAfter) headers['retry-after'] = String(err.retryAfter);
    res.writeHead(status === 499 ? 400 : status, headers);
    res.end(JSON.stringify(body));
  } else if (!res.writableEnded) {
    res.write(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
    res.end();
  }
}

function toolBlocks(calls) {
  return calls.map((c) => ({ type: 'tool_use', id: newId('toolu_'), name: c.name, input: c.input }));
}

export async function handleMessages(body, res, ctx) {
  const req = fromAnthropic(body);
  const id = newId('msg_');

  if (!req.stream) {
    const done = await ctx.run(req, async (events) => {
      let last;
      for await (const ev of events) if (ev.type === 'done') last = ev;
      return last;
    });
    const content = [];
    if (done.text) content.push({ type: 'text', text: done.text });
    content.push(...toolBlocks(done.calls));
    if (!content.length) content.push({ type: 'text', text: '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id,
      type: 'message',
      role: 'assistant',
      model: done.model,
      content,
      stop_reason: done.stopReason,
      stop_sequence: null,
      usage: done.usage,
    }));
    return done;
  }

  // Streaming: headers wait for the first event, so errors that happen before
  // any output (rate limits, auth) still get a proper HTTP status.
  return ctx.run(req, async (events) => {
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let started = false;
    let textOpen = false;
    let index = 0;
    const start = (model) => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      send('message_start', {
        type: 'message_start',
        message: {
          id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    };
    let done;
    for await (const ev of events) {
      if (ev.type === 'text') {
        start(req.model || 'claude');
        if (!textOpen) {
          textOpen = true;
          send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        }
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: ev.text } });
      } else if (ev.type === 'done') {
        done = ev;
        start(ev.model);
        if (textOpen) {
          send('content_block_stop', { type: 'content_block_stop', index });
          index++;
        }
        for (const block of toolBlocks(ev.calls)) {
          send('content_block_start', { type: 'content_block_start', index, content_block: { ...block, input: {} } });
          send('content_block_delta', {
            type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
          });
          send('content_block_stop', { type: 'content_block_stop', index });
          index++;
        }
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: ev.stopReason, stop_sequence: null },
          usage: ev.usage,
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
      }
    }
    return done;
  });
}

/** Rough token estimate (about 4 characters per token) for /v1/messages/count_tokens. */
export function handleCountTokens(body, res) {
  const req = fromAnthropic(body);
  let chars = (req.system || '').length;
  for (const m of req.messages) {
    for (const b of m.content) {
      if (b.type === 'text') chars += b.text.length;
      else if (b.type === 'image') chars += 6000;
      else chars += JSON.stringify(b).length;
    }
  }
  for (const t of req.tools) chars += JSON.stringify(t).length;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ input_tokens: Math.ceil(chars / 4) }));
}
