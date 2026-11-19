// OpenAI Node SDK against use-your-claude.
//
//   npm install openai
//   npx -y github:kukyos/useyourclaudeastheapi      # in another terminal
//   node examples/openai_sdk.mjs
import OpenAI from 'openai';

const openai = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'anything' });

// Plain completion: "gpt-4o" is mapped to your default Claude model.
const res = await openai.chat.completions.create({
  model: 'gpt-4o',
  messages: [
    { role: 'system', content: 'Answer in one sentence.' },
    { role: 'user', content: 'Why is the sky blue?' },
  ],
});
console.log(res.choices[0].message.content, '\n');

// Streaming
const stream = await openai.chat.completions.create({
  model: 'claude-haiku',
  stream: true,
  messages: [{ role: 'user', content: 'Count to ten in Spanish.' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');
console.log('\n');

// Structured output
const extracted = await openai.chat.completions.create({
  model: 'claude-sonnet',
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'contact',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, email: { type: 'string' }, company: { type: 'string' } },
        required: ['name', 'email'],
      },
    },
  },
  messages: [{ role: 'user', content: 'Hi, I am Dana Reyes from Northwind (dana@northwind.example).' }],
});
console.log(JSON.parse(extracted.choices[0].message.content));
