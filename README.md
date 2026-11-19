# Use Your Claude As The API

**Use your Claude Pro / Max subscription as the AI API for your own projects. No API key and no pay-per-token billing.**

Most tutorials, starter kits and side projects ask for an `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or Gemini key.
If you already pay for a Claude subscription, you also have [Claude Code](https://code.claude.com), and Claude
Code can run headless (`claude -p`). **use-your-claude** puts a standard API in front of it, so your existing
code runs on the subscription you already have.

```
your app ──(Anthropic or OpenAI SDK)──▶ use-your-claude on localhost:8787 ──▶ claude -p ──▶ your Claude subscription
```

- **Drop-in compatible.** Speaks the **Anthropic Messages API** and the **OpenAI Chat Completions API**, so the
  official SDKs, LangChain, the Vercel AI SDK, LiteLLM and anything else that lets you set a base URL just work.
- **Full feature set.** Streaming, system prompts, multi-turn chat, images and PDFs, tool/function calling,
  structured JSON output and reasoning effort.
- **No server if you don't want one.** A one-file Python client and a Node library call Claude Code directly.
- **Sets itself up.** Ships as a Claude Code plugin with a `/use-claude-as-api` skill that wires any project up for you.
- **Zero dependencies.** Plain Node.js 18+.

---

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Installing](#installing)
- [Using it from your code](#using-it-from-your-code)
  - [Anthropic SDK](#anthropic-sdk-python--typescript)
  - [OpenAI SDK](#openai-sdk-python--typescript)
  - [LangChain](#langchain)
  - [Vercel AI SDK](#vercel-ai-sdk)
  - [LiteLLM](#litellm)
  - [curl / any HTTP client](#curl--any-http-client)
  - [Browser apps](#browser-apps)
- [Direct mode (no server)](#direct-mode-no-server)
- [The Claude Code skill](#the-claude-code-skill)
- [Keeping your production setup](#keeping-your-production-setup)
- [Reference](#reference): endpoints, models, supported features, options
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Fair use](#fair-use)
- [Contributing](#contributing)

---

## Requirements

- A **Claude Pro or Max** subscription.
- **Claude Code**, installed and logged in with that subscription:
  1. Install it: https://code.claude.com/docs/en/setup
  2. Run `claude` once in a terminal and type `/login`. Choose your Claude account, not an API key.
- **Node.js 18 or newer** (for the server and the Node library). The Python client needs only Python 3.8+.

Works on macOS, Linux and Windows.

## Quick start

**1. Check your setup.** This sends one tiny test prompt:

```bash
npx -y github:kukyos/useyourclaudeastheapi doctor
```

```
✓ Claude Code 2.1.329 found
✓ Got "OK" from claude-opus-… in 4.9s
All good.
```

**2. Start the server** and leave it running in its own terminal:

```bash
npx -y github:kukyos/useyourclaudeastheapi
```

```
use-your-claude listening on http://127.0.0.1:8787

  Anthropic SDK:  ANTHROPIC_BASE_URL=http://127.0.0.1:8787  ANTHROPIC_API_KEY=anything
  OpenAI SDK:     OPENAI_BASE_URL=http://127.0.0.1:8787/v1  OPENAI_API_KEY=anything
```

**3. Point your app at it,** usually in `.env`:

```bash
# Apps that use an Anthropic SDK
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=anything            # any non-empty value; the SDK just needs one

