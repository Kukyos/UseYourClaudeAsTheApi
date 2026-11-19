---
name: use-use-your-claude
description: Wire a project's LLM calls to the developer's own Claude Pro/Max subscription instead of a paid API key, using headless Claude Code through the use-your-claude bridge (Anthropic- and OpenAI-compatible) or a direct no-server client. Use when the user wants to use their Claude subscription, Claude Pro, Claude Max or "Claude Code as the API" in an app, avoid buying API credits, replace an ANTHROPIC_API_KEY / OPENAI_API_KEY / Gemini key for local development, or asks for "/use-use-your-claude".
---

# Use your Claude subscription as the API

`use-your-claude` runs each LLM request through headless Claude Code (`claude -p`), which is logged in with the
developer's Claude subscription. You get two ways to use it:

| Mode | What it is | Pick it when |
|---|---|---|
| **Bridge** (recommended) | A local server at `http://127.0.0.1:8787` that speaks the **Anthropic Messages API** (`/v1/messages`) and the **OpenAI Chat Completions API** (`/v1/chat/completions`), with streaming, tools, images and JSON output | The project already uses an SDK or framework (Anthropic, OpenAI, LangChain, Vercel AI SDK, LiteLLM, LlamaIndex, …) or calls an HTTP API. Only the base URL changes. |
| **Direct** | A function that calls `claude -p` in-process: `claude_local.py` (Python, stdlib only) or `import { ask } from 'use-your-claude'` (Node) | A script or small tool with no SDK yet, where running a server is overkill. |

Repository: https://github.com/kukyos/useyourclaudeastheapi

## Workflow

Follow these steps in order. Keep the user's production setup working: the subscription is for the developer's
own local use, so make it a switch the developer flips for local development, not a hard-coded replacement.

### 1. Check prerequisites

Run these:

```bash
claude --version
npx -y github:kukyos/useyourclaudeastheapi doctor
```

