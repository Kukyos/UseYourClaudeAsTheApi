#!/usr/bin/env bash
# Raw HTTP calls against use-your-claude (start it first: npx -y github:kukyos/useyourclaudeastheapi)

# Anthropic format
curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":256,"messages":[{"role":"user","content":"Hello!"}]}'
echo

# OpenAI format, streaming
curl -sN http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-haiku","stream":true,"messages":[{"role":"user","content":"Say hi in 3 languages"}]}'
