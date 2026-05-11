/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — World-Building Map Explorer

   Parses a manuscript PDF and extracts the principal locations the author has
   built out, with their lore, secrets, and connections. The frontend renders
   the result as an interactive force-directed node graph.

   Cost: 10 credits per map generation.
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const MODEL = 'claude-sonnet-4-6';
const COST = 10;
const TEXT_CAP = 80000;

const STYLE_RULES = `
HOUSE STYLE:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- No hedging. State what is established. State what is not established.
- No author-aside meta commentary.
`.trim();

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

  const { pdfBase64 } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) return json(500, { error: 'Server not configured' });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  // Credit check
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < COST) return json(402, { error: 'Insufficient credits', needed: COST, have: balance });

  // Parse PDF
  let text;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text = (parsed.text || '').trim();
  } catch (e) {
    return json(400, { error: 'PDF parse failed: ' + (e.message || String(e)) });
  }
  if (!text) return json(400, { error: 'PDF contained no extractable text' });

  const truncated = text.length > TEXT_CAP;
  const useText = truncated ? text.slice(0, TEXT_CAP) : text;

  const system = `You are extracting the world-building map of a fiction manuscript.

Identify every location the author has named or developed: cities, regions, neighborhoods, buildings, rooms, landscapes, vehicles-as-settings, and similar. For each, return:

  id              — kebab-case slug (e.g., "lower-district", "the-galley")
  name            — exact name as the manuscript uses it
  type            — city | region | neighborhood | building | room | landscape | vehicle | other
  established     — true if the manuscript actually describes this location with sensory or factual detail; false if the location is named but never developed (you should still include it so the author can see the gap)
  lore            — the manuscript's micro-lore for this location: what is established about it, what is hinted at, what secrets are referenced. Two to four sentences. If the location is named but undeveloped, write: "Named but not developed in the manuscript."
  scenes          — array of brief scene markers where this location appears (e.g., ["Ch 3 opening", "the interrogation"])

Then return edges: for any two locations that have a meaningful relationship (one is inside another, characters travel between them, they share history), return an edge.

${STYLE_RULES}

OUTPUT FORMAT — return a single JSON object, no preamble, no markdown fences:
{
  "nodes": [
    { "id": "...", "name": "...", "type": "...", "established": true, "lore": "...", "scenes": ["..."] }
  ],
  "edges": [
    { "source": "node-id", "target": "node-id", "kind": "contains" | "travels_to" | "near" | "linked_history" }
  ],
  "central_id": "id-of-the-most-central-location"
}`;

  const user = `MANUSCRIPT TEXT${truncated ? ' (truncated to first 80,000 chars)' : ''}:
---
${useText}
---

Return the JSON object now.`;

  let resp;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.3,
      system,
      messages: [{ role: 'user', content: user }],
    });
  } catch (err) {
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const rawText = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

  let parsed;
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON in response');
    parsed = JSON.parse(m[0]);
  } catch (e) {
    return json(502, { error: 'Could not parse map data: ' + e.message, raw: rawText.slice(0, 500) });
  }

  // Deduct credits
  const newBalance = balance - COST;
  await supabase.from('gp_credits').update({ balance: newBalance }).eq('user_id', userId);

  return json(200, {
    nodes: parsed.nodes || [],
    edges: parsed.edges || [],
    central_id: parsed.central_id || null,
    truncated,
    credits_remaining: newBalance,
  });
};