- If `claude` is missing, tell the user to install Claude Code (https://code.claude.com/docs/en/setup) and stop.
- If `doctor` reports an authentication problem, tell the user to run `claude` in a terminal and use `/login`
  with their Claude subscription account (not an API key). On a headless machine, `claude setup-token` creates a long-lived token for
  `CLAUDE_CODE_OAUTH_TOKEN`.
- `doctor` sends one tiny prompt, which uses a small amount of the user's plan.

### 2. Find how the project calls an LLM

Search the codebase before changing anything. Look for:

- Anthropic: `anthropic` / `@anthropic-ai/sdk` imports, `ANTHROPIC_API_KEY`, `messages.create`
- OpenAI-compatible: `openai` imports, `OPENAI_API_KEY`, `chat.completions.create`, `baseURL` / `base_url`
- Frameworks: `langchain`, `@ai-sdk/*` / `ai`, `litellm`, `llama_index`, `instructor`, `pydantic_ai`
- Gemini or others: `google.generativeai`, `@google/genai`, `GEMINI_API_KEY`, raw `fetch`/`requests` to an LLM URL
- Where keys are loaded: `.env`, `.env.example`, config modules, settings classes

Then choose the mode with the table above and tell the user in one or two sentences what you found and which mode you'll use.

### 3a. Bridge mode

Start the bridge in its own terminal (or a background process) and leave it running:

```bash
npx -y github:kukyos/useyourclaudeastheapi
```

Options: `--port 8787`, `--model sonnet` (used when a request names a non-Claude model such as `gpt-4o`),
`--force-model haiku`, `--concurrency 3`, `--api-key <key>` (require a key from clients), `--cors <origins>`.

Point the project at it. Most SDKs read these environment variables, so often only `.env` changes:

```bash
# Anthropic SDKs (Python, TypeScript, …)
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=claude-subscription        # any non-empty value

# OpenAI SDKs and OpenAI-compatible frameworks
OPENAI_BASE_URL=http://127.0.0.1:8787/v1
OPENAI_API_KEY=claude-subscription
```

If the code passes the base URL or key explicitly, change the code to read them from the environment with the
current values as fallback. Examples:

```python
# Anthropic (Python)
client = anthropic.Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))   # None = real API
# OpenAI (Python)
client = OpenAI(base_url=os.getenv("OPENAI_BASE_URL"))
# LangChain
ChatAnthropic(model="claude-sonnet-4-5", base_url=os.getenv("ANTHROPIC_BASE_URL"))
ChatOpenAI(model="claude-sonnet", base_url=os.getenv("OPENAI_BASE_URL"))
# LiteLLM
litellm.completion(model="anthropic/claude-sonnet-4-5", api_base="http://127.0.0.1:8787", ...)
```

```ts
// Vercel AI SDK
import { createAnthropic } from '@ai-sdk/anthropic';
const anthropic = createAnthropic({ baseURL: process.env.ANTHROPIC_BASE_URL ? `${process.env.ANTHROPIC_BASE_URL}/v1` : undefined });
// Note: the AI SDK's baseURL includes /v1; the Anthropic SDK's does not.
```

**Gemini or another provider's SDK:** these cannot be pointed at the bridge. Either switch that code path to the
OpenAI SDK (Gemini apps usually map cleanly: one `chat.completions.create` call per `generate_content`) or use
direct mode. Ask the user before swapping an SDK dependency.

**Model names:** Claude ids (`claude-sonnet-4-5`, `claude-opus-4-1`, …) and the aliases `claude-opus`,
`claude-sonnet`, `claude-haiku`, `opus`, `sonnet`, `haiku` are honoured. Anything else (`gpt-4o`, `gemini-2.5-pro`)
uses `--model` or the Claude Code default, so OpenAI-shaped apps work without code changes.

Add a convenience script when the project has a task runner, e.g. in `package.json`:
`"claude-api": "npx -y github:kukyos/useyourclaudeastheapi"`, and document the variables in `.env.example`
with a comment saying they route LLM calls through the developer's Claude subscription.

### 3b. Direct mode

**Python:** copy [claude_local.py](claude_local.py) (next to this file) into the project, e.g. as
`claude_local.py` or `<package>/llm/claude_local.py`. It has no dependencies.

```python
from claude_local import ask, stream, ask_json

reply = ask("Summarise this:\n" + text, system="You are concise.", model="sonnet")
for chunk in stream("Write a poem"):
    print(chunk, end="", flush=True)
data = ask_json("Extract the invoice fields", schema, images=["invoice.png"])
```

**Node/TypeScript:** `npm install github:kukyos/useyourclaudeastheapi`, then

```js
import { ask, stream, askJson } from 'use-your-claude';
const reply = await ask('Summarise this', { system: 'Be concise', model: 'sonnet' });
```

Errors raise `ClaudeError` with `.status` (429 when the plan's usage limit is hit, 401 when not logged in).

If the project has an LLM wrapper module, add the subscription path behind a setting there
(e.g. `LLM_PROVIDER=claude-subscription`) instead of editing every call site.

### 4. Verify

Run the project's real LLM call path once (a test, a CLI command or one request to the app) and show the user
the reply. With the bridge running, its terminal logs one line per request (model, seconds, tokens).

## What to tell the user

- Each request starts a Claude Code process: expect 2–5 s of overhead per call and about 1–2k tokens of context
  overhead. Usage counts against the subscription's limits; when a limit is hit, the API returns HTTP 429 with
  `retry-after`.
- Parameters Claude Code does not expose are ignored: `max_tokens`, `temperature`, `top_p`, `stop`.
  `thinking` / `reasoning_effort` map to Claude Code's `--effort`.
- Tool/function calling is emulated through the prompt. It works with the normal SDK tool loops, but very large
  tool sets or strict `tool_choice` are less reliable than the real API.
- This is for the developer's own local use. Do not deploy the bridge as a public service or ship a product
  whose users run on someone's subscription; production apps should use an API key.

## Troubleshooting

| Symptom | Fix |
|---|---|
| 401 / "Please run /login" | Run `claude`, `/login` with the subscription account. Make sure the shell running the bridge is the same user. |
| Requests bill API credits instead of the plan | The bridge removes `ANTHROPIC_API_KEY` for Claude Code automatically; if you started Claude Code some other way, unset it. |
| 429 | Plan usage limit reached; wait for the reset time in `retry-after` or use a smaller model (`--force-model haiku`). |
| Browser app gets 403 | Calls from web pages are allowed only from `http://localhost:*` by default. Start with `--cors http://myapp.test`. |
| Slow under load | Raise `--concurrency` (default 3); each concurrent request is a separate Claude Code process. |
| `EADDRINUSE` | Another process holds port 8787; use `--port`. |
