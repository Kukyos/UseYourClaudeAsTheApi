"""Anthropic Python SDK against use-your-claude.

    pip install anthropic
    npx -y github:kukyos/useyourclaudeastheapi      # in another terminal
    python examples/anthropic_sdk.py
"""
import anthropic

client = anthropic.Anthropic(base_url="http://127.0.0.1:8787", api_key="anything")

# Plain message
msg = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    system="You are a concise assistant.",
    messages=[{"role": "user", "content": "Give me three names for a coffee shop."}],
)
print(msg.content[0].text, "\n")

# Streaming
with client.messages.stream(
    model="claude-haiku-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a limerick about Python."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
print("\n")

# Tool use loop
tools = [{
    "name": "get_weather",
    "description": "Current weather for a city",
    "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
}]
messages = [{"role": "user", "content": "Should I bring an umbrella in London today?"}]
while True:
    resp = client.messages.create(model="claude-sonnet-4-5", max_tokens=1024, tools=tools, messages=messages)
    if resp.stop_reason != "tool_use":
        print(resp.content[0].text)
        break
    messages.append({"role": "assistant", "content": resp.content})
    results = []
    for block in resp.content:
        if block.type == "tool_use":
            print(f"→ {block.name}({block.input})")
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": "12°C, heavy showers"})
    messages.append({"role": "user", "content": results})
