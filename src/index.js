// Library entry point. Use these to call Claude from Node without running the server.
//
//   import { ask, stream, askJson } from 'use-your-claude';
//   const reply = await ask('Write a haiku about rain', { model: 'sonnet' });

import { runClaude, runClaudeToCompletion } from './claude.js';

function contentFor(prompt, images = []) {
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType || 'image/png', data: Buffer.isBuffer(img.data) ? img.data.toString('base64') : img.data },
  }));
  content.push({ type: 'text', text: prompt });
  return content;
}

/**
 * @typedef {object} AskOptions
 * @property {string} [system]   System prompt.
 * @property {string} [model]    'opus' | 'sonnet' | 'haiku' or a full model id.
 * @property {string} [effort]   'low' | 'medium' | 'high' | 'xhigh' | 'max'
 * @property {{data: Buffer|string, mediaType?: string}[]} [images]
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 */

/** Send one prompt and resolve with the reply text. @param {string} prompt @param {AskOptions} [opts] */
export async function ask(prompt, opts = {}) {
  const done = await runClaudeToCompletion({ ...opts, content: contentFor(prompt, opts.images), config: { timeoutMs: opts.timeoutMs ?? 600000, claudeBin: opts.claudeBin } });
  return done.text;
}

/** Stream the reply as text chunks. @param {string} prompt @param {AskOptions} [opts] */
export async function* stream(prompt, opts = {}) {
  for await (const ev of runClaude({ ...opts, content: contentFor(prompt, opts.images), config: { timeoutMs: opts.timeoutMs ?? 600000, claudeBin: opts.claudeBin } })) {
    if (ev.type === 'text') yield ev.text;
  }
}

/** Get structured output that matches a JSON schema, already parsed. */
export async function askJson(prompt, schema, opts = {}) {
  const done = await runClaudeToCompletion({ ...opts, jsonSchema: schema, content: contentFor(prompt, opts.images), config: { timeoutMs: opts.timeoutMs ?? 600000, claudeBin: opts.claudeBin } });
  return done.structured;
}

export { runClaude, ClaudeError } from './claude.js';
export { createBridge } from './server.js';
