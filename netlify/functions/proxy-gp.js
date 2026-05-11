import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';
const DEFAULT_SYSTEM =
  'You are Grey, a skilled literary ghost writer for Greylander Press. ' +
  'Never use em dashes (—). Use periods, commas, or short sentences instead. ' +
  'Write in a natural human voice. Return only the requested content — no preamble, no commentary.';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { prompt, maxTokens, system } = body || {};
  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'Missing prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const client = new Anthropic({ apiKey });
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
      try {
        const resp = await client.messages.stream({
          model: MODEL,
          max_tokens: Math.min(Math.max(parseInt(maxTokens) || 800, 1), 4096),
          system: typeof system === 'string' && system.trim() ? system : DEFAULT_SYSTEM,
          messages: [{ role: 'user', content: prompt }],
        });
        for await (const event of resp) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            send({ type: 'delta', text: event.delta.text });
          }
        }
        send({ type: 'done' });
      } catch (err) {
        send({ type: 'error', error: err?.message || 'Stream error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
};

export const config = { path: '/.netlify/functions/proxy-gp' };
