"""
claude_local: call Claude from Python with your Claude subscription, no API key.

Runs headless Claude Code (`claude -p`) under the hood. Standard library only:
copy this file into your project.

    from claude_local import ask, stream, ask_json

    print(ask("Write a haiku about rain", model="sonnet"))

    for chunk in stream("Tell me a story"):
        print(chunk, end="", flush=True)

    person = ask_json("Invent a person", {
        "type": "object",
        "properties": {"name": {"type": "string"}, "age": {"type": "integer"}},
        "required": ["name", "age"],
    })

Requires Claude Code installed and logged in (run `claude` once and /login).
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
from typing import Any, Iterator, Optional, Sequence, Union

DEFAULT_SYSTEM = "You are Claude, an AI assistant made by Anthropic."

__all__ = ["ask", "stream", "ask_json", "ClaudeError"]


class ClaudeError(RuntimeError):
    """Raised when Claude Code fails. `status` mirrors the HTTP status the API would use."""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _classify(message: str) -> int:
    m = message.lower()
    if any(s in m for s in ("usage limit", "rate limit", "limit reached", "hit your limit")):
        return 429
    if any(s in m for s in ("/login", "not logged in", "authenticat", "invalid api key", "oauth")):
        return 401
    return 502


def _claude_command() -> list[str]:
    explicit = os.environ.get("CLAUDE_BIN")
    if explicit:
        return [explicit]
    if os.name == "nt":
        exe = shutil.which("claude.exe")
        if exe:
            return [exe]
        shim = shutil.which("claude.cmd")
        if shim:
            pkg = os.path.join(os.path.dirname(shim), "node_modules", "@anthropic-ai", "claude-code")
            native = os.path.join(pkg, "bin", "claude.exe")
            if os.path.exists(native):
                return [native]
            cli = os.path.join(pkg, "cli.js")
            if os.path.exists(cli):
                return [shutil.which("node") or "node", cli]
    found = shutil.which("claude")
    if not found:
        raise ClaudeError(
            "Claude Code CLI not found. Install it from https://code.claude.com/docs/en/setup "
            "and run `claude` once to log in, or set CLAUDE_BIN.",
            status=500,
        )
    return [found]


ImageInput = Union[bytes, str, "os.PathLike[str]"]


def _image_block(img: ImageInput) -> dict:
    """Accepts raw bytes, a file path, or a data: URL."""
    if isinstance(img, bytes):
        data, media = img, _sniff(img)
    elif isinstance(img, str) and img.startswith("data:"):
        header, b64 = img.split(",", 1)
        return {"type": "image", "source": {"type": "base64", "media_type": header[5:].split(";")[0], "data": b64}}
    else:
        with open(img, "rb") as f:
            data = f.read()
        media = _sniff(data)
    kind = "document" if media == "application/pdf" else "image"
    return {"type": kind, "source": {"type": "base64", "media_type": media, "data": base64.b64encode(data).decode()}}


def _sniff(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"GIF8":
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"%PDF"):
        return "application/pdf"
    return "image/png"


def _run(
    prompt: str,
    *,
    system: Optional[str],
    model: Optional[str],
    effort: Optional[str],
    images: Sequence[ImageInput],
    json_schema: Optional[dict],
    timeout: float,
) -> Iterator[dict]:
    content: list[dict] = [_image_block(i) for i in images]
    content.append({"type": "text", "text": prompt})

    args = _claude_command() + [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--no-session-persistence",
        "--safe-mode",
        "--tools", "",
        "--system-prompt", system or DEFAULT_SYSTEM,
    ]
    if model:
        args += ["--model", model]
    if effort:
        args += ["--effort", effort]
    if json_schema is not None:
        args += ["--json-schema", json.dumps(json_schema)]

    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)  # make sure the subscription login is used
    env.pop("CLAUDECODE", None)

    workdir = os.path.join(tempfile.gettempdir(), "use-your-claude-workdir")
    os.makedirs(workdir, exist_ok=True)

    try:
        proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workdir,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
    except OSError as e:
        raise ClaudeError(f"Could not start Claude Code ({args[0]}): {e}", status=500) from e
    timer = threading.Timer(timeout, proc.kill)
    timer.start()
    stderr_chunks: list[str] = []
    stderr_reader = threading.Thread(target=lambda: stderr_chunks.append(proc.stderr.read()), daemon=True)
    stderr_reader.start()
    try:
        message = {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None, "session_id": ""}
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.close()

        result = None
        saw_delta = False
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if msg.get("parent_tool_use_id"):
                continue
            kind = msg.get("type")
            if kind == "stream_event":
                ev = msg.get("event", {})
                delta = ev.get("delta", {})
                if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                    saw_delta = True
                    yield {"type": "text", "text": delta.get("text", "")}
            elif kind == "assistant" and not saw_delta:
                for block in msg.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        yield {"type": "text", "text": block.get("text", "")}
            elif kind == "result":
                result = msg
        proc.wait()
        stderr_reader.join(timeout=2)
        timed_out = not timer.is_alive()
        if timed_out and result is None:
            raise ClaudeError(f"Claude Code did not finish within {timeout}s", status=504)
        if result is None:
            err = "".join(stderr_chunks).strip() or f"claude exited with code {proc.returncode}"
            raise ClaudeError(err, status=_classify(err))
        if result.get("is_error") or result.get("subtype") != "success":
            err = str(result.get("result") or result.get("subtype"))
            raise ClaudeError(err, status=_classify(err))
        yield {"type": "done", "result": result}
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()


def ask(
    prompt: str,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    images: Sequence[ImageInput] = (),
    timeout: float = 600,
) -> str:
    """Send one prompt and return the reply text. `model` is 'opus', 'sonnet', 'haiku' or a full id."""
    text = []
    for ev in _run(prompt, system=system, model=model, effort=effort, images=images, json_schema=None, timeout=timeout):
        if ev["type"] == "text":
            text.append(ev["text"])
        elif ev["type"] == "done" and not text:
            text.append(ev["result"].get("result") or "")
    return "".join(text)


def stream(
    prompt: str,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    images: Sequence[ImageInput] = (),
    timeout: float = 600,
) -> Iterator[str]:
    """Yield the reply as text chunks while it is generated."""
    for ev in _run(prompt, system=system, model=model, effort=effort, images=images, json_schema=None, timeout=timeout):
        if ev["type"] == "text":
            yield ev["text"]


def ask_json(
    prompt: str,
    schema: dict,
    *,
    system: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    images: Sequence[ImageInput] = (),
    timeout: float = 600,
) -> Any:
    """Return output that matches `schema` (a JSON Schema), already parsed."""
    for ev in _run(prompt, system=system, model=model, effort=effort, images=images, json_schema=schema, timeout=timeout):
        if ev["type"] == "done":
            result = ev["result"]
            if "structured_output" in result:
                return result["structured_output"]
            return json.loads(result.get("result") or "null")
    raise ClaudeError("No result from Claude Code")


if __name__ == "__main__":
    import sys

    print(ask(" ".join(sys.argv[1:]) or "Say hello in one short sentence."))
