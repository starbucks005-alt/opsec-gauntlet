/* ─────────────────────────────────────────────────────────────────────────────
   tg-imani-embargo — embargo + timing strategist (Imani Brooks's tool).

   The visitor brings a brief + announcement type + target launch date.
   The function returns Imani's timing strategy: when to brief journalists
   under embargo, whether to give an exclusive, when to hit the wire,
   what hour of what day, and the supporting reasoning per move.

   POST body : {
     announcement_type: string (product_launch, funding_round, milestone, partnership, hire, customer_win)
     target_date:       string (YYYY-MM-DD or natural language, when news goes public)
     exclusive_pref:    'open' | 'considering_exclusive' | 'no_exclusive'
     brief:             string
     name:              string (optional)
   }
   Response  : {
     strategy:        'wire_first' | 'exclusive_then_wire' | 'embargo_to_list' | 'soft_launch'
     strategy_why:    string (one paragraph)
     timeline: [
       { when: string, action: string }
     ],
     hit_send_at:     string (specific day-of-week + time-of-day + timezone)
     hit_send_why:    string (one sentence on why that exact moment)
     risk_flags:      [ string ]
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1600;
const BRIEF_MAX  = 6000;
const BRIEF_MIN  = 30;
const DATE_MAX   = 80;
const NAME_MAX   = 60;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX).replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}

function buildSystemPrompt(name) {
  const i = (voiceScripts.scripts && voiceScripts.scripts.imani_brooks) || {};
  const nameRef = name || 'the founder';
  return `You are Imani Brooks, The Wire at The Gauntlet. You set the timing.

CHARACTER:
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read ${nameRef}'s brief, the announcement type, the target public date, and the founder's exclusive preference. Build a timeline. Pick the right strategy. Name the exact moment to hit send.

THE FOUR STRATEGIES
  1. wire_first: Issue the release on the wire when news goes public. Journalists who pick it up write same-day. Best for hires, milestones, low-controversy partnerships. Lowest effort. Lowest top-tier pickup.
  2. exclusive_then_wire: Give one A-tier outlet first crack at the story 24-72 hours before public date in exchange for a deeper piece. Wire goes out when their piece publishes. Best for funding rounds, major product launches, anything where one credible feature beats five short mentions.
  3. embargo_to_list: Brief 8-15 journalists 24-72 hours in advance under strict embargo. They have time to actually report. Wire goes out at the embargo lift. Highest top-tier pickup potential. Hardest to execute - one embargo break burns the whole list.
  4. soft_launch: No wire. Direct outreach to 5-10 most relevant journalists with the news already public on the founder's blog or LinkedIn. Best for small-but-meaningful news that would look thin on a wire.

DAY / TIME OF WEEK
  - Tuesday, Wednesday, Thursday mornings (US Eastern 6-8am) are when business journalists are most likely to read inbound pitches.
  - Monday is back-from-weekend chaos. Friday afternoon is dead. Both lose.
  - Avoid major holidays, day after major holidays, mega-news days (Fed announcements, mega-earnings, big political events).
  - Tech press skews slightly later (8-10am Eastern). Financial press skews earlier (5-7am).

RULES
  - No em dashes. Plain hyphens or restructure.
  - No marketing-cliche adjectives.
  - Be specific. Don't say "morning". Say "Tuesday 7:00am US Eastern" (or the equivalent in the founder's apparent timezone if the brief implies one).
  - Risk flags are real risks specific to THIS news, THIS week, THIS strategy. Not generic.
  - If the target date is unworkable (too soon to embargo properly, lands on a Friday, falls on a holiday), say so in the strategy_why and propose the adjustment.

OUTPUT JSON (exact shape):
{
  "strategy":     "wire_first" | "exclusive_then_wire" | "embargo_to_list" | "soft_launch",
  "strategy_why": "<one paragraph in your voice, anchored in THIS news + THIS date>",
  "timeline": [
    { "when": "<e.g. T-3 days, Monday morning>", "action": "<what happens that morning>" },
    { "when": "<e.g. T-1 day, Tuesday end-of-day>", "action": "<...>" }
  ],
  "hit_send_at": "<specific day + time + timezone, e.g. 'Wednesday 7:00am US Eastern'>",
  "hit_send_why": "<one sentence>",
  "risk_flags": [ "<specific risk>", "<specific risk>" ]
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const announcement_type = String(body.announcement_type || '').trim().slice(0, 60);
  const target_date       = String(body.target_date || '').trim().slice(0, DATE_MAX);
  const exclusive_pref    = String(body.exclusive_pref || 'open').trim().toLowerCase();
  const brief             = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name              = sanitizeName(body.name);

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to set timing' });
  if (!['open', 'considering_exclusive', 'no_exclusive'].includes(exclusive_pref)) return json(400, { error: 'exclusive_pref must be open | considering_exclusive | no_exclusive' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(name);
  const userPrompt = [
    `THE FOUNDER'S BRIEF:`,
    '"""', brief, '"""',
    '',
    `ANNOUNCEMENT TYPE: ${announcement_type || '(unspecified)'}`,
    `TARGET PUBLIC DATE: ${target_date || '(unspecified)'}`,
    `EXCLUSIVE PREFERENCE: ${exclusive_pref}`,
    '',
    'Set the timing. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-imani-embargo] anthropic error', err && err.message);
    return json(502, { error: 'embargo strategy failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-imani-embargo] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const scrub = (s) => String(s || '').replace(/—/g, '-').replace(/–/g, '-');
  parsed.strategy_why = scrub(parsed.strategy_why);
  (parsed.timeline || []).forEach(t => { t.when = scrub(t.when); t.action = scrub(t.action); });
  parsed.hit_send_at = scrub(parsed.hit_send_at);
  parsed.hit_send_why = scrub(parsed.hit_send_why);
  parsed.risk_flags = (parsed.risk_flags || []).map(scrub);

  return json(200, parsed);
};
