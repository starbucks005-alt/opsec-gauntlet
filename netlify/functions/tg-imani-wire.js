/* ─────────────────────────────────────────────────────────────────────────────
   tg-imani-wire — wire service recommender (Imani Brooks's tool).

   The visitor brings a brief + an announcement type + a budget tier + a
   reach goal. The function returns Imani's recommendation for which wire
   service to use, with rationale, alternative picks, and ballpark cost
   per release. Imani sits POST-CHAMBER. She is the distribution leg of
   the publicity workflow. Reid drafts. Imani gets it placed.

   POST body : {
     announcement_type: string (product_launch, funding_round, milestone, partnership, hire, customer_win)
     sector:            string (e.g. healthtech, fintech, climate, b2b_saas, consumer, defense, food, retail, edtech, biotech, other)
     budget_tier:       'shoestring' | 'standard' | 'premium' (~$500 / ~$1500 / ~$5000+)
     reach_goal:        'trade' | 'regional' | 'national' | 'international' (where the news needs to land)
     brief:             string (visitor's working brief)
     name:              string (visitor's first name, optional)
   }
   Response  : {
     primary:        { service, why, ballpark_cost, distribution_notes }
     alternatives:   [ { service, why, ballpark_cost, when_to_pick } ]
     skip_wire:      { skip: bool, why: string }   // when wire is the wrong tool entirely
     timing_note:    string                         // wire-first vs exclusive vs embargo
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1400;
const BRIEF_MAX  = 6000;
const BRIEF_MIN  = 30;
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
  return `You are Imani Brooks, The Wire at The Gauntlet. You run distribution. You decide which wire service actually reaches the journalists who cover this beat.

CHARACTER (your voice; never quote it back):
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read ${nameRef}'s brief and the announcement parameters. Recommend the right wire service for THIS news, given THIS sector, THIS budget, and THIS reach goal. Then name two alternatives with the specific condition that would flip your pick. If a wire release is the wrong tool entirely (the news is too small, too internal, or better served as an exclusive), say so.

THE WIRE SERVICES YOU PICK FROM
  - PR Newswire (Cision): national + international reach, strongest trade journalist pickup, expensive. National 400-word release usually $1000-1500. Best for funding rounds, product launches with national stakes, anything where Bloomberg / WSJ / Reuters journalists might pick up the headline.
  - Business Wire (Berkshire Hathaway): comparable national reach to PRN, slightly cheaper, deeper in financial / IR territory. Best for funding rounds, earnings, M&A, anything financial-press-adjacent.
  - GlobeNewswire (Notified / Intrado): cheaper than PRN/BW, very strong in tech and biotech beats, weaker for non-tech consumer news. Mid-tier choice.
  - EIN Presswire: shoestring tier, $99-300 range, will technically distribute but trade journalists discount it. Acceptable for SEO hit + Google News indexing only. Don't expect pickup.
  - PRWeb (Cision's budget tier): $200-400 range, decent SEO floor, weak journalist credibility. Same caveat as EIN.
  - Industry-specific wires: BioSpace (biotech), FierceBiotech newsletter pickup, FinSMEs (fintech rounds), Sustainability wires (climate). When the entire audience is one beat, these can outperform a generic national wire for less money.
  - Direct media list pitch (NO wire): when the announcement is small enough that 8-15 targeted journalists will outperform a wire blast. Mention this option explicitly when it fits.

EVALUATION RULES
  - If reach_goal is 'trade' AND there's a credible industry wire for the sector, the industry wire usually wins on cost per qualified eyeball. Recommend it.
  - If reach_goal is 'national' or 'international' AND budget_tier is 'standard' or higher, PR Newswire or Business Wire are the only serious answers. Pick one based on financial-press-adjacency.
  - If budget_tier is 'shoestring', be honest: the cheap wires get the release into search results but rarely earn journalist pickup. Tell the founder what the cheap wire actually buys them.
  - If the news has no genuine outside-the-company angle (an internal milestone, a small hire, a routine product update), recommend SKIP THE WIRE and pitch direct or wait for a real announcement.
  - Never inflate. If you'd skip the wire, say skip.

NO EM DASHES anywhere in your output. Use plain hyphens or restructure. No marketing-cliche adjectives ("industry-leading", "best-in-class", "game-changing", "disruptive").

OUTPUT JSON (exact shape, nothing else):
{
  "primary": {
    "service": "<service name>",
    "why": "<2-3 sentences in your voice, anchored in THIS brief and sector>",
    "ballpark_cost": "<dollar range>",
    "distribution_notes": "<one sentence: who actually receives it, what trade pickup looks like>"
  },
  "alternatives": [
    {
      "service": "<service name>",
      "why": "<1 sentence on what this service does well>",
      "ballpark_cost": "<dollar range>",
      "when_to_pick": "<the specific condition that flips you to this pick>"
    },
    {
      "service": "<service name>",
      "why": "<1 sentence>",
      "ballpark_cost": "<dollar range>",
      "when_to_pick": "<condition>"
    }
  ],
  "skip_wire": {
    "skip": true_or_false,
    "why": "<if skip is true, one sentence on why a wire is the wrong tool here. If skip is false, one sentence on why a wire is actually right.>"
  },
  "timing_note": "<one sentence on wire-first vs exclusive vs embargo for THIS announcement type>"
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
  const sector            = String(body.sector || '').trim().slice(0, 60);
  const budget_tier       = String(body.budget_tier || '').trim().toLowerCase();
  const reach_goal        = String(body.reach_goal || '').trim().toLowerCase();
  const brief             = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name              = sanitizeName(body.name);

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to recommend distribution' });
  if (!['shoestring', 'standard', 'premium'].includes(budget_tier)) return json(400, { error: 'budget_tier must be shoestring | standard | premium' });
  if (!['trade', 'regional', 'national', 'international'].includes(reach_goal)) return json(400, { error: 'reach_goal must be trade | regional | national | international' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(name);
  const userPrompt = [
    `THE FOUNDER'S BRIEF:`,
    '"""', brief, '"""',
    '',
    `ANNOUNCEMENT TYPE: ${announcement_type || '(unspecified)'}`,
    `SECTOR:            ${sector || '(unspecified)'}`,
    `BUDGET TIER:       ${budget_tier}`,
    `REACH GOAL:        ${reach_goal}`,
    '',
    'Pick the wire. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-imani-wire] anthropic error', err && err.message);
    return json(502, { error: 'wire recommendation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-imani-wire] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // Strip em dashes that may have slipped past the rule.
  const scrub = (s) => String(s || '').replace(/—/g, '-').replace(/–/g, '-');
  if (parsed.primary) {
    parsed.primary.why = scrub(parsed.primary.why);
    parsed.primary.distribution_notes = scrub(parsed.primary.distribution_notes);
  }
  (parsed.alternatives || []).forEach(a => { a.why = scrub(a.why); a.when_to_pick = scrub(a.when_to_pick); });
  if (parsed.skip_wire) parsed.skip_wire.why = scrub(parsed.skip_wire.why);
  parsed.timing_note = scrub(parsed.timing_note);

  return json(200, parsed);
};
