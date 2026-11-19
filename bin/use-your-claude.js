#!/usr/bin/env node
// use-your-claude: run a local Anthropic/OpenAI-compatible API backed by your
// Claude subscription through headless Claude Code.

import { parseArgs } from 'node:util';
import { createBridge } from '../src/server.js';
import { getCapabilities, runClaudeToCompletion } from '../src/claude.js';

const HELP = `use-your-claude: use your Claude subscription (Pro/Max) as a local API.

Usage:
  use-your-claude [options]          Start the API server
  use-your-claude doctor             Check that Claude Code is installed and logged in
  use-your-claude ask "<prompt>"     Send one prompt and print the reply

Options (each also has an environment variable):
  -p, --port <n>          Port to listen on              USE_YOUR_CLAUDE_PORT   (default 8787)
      --host <addr>       Address to bind                USE_YOUR_CLAUDE_HOST   (default 127.0.0.1)
  -c, --concurrency <n>   Max Claude runs at once         USE_YOUR_CLAUDE_CONCURRENCY (default 3)
  -m, --model <name>      Model when a request names a non-Claude model, e.g. sonnet
                                                         USE_YOUR_CLAUDE_MODEL
      --force-model <m>   Use this model for every request USE_YOUR_CLAUDE_FORCE_MODEL
      --api-key <key>     Require this key from clients   USE_YOUR_CLAUDE_KEY
      --cors <origins>    Allowed browser origins, comma-separated, or "*"
                          (default: any http://localhost origin)  USE_YOUR_CLAUDE_CORS
      --timeout <sec>     Kill a request after this long  USE_YOUR_CLAUDE_TIMEOUT (default 600)
      --system <text>     Default system prompt           USE_YOUR_CLAUDE_SYSTEM
      --allow-api-key     Keep ANTHROPIC_API_KEY in Claude Code's environment
                          (by default it is removed so your subscription is used)
      --claude-bin <path> Path to the claude binary       CLAUDE_BIN
  -q, --quiet             No request logging
  -v, --verbose           Log raw Claude Code output
  -h, --help              Show this help

Then point any SDK at it:
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787   ANTHROPIC_API_KEY=anything
  OPENAI_BASE_URL=http://127.0.0.1:8787/v1   OPENAI_API_KEY=anything
`;

const env = process.env;
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', short: 'p', default: env.USE_YOUR_CLAUDE_PORT || env.PORT || '8787' },
    host: { type: 'string', default: env.USE_YOUR_CLAUDE_HOST || '127.0.0.1' },
    concurrency: { type: 'string', short: 'c', default: env.USE_YOUR_CLAUDE_CONCURRENCY || '3' },
    model: { type: 'string', short: 'm', default: env.USE_YOUR_CLAUDE_MODEL },
    'force-model': { type: 'string', default: env.USE_YOUR_CLAUDE_FORCE_MODEL },
    'api-key': { type: 'string', default: env.USE_YOUR_CLAUDE_KEY },
    cors: { type: 'string', default: env.USE_YOUR_CLAUDE_CORS },
    timeout: { type: 'string', default: env.USE_YOUR_CLAUDE_TIMEOUT || '600' },
    system: { type: 'string', default: env.USE_YOUR_CLAUDE_SYSTEM },
    'allow-api-key': { type: 'boolean', default: false },
    'claude-bin': { type: 'string', default: env.CLAUDE_BIN },
    quiet: { type: 'boolean', short: 'q', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const config = {
  port: Number(values.port),
  host: values.host,
  concurrency: Math.max(1, Number(values.concurrency) || 3),
  defaultModel: values.model,
  forceModel: values['force-model'],
  apiKey: values['api-key'],
  cors: values.cors,
  timeoutMs: Number(values.timeout) * 1000,
  defaultSystem: values.system,
  allowApiKey: values['allow-api-key'],
  claudeBin: values['claude-bin'],
  quiet: values.quiet,
  verbose: values.verbose,
};

const [command, ...rest] = positionals;

if (command === 'doctor') {
  await doctor();
} else if (command === 'ask') {
  await ask(rest.join(' '));
} else if (command && command !== 'serve' && command !== 'start') {
  console.error(`Unknown command "${command}".\n`);
  process.stdout.write(HELP);
  process.exit(1);
} else {
  serve();
}

function serve() {
  const { server } = createBridge(config);
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Try --port <another>.` : err.message);
    process.exit(1);
  });
  server.listen(config.port, config.host, async () => {
    const base = `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}`;
    let version = '?';
    try {
      version = (await getCapabilities(config)).version;
    } catch (err) {
      console.error(`\n⚠  ${err.message}\n`);
    }
    console.log(`use-your-claude listening on ${base}  (Claude Code ${version}, ${config.concurrency} at a time)

  Anthropic SDK:  ANTHROPIC_BASE_URL=${base}  ANTHROPIC_API_KEY=${config.apiKey ? '<your --api-key>' : 'anything'}
  OpenAI SDK:     OPENAI_BASE_URL=${base}/v1  OPENAI_API_KEY=${config.apiKey ? '<your --api-key>' : 'anything'}
`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.host) && !config.apiKey) {
      console.warn('⚠  Bound to a non-local address without --api-key: anyone who can reach this port can use your subscription.\n');
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function doctor() {
  const ok = (m) => console.log(`✓ ${m}`);
  const bad = (m) => {
    console.log(`✗ ${m}`);
    process.exitCode = 1;
  };
  console.log(`Node ${process.version}`);
  if (Number(process.versions.node.split('.')[0]) < 18) bad('Node 18 or newer is required');
  let caps;
  try {
    caps = await getCapabilities(config);
    ok(`Claude Code ${caps.version} found (${caps.command})`);
  } catch (err) {
    return bad(err.message);
  }
  for (const [flag, have] of [['--safe-mode', caps.safeMode], ['--json-schema', caps.jsonSchema], ['--include-partial-messages', caps.partial], ['--effort', caps.effort]]) {
    if (!have) console.log(`! ${flag} not supported by this version: some features are off. Run \`claude update\`.`);
  }
  if (process.env.ANTHROPIC_API_KEY && !config.allowApiKey) {
    console.log('! ANTHROPIC_API_KEY is set in this shell; the bridge removes it so Claude Code uses your subscription.');
  }
  process.stdout.write('… sending a test prompt (uses a little of your plan) ');
  try {
    const t0 = Date.now();
    const done = await runClaudeToCompletion({ content: [{ type: 'text', text: 'Reply with exactly: OK' }], config: { ...config, timeoutMs: 120000 } });
    console.log('');
    ok(`Got "${done.text.trim()}" from ${done.model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('\nAll good. Start the server with: use-your-claude');
  } catch (err) {
    console.log('');
    bad(err.message);
  }
}

async function ask(prompt) {
  if (!prompt) {
    console.error('Usage: use-your-claude ask "<prompt>"');
    process.exit(1);
  }
  const { runClaude } = await import('../src/claude.js');
  try {
    for await (const ev of runClaude({
      content: [{ type: 'text', text: prompt }],
      system: config.defaultSystem,
      model: config.forceModel || config.defaultModel,
      config,
    })) {
      if (ev.type === 'text') process.stdout.write(ev.text);
    }
    process.stdout.write('\n');
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}
