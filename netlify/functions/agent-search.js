/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Find an Agent
   Manuscript Wishlist–style agent matcher powered by Claude.

   POST body : {
     genre:       string (required),
     pitch:       string (required, ≤4000 chars) — query letter / pitch / synopsis,
     wordCount?:  number,
     comps?:      string — comparable titles ("X meets Y"),
     manuscript?: string — first ≤6000 chars from gpMs (optional, improves match)
   }
   Auth      : Bearer token (Supabase JWT)
   Cost      : 2 credits
   Response  : {
     agents: [{ name, agency, url, genres, why_match, query_focus,
                submission_notes, verify_at }],
     credits_remaining,
     disclaimer
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const COST  = 2;
const PITCH_CAP = 4000;
const MS_CAP    = 6000;

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

  const { genre, pitch, wordCount, comps, manuscript } = body;
  if (!genre || !pitch) return json(400, { error: 'Missing genre or pitch' });
  if (pitch.length > PITCH_CAP) return json(413, { error: `Pitch too long. Max ${PITCH_CAP} chars.` });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Auth
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

  // Build Claude prompt
  const wcLine    = wordCount ? `\nWORD COUNT: ${Number(wordCount).toLocaleString()}` : '';
  const compsLine = comps ? `\nCOMP TITLES: ${comps}` : '';
  const msExcerpt = manuscript ? `\n\nMANUSCRIPT EXCERPT (first ${MS_CAP} chars):\n${String(manuscript).slice(0, MS_CAP)}` : '';

  const system = `You are Grey, an experienced literary agent matchmaker. The author has provided a pitch and genre. Your job is to recommend 4 to 6 reputable, currently-active US-based literary agents whose stated wishlists genuinely match this work.

Selection rules:
1. Recommend only agents at established agencies. No scammers, no fee-charging "agents", no closed agencies.
2. Match on stated wishlist, not just genre. Cite a specific reason this agent fits THIS book.
3. Diversify across agencies — do not stack 5 picks at one shop.
4. Mix junior agents actively building lists with established agents who are still open.
5. If the genre is niche, say so and recommend the closest reasonable matches.

Output format:
Return a JSON array of agent objects. No markdown, no commentary, no preamble. Each object:
{
  "name": "Agent Full Name",
  "agency": "Agency Name",
  "url": "agency website root, e.g. https://www.agencyname.com",
  "genres": "comma-separated genres they rep",
  "why_match": "1–2 sentences — specifically why this agent fits the author's pitch",
  "query_focus": "what to highlight in the query letter for this specific agent",
  "submission_notes": "brief — query letter only / first 10 pages / synopsis / closed for unsoliciteds / etc.",
  "verify_at": "QueryTracker URL pattern or Manuscript Wishlist URL if known, else agency website"
}

CRITICAL: Your training has a cutoff. Agents move agencies, close to queries, and change wishlists. Frame every recommendation as "as of training cutoff — verify before querying." Never invent an agent that does not exist. If unsure, recommend fewer agents rather than fabricating.`;

  const user = `GENRE: ${genre}${wcLine}${compsLine}

PITCH / QUERY:
---
${pitch}
---${msExcerpt}

Return the JSON array now. Nothing else.`;

  // Call Claude
  let agents;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2500,
      temperature: 0.4,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    agents = JSON.parse(clean);
    if (!Array.isArray(agents)) throw new Error('Response was not an array');
  } catch (err) {
    console.error('[agent-search] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  // Deduct credits
  const newBalance = balance - COST;
  const { error: updErr } = await supabase
    .from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, {
    agents,
    credits_remaining: newBalance,
    disclaimer: 'Recommendations reflect public information as of model training. Agents move agencies, close to submissions, and update wishlists. Always verify on the agency website and QueryTracker before querying.',
  });
};