# Apps that use an OpenAI SDK or an OpenAI-compatible library
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=anything
```

**4. Run your app.** Every AI call now goes through your Claude subscription. The server logs one line per request:

```
23:06:04 ✓ /v1/messages claude-sonnet-… 2.8s in=1606 out=52
```

## Installing

You don't have to install anything: `npx -y github:kukyos/useyourclaudeastheapi` downloads and runs it. To get
a permanent `use-your-claude` command instead:

```bash
npm install -g github:kukyos/useyourclaudeastheapi
```

```bash
use-your-claude            # start the server
use-your-claude doctor     # check your setup
use-your-claude ask "Write a haiku about coffee"   # one-off prompt from the terminal
```

Or clone the repository and run it from there:

```bash
git clone https://github.com/kukyos/useyourclaudeastheapi
```

```bash
cd useyourclaudeastheapi && node bin/use-your-claude.js
```

**Keeping it running in the background** (optional):

```bash
# macOS / Linux
nohup use-your-claude > ~/use-your-claude.log 2>&1 &
```

On Windows, keep it open in its own terminal window.

## Using it from your code

Most SDKs read the base URL and key from the environment variables in [Quick start](#quick-start), so often only
`.env` changes. The snippets below set them explicitly for clarity.

**Which model name should I use?** Claude model ids (`claude-sonnet-4-5`, `claude-opus-4-1`, …) and the aliases
`claude-opus`, `claude-sonnet`, `claude-haiku`, `opus`, `sonnet`, `haiku` select that model. **Any other name**
(`gpt-4o`, `gemini-2.5-pro`, …) uses your default Claude model, so apps written for OpenAI work without code changes.

### Anthropic SDK (Python / TypeScript)

```python
import anthropic

client = anthropic.Anthropic(base_url="http://127.0.0.1:8787", api_key="anything")

msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system="You are a concise assistant.",
    messages=[{"role": "user", "content": "Explain recursion in one paragraph."}],
)
print(msg.content[0].text)

# Streaming
with client.messages.stream(model="claude-haiku-4-5", max_tokens=1024,
                            messages=[{"role": "user", "content": "Write a limerick."}]) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
```

```ts
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ baseURL: 'http://127.0.0.1:8787', apiKey: 'anything' });
const msg = await client.messages.create({
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'Explain recursion in one paragraph.' }],
});
console.log(msg.content[0].text);
```

Tool use works with the normal tool loop. See [`examples/anthropic_sdk.py`](examples/anthropic_sdk.py) for a complete example.

### OpenAI SDK (Python / TypeScript)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")

res = client.chat.completions.create(
    model="gpt-4o",  # mapped to your default Claude model
    messages=[{"role": "user", "content": "Why is the sky blue?"}],
)
print(res.choices[0].message.content)
```

```ts
import OpenAI from 'openai';

const openai = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'anything' });

const stream = await openai.chat.completions.create({
  model: 'claude-sonnet',
  stream: true,
  messages: [{ role: 'user', content: 'Count to ten in Spanish.' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');
```

Structured output (`response_format: { type: 'json_schema', … }`), JSON mode, tool calls and image inputs
(`image_url`, including `data:` URLs) are supported. See [`examples/openai_sdk.mjs`](examples/openai_sdk.mjs).

### LangChain

```python
from langchain_anthropic import ChatAnthropic
llm = ChatAnthropic(model="claude-sonnet-4-5", base_url="http://127.0.0.1:8787", api_key="anything")

# or, through the OpenAI integration
from langchain_openai import ChatOpenAI
llm = ChatOpenAI(model="claude-sonnet", base_url="http://127.0.0.1:8787/v1", api_key="anything")

print(llm.invoke("Tell me a fun fact about octopuses.").content)
```

### Vercel AI SDK

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

// The AI SDK's baseURL includes /v1 (the Anthropic SDK's does not).
const anthropic = createAnthropic({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'anything' });

const { text } = await generateText({ model: anthropic('claude-sonnet-4-5'), prompt: 'Name three moons of Jupiter.' });
```

### LiteLLM

```python
import litellm

