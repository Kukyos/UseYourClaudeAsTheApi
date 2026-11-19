// Shared pipeline for both API formats: normalized request -> Claude Code run ->
// text chunks + a final result with any emulated tool calls parsed out.

import { runClaude } from './claude.js';
import { buildClaudeInput, resolveModel } from './prompt.js';
import { ToolCallFilter, parseToolCalls } from './tools.js';

/**
 * Yields { type: 'text', text } chunks, then one
 * { type: 'done', text, calls, stopReason, usage, model, costUsd, durationMs }.
 * Concatenating the text chunks always equals done.text.
 */
export async function* complete(req, config, signal) {
  const { content, system } = await buildClaudeInput(req);
  const useTools = req.toolChoice !== 'none' && req.tools?.length > 0;
  const filter = useTools ? new ToolCallFilter() : null;
  let emitted = '';

  for await (const ev of runClaude({
    content,
    system,
    model: resolveModel(req.model, config),
    effort: req.effort,
    jsonSchema: req.jsonSchema,
    signal,
    config,
  })) {
    if (ev.type === 'text') {
      const out = filter ? filter.push(ev.text) : ev.text;
      if (out) {
        emitted += out;
        yield { type: 'text', text: out };
      }
    } else if (ev.type === 'done') {
      let text = ev.text;
      let calls = [];
      if (useTools) ({ text, calls } = parseToolCalls(ev.text));
      // Anything not streamed yet (structured output, text held back by the tool
      // filter that turned out not to be a call) goes out before the final event.
      if (text.startsWith(emitted) && text.length > emitted.length) {
        yield { type: 'text', text: text.slice(emitted.length) };
      } else if (!text.startsWith(emitted)) {
        text = emitted;
      }
      yield { ...ev, text, calls, stopReason: calls.length ? 'tool_use' : ev.stopReason };
    }
  }
}

/** Runs to completion and returns the final event. */
export async function completeAll(req, config, signal) {
  let done;
  for await (const ev of complete(req, config, signal)) if (ev.type === 'done') done = ev;
  return done;
}

/** A simple FIFO concurrency limiter. */
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < max && queue.length) {
      const item = queue.shift();
      if (item.signal?.aborted) {
        item.reject(new Error('aborted'));
        continue;
      }
      active++;
      item.resolve();
    }
  };
  return {
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
    acquire(signal) {
      return new Promise((resolve, reject) => {
        queue.push({ resolve, reject, signal });
        next();
      });
    },
    release() {
      active--;
      next();
    },
  };
}
