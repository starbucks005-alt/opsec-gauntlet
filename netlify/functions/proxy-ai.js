const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';

const COSTS = {
  ghost_write: 3,
  outline_expand: 1,
  blurb: 2,
};

const DEFAULT_SYSTEM =
  'You are Grey, a skilled literary ghost writer for Greylander Press. ' +
  'Never use em dashes (—). Use periods, commas, or short sentences instead. ' +
  'Write in a natural human voice. Return only the requested content — no preamble, no commentary.';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { action, prompt, maxTokens, system } = body;
  if (!prompt || typeof prompt !== 'string') return json(400, { error: 'Missing prompt' });

  const cost = COSTS[action || 'ghost_write'];
  if (cost === undefined) return json(400, { error: 'Unknown action' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const { data: row, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });

  const balance = row?.balance ?? 0;
  if (balance < cost) return json(402, { error: 'Insufficient credits' });

  let text = '';
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: Math.min(Math.max(parseInt(maxTokens) || 1500, 1), 4096),
      system: typeof system === 'string' && system.trim() ? system : DEFAULT_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
    });
    text = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch (err) {
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const newBalance = balance - cost;
  const { error: updErr } = await supabase
    .from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, { text, credits_remaining: newBalance });
};