res = litellm.completion(
    model="anthropic/claude-sonnet-4-5",
    api_base="http://127.0.0.1:8787",
    api_key="anything",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

### curl / any HTTP client

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'
```

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","stream":true,"messages":[{"role":"user","content":"Say hi in 3 languages"}]}'
```

Requests must send `Content-Type: application/json`.

### Browser apps

A frontend on `http://localhost:<any port>` (Vite, Next.js dev server, …) can call the server directly. For any
other origin, allow it explicitly:

```bash
use-your-claude --cors http://myapp.test,http://192.168.1.20:3000
```

## Direct mode (no server)

For scripts and small tools you can skip the server and call Claude Code in-process.

### Python

Copy [`clients/python/claude_local.py`](clients/python/claude_local.py) into your project. It's a single file
that uses only the standard library.

```python
from claude_local import ask, stream, ask_json, ClaudeError

print(ask("What's the capital of Italy?", model="haiku"))

for chunk in stream("Tell me a short story", system="You write for children."):
    print(chunk, end="", flush=True)

dog = ask_json("Invent a dog", {
    "type": "object",
    "properties": {"name": {"type": "string"}, "breed": {"type": "string"}},
    "required": ["name", "breed"],
})

print(ask("What's in this picture?", images=["photo.jpg"]))   # paths, bytes or data: URLs; PDFs work too

try:
    ask("hello")
except ClaudeError as e:
    print(e.status, e)   # 429 = plan usage limit hit, 401 = not logged in
```

All functions accept `system`, `model` (`"opus"`, `"sonnet"`, `"haiku"` or a full id), `effort`
(`"low"` … `"max"`), `images` and `timeout`.

### Node.js

```bash
npm install github:kukyos/useyourclaudeastheapi
```

```js
import { ask, stream, askJson } from 'use-your-claude';

console.log(await ask('What is the capital of Italy?', { model: 'haiku' }));

for await (const chunk of stream('Tell me a short story')) process.stdout.write(chunk);

const city = await askJson('Largest city in Japan', {
  type: 'object',
  properties: { city: { type: 'string' }, population_millions: { type: 'number' } },
  required: ['city', 'population_millions'],
});
```

Options: `system`, `model`, `effort`, `images` (`[{ data: Buffer, mediaType: 'image/png' }]`), `signal`, `timeoutMs`.

## The Claude Code skill

This repository is also a Claude Code plugin. Its skill sets up a project for you: it finds how your code
calls an AI model, picks server or direct mode, updates `.env` and config without breaking your production
API-key setup, and runs a test call.

Install it once, from inside Claude Code:

```
/plugin marketplace add kukyos/useyourclaudeastheapi
/plugin install subscription-as-api@useyourclaudeastheapi
```

Then, in any project, ask Claude *"use my Claude subscription for this app's AI calls"* or run `/use-claude-as-api`.

To install without the plugin system, copy the `skills/use-claude-as-api/` folder into `~/.claude/skills/`.

## Keeping your production setup

The subscription is for **your own local development**. Keep your real API configuration for deployments and
switch with environment variables only:

```python
# Uses the local server when ANTHROPIC_BASE_URL is set (dev), the real API otherwise (prod).
client = anthropic.Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
```

```bash
# .env.development
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=anything
```

## Reference

### Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/messages` | Anthropic Messages API, streaming and non-streaming |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API, streaming (incl. `stream_options.include_usage`) and non-streaming |
| `GET` | `/v1/models` | Lists `claude-opus`, `claude-sonnet`, `claude-haiku`, `default` |
| `POST` | `/v1/messages/count_tokens` | Rough estimate (characters ÷ 4) |
| `GET` | `/health` | Claude Code version and how many requests are running or queued |

### Supported request features

| Feature | Anthropic format | OpenAI format |
|---|---|---|
| Text, system prompt, multi-turn | ✅ | ✅ (`system` and `developer` roles) |
| Streaming | ✅ SSE events | ✅ SSE chunks + `[DONE]` |
| Images | ✅ base64 and URL sources | ✅ `image_url` (http and `data:` URLs) |
| PDFs | ✅ `document` blocks | ✅ `file` parts with `file_data` |
| Tool / function calling | ✅ `tools`, `tool_choice` (`auto`, `any`, `tool`, `none`) | ✅ `tools`, `tool_choice`, legacy `functions` |
| Structured output | ✅ `output_format` / `output_config.format` (`json_schema`) | ✅ `response_format` (`json_schema`, `json_object`) |
| Reasoning effort | ✅ `thinking.budget_tokens`, `output_config.effort` | ✅ `reasoning_effort` |
| Usage / token counts | ✅ | ✅ |
| `max_tokens`, `temperature`, `top_p`, `stop`, `n` | accepted, ignored | accepted, ignored |

### Command-line options

```
use-your-claude [options]          Start the API server
use-your-claude doctor             Check that Claude Code is installed and logged in
use-your-claude ask "<prompt>"     Send one prompt and print the reply
```

| Option | Environment variable | Default | Description |
|---|---|---|---|
| `-p, --port <n>` | `USE_YOUR_CLAUDE_PORT` | `8787` | Port to listen on |
| `--host <addr>` | `USE_YOUR_CLAUDE_HOST` | `127.0.0.1` | Address to bind |
| `-c, --concurrency <n>` | `USE_YOUR_CLAUDE_CONCURRENCY` | `3` | Requests processed at once; others wait in a queue |
| `-m, --model <name>` | `USE_YOUR_CLAUDE_MODEL` | Claude Code default | Model used when a request names a non-Claude model |
| `--force-model <name>` | `USE_YOUR_CLAUDE_FORCE_MODEL` | | Use this model for every request |
| `--api-key <key>` | `USE_YOUR_CLAUDE_KEY` | | Require clients to send this key (`x-api-key` or `Authorization: Bearer`) |
| `--cors <origins>` | `USE_YOUR_CLAUDE_CORS` | `http://localhost:*` | Browser origins allowed, comma-separated, or `*` |
| `--timeout <sec>` | `USE_YOUR_CLAUDE_TIMEOUT` | `600` | Per-request time limit |
| `--system <text>` | `USE_YOUR_CLAUDE_SYSTEM` | | System prompt for requests that don't send one |
| `--allow-api-key` | | off | Keep `ANTHROPIC_API_KEY` visible to Claude Code (normally removed, see below) |
| `--claude-bin <path>` | `CLAUDE_BIN` | `claude` on PATH | Path to the Claude Code binary |
| `-q, --quiet` | | | Don't log requests |
| `-v, --verbose` | | | Log raw Claude Code output |

## How it works

Each request starts one headless Claude Code run:

```
claude -p --input-format stream-json --output-format stream-json --include-partial-messages \
       --tools "" --safe-mode --no-session-persistence \
       --system-prompt "<your system prompt>" [--model …] [--effort …] [--json-schema …]
```

- **A plain model, not a coding agent.** `--tools ""` and `--safe-mode` turn off Claude Code's tools, MCP
  servers, hooks, skills and `CLAUDE.md` files, and `--system-prompt` replaces its agent prompt. Runs happen in
  an empty temporary directory, so nothing from your projects leaks in.
- **Conversations.** Claude Code takes one message per run, so earlier turns are replayed as a transcript inside
  that message. Images and PDFs are passed as real content blocks; image URLs are downloaded first.
- **Tool calling** is emulated. Your tool definitions go into the system prompt, Claude writes
  `<tool_call>{…}</tool_call>`, and the server turns that into proper `tool_use` / `tool_calls` objects with
  `stop_reason: tool_use`. The tags never appear in streamed text.
- **Structured output** uses Claude Code's `--json-schema`.
- **Always your subscription.** Claude Code prefers `ANTHROPIC_API_KEY` over your login when that variable is
  set, which would bill API credits. The server removes it from Claude Code's environment.
- **Real API errors.** Plan usage limit reached → `429` with a `retry-after` header. Not logged in → `401`.
  Timeout → `504`. SDK retry logic works as it does against the real API.

## Limitations

- **Latency.** Every request starts a Claude Code process, which adds roughly 2–5 seconds. That's fine for
  scripts, agents, prototypes and personal tools, but it isn't built for high-traffic production.
- **Context overhead.** Claude Code adds around 1–2k tokens of context to every request.
- **Your plan's limits apply.** Heavy use counts against your 5-hour and weekly usage limits like any other
  Claude use. When you hit one, you get a `429`.
- **Some parameters are ignored:** `max_tokens`, `temperature`, `top_p`, stop sequences, `n`, `logprobs`.
- **Tools are emulated,** so they're slightly less reliable than the real API with very large tool sets. Anthropic
  server-side tools (web search, code execution) aren't available.

## Troubleshooting

| Problem | Fix |
|---|---|
| `doctor` says Claude Code isn't found | Install it (link in [Requirements](#requirements)), open a new terminal, or pass `--claude-bin /path/to/claude`. |
| `401` / "Please run /login" | Run `claude`, type `/login` and log in with your subscription account. Run the server as the same OS user. |
| Using it on a headless server or CI | Run `claude setup-token` on your machine and set the token it prints as `CLAUDE_CODE_OAUTH_TOKEN` where the server runs. |
| `429` | You've hit your plan's usage limit. Wait until the reset time in `retry-after`, or use a lighter model (`--force-model haiku`). |
| Browser request blocked (`403`) | Only `http://localhost:*` origins are allowed by default. Add yours with `--cors`. |
| `415 Content-Type must be application/json` | Send the `Content-Type: application/json` header. |
| Requests are slow or queue up | Each running request is a separate Claude Code process. Raise `--concurrency` (default 3). |
| `Port 8787 is already in use` | Pick another port with `--port 8790` and update your base URL. |
| `Claude Code … is too old` | Run `claude update`. |
| The app still asks for an API key | Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` to any non-empty value. The server ignores it unless you set `--api-key`. |

## Security

- The server listens on `127.0.0.1` only. Anyone who can reach the port can spend your plan, so if you bind to
  another address (`--host 0.0.0.0`), also set `--api-key`.
- Browser requests are accepted only from `http://localhost:*` unless you pass `--cors`. Requests with non-JSON
  bodies or a non-local `Host` header are rejected. This stops websites you visit from using your local server,
  including through DNS rebinding.

## Fair use

This tool runs the official Claude Code CLI with **your own login, for your own work**. Don't run it as a
shared or public service, resell access, or ship a product whose users are served by your (or anyone's)
subscription. Anthropic's terms don't allow offering claude.ai login or subscription usage to third parties.
For production apps and other people's traffic, use an [Anthropic API key](https://console.anthropic.com).

This is an independent community project, not affiliated with or endorsed by Anthropic.

## Contributing

Issues and pull requests are welcome.

```bash
git clone https://github.com/kukyos/useyourclaudeastheapi
```

```bash
cd useyourclaudeastheapi && npm test
```

The test suite runs against a fake `claude` binary ([`test/fake-claude.js`](test/fake-claude.js)), so it needs no
subscription and uses none of your plan.

Project layout:

```
bin/use-your-claude.js        Command-line entry point (server, doctor, ask)
src/server.js                 HTTP server: routing, auth, CORS, queueing, logging
src/anthropic.js              /v1/messages
src/openai.js                 /v1/chat/completions
src/prompt.js                 Converts both request formats into one Claude Code turn
src/tools.js                  Tool-calling emulation
src/claude.js                 Runs headless Claude Code and parses its stream-json output
src/index.js                  Node library: ask, stream, askJson
clients/python/claude_local.py  Python direct client (standard library only)
skills/use-claude-as-api/     The Claude Code skill (keep its claude_local.py in sync with clients/python)
.claude-plugin/               Plugin and marketplace manifests
examples/                     Runnable examples
```

## License

[MIT](LICENSE) © kukyos
