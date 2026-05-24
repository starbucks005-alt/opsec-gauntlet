/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-briefings — tailored one-line first impressions from each of the 9
   Executive Producers, given the visitor's brief and (optionally) their name.

   ONE Claude call returns all nine briefings as JSON so corridor render is a
   single network round-trip. Each line:
     - addresses the visitor by name (vocative case) if provided
     - speaks from that EP's specific domain (not generic)
     - mixed valence: encouraging / skeptical / missing-info / neutral - the
       prompt explicitly forbids monolithic critique OR monolithic praise
     - 1-2 sentences, plain English, no em dashes, no flattery
     - often ends with a concrete next step

   POST body : {
     brief: string (required, 1-3000 chars) - the visitor's idea
     name:  string (optional, 1-60 chars)   - first name for personal address
   }
   Auth      : none for slice 1. Brief comes from the welcome-modal capture
               (sessionStorage); the corridor JS is the only caller in
               practice. Add per-user accounting later when the paywall lands.
   Response  : 200 { briefings: { <ep_id>: "<line>", ... } } - 9 keys
               400 { error: "..." } - bad input
               500 { error: "..." } - ANTHROPIC_API_KEY missing
               502 { error: "..." } - Claude error or unparseable response

   Env vars  : ANTHROPIC_API_KEY (required)
   Cost      : ~$0.02-0.03 per call (Sonnet 4.6, ~2500 tokens combined).
               Cheap enough to call on every corridor visit. If volume scales
               we add prompt caching on the system prompt (90% discount on
               the cached portion).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL      = 'claude-sonnet-4-6';
const BRIEF_MAX  = 3000;
const NAME_MAX   = 60;
const MAX_TOKENS = 1400;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

// ── The nine EPs in corridor order. id matches helpers_master.json so the
// front end can key directly into the response. Domain string is short by
// design - the EP voices in voice_scripts.json already encode the deeper
// character. This is just the LENS each one views the brief through.
const EPS = [
  { id: 'ms_ivy',        name: 'Ms. Ivy',        role: 'The Librarian',        lens: 'research and prior art - what already exists, where the real gap is, whether the novelty claim survives a quick scan of adjacent fields' },
  { id: 'wren_calloway', name: 'Wren Calloway',  role: 'The Scout',            lens: 'patent and trademark landscape, market data, white space - whether the IP and competitive ground are defensible or already crowded' },
  { id: 'carol_haynes',  name: 'Carol Haynes',   role: 'The Screener',         lens: 'honest intake review - what is strong, what is missing, what the judges will flag before the substance gets evaluated' },
  { id: 'matthew_vance', name: 'Matthew Vance',  role: 'The Behaviorist',      lens: 'why people will or will not actually do the thing - the gap between what users say they want and what they do when friction shows up' },
  { id: 'arjun_mehta',   name: 'Arjun Mehta',    role: 'The Delivery Expert',  lens: 'operations, sourcing, supply chain, regulatory compliance, integration burden - how the idea actually gets built and delivered' },
  { id: 'zara_cole',     name: 'Zara Cole',      role: 'The Influencer',       lens: 'social media reach, content potential, whether the message lands with real people on real platforms (TikTok, Reels, Instagram)' },
  { id: 'reid_callum',   name: 'Reid Callum',    role: 'The Marketing Expert', lens: 'positioning, brand frame, messaging - whether the audience can hear it, whether the name and framing widen or shrink the funnel' },
  { id: 'jules',         name: 'Jules',          role: 'The Rewrite Partner',  lens: 'the brief as a piece of writing - AI markers, voice authenticity, whether it sounds like the person who had the idea or like a tool that was asked to describe it' },
  { id: 'grant_ellis',   name: 'Grant Ellis',    role: 'The Coach',            lens: 'the elevator pitch - whether the hook is up front, whether the founder could say this out loud in sixty seconds and have it land' },
];

function buildSystemPrompt() {
  const epList = EPS.map((e, i) =>
    `  ${i + 1}. ${e.name} (${e.role}) [id: ${e.id}]\n     Lens: ${e.lens}`
  ).join('\n');

  return `You are writing 9 first-impression briefings for The Gauntlet, an AI idea-evaluation platform. A visitor has uploaded a brief describing their idea. Each of nine Executive Producers (EPs) gives ONE line in response - their honest first impression from their specific domain.

THE NINE EPS (output keys MUST match the id in brackets):
${epList}

WHAT EACH BRIEFING DOES
  - Addresses the visitor by name in vocative case (e.g. "Terry, ..."). If no name is provided, omit the vocative and open with the observation.
  - Comes from that EP's specific lens. Each EP says something only THEY would notice. Do not let them blur into generic critique.
  - 1 to 2 sentences. Punchy. Plain English.
  - Mixed valence across the nine. Some encouraging, some skeptical, some missing-info flags, some neutral. NEVER all critical. NEVER all encouraging. Match what THIS EP would genuinely first notice in THIS brief - which will naturally split valence across the panel.
  - Often (but not always) ends with a concrete next step: "worth testing," "quick patent check," "let me strip the headers," etc.
  - Specific to the brief. Do not hedge with generalities. If the brief is about a fitness app, name the actual mechanic. If it is about a SaaS tool, name the actual use case. Concreteness is the whole point.

HARD CONSTRAINTS
  - No em dashes. None.
  - No flattery. No "great idea." No "love this." No "exciting concept."
  - No "I think," no "you might want to" - direct voice.
  - No quoting the brief back at the visitor.
  - Do not invent facts about the visitor that the brief did not provide.
  - Each EP stands alone. Do not reference another EP inside a briefing.
  - If the brief is unintelligible or empty of substance, each EP says so in their voice (Carol: "the intake is too thin to read"; Jules: "there is nothing on the page to work with yet"; etc.) - do not fabricate content.

GOLD STANDARD (for a fictional fitness-app brief "Second Chance Fitness," visitor named Terry):
  matthew_vance: "Terry, this idea has psychological legs. The all-or-nothing pattern is well-documented and underserved. My one concern: does the grace period extend procrastination rather than break it? Worth testing before the panel."
  arjun_mehta: "Terry, the wearables integration is the real operational burden. Five APIs minimum - Apple HealthKit, Google Fit, Fitbit, Garmin, Whoop - each with its own auth quirks. That's six months of engineering before the app feels seamless."
  jules: "Terry, this brief reads like it was structured by AI, not written by you. Selene will clock it in the first sentence. Let me strip the headers and put the idea in your own voice before the panel sees it."

OUTPUT - JSON only, exactly this shape, nothing before or after:
{
  "briefings": {
    "ms_ivy":        "<one line>",
    "wren_calloway": "<one line>",
    "carol_haynes":  "<one line>",
    "matthew_vance": "<one line>",
    "arjun_mehta":   "<one line>",
    "zara_cole":     "<one line>",
    "reid_callum":   "<one line>",
    "jules":         "<one line>",
    "grant_ellis":   "<one line>"
  }
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = String(body.name  || '').trim().slice(0, NAME_MAX);

  if (!brief) {
    return json(400, { error: 'brief is required' });
  }
  if (brief.length < 12) {
    return json(400, { error: 'brief is too short to read' });
  }

  const userPrompt = [
    name ? `VISITOR NAME: ${name}` : 'VISITOR NAME: (not provided - omit the vocative)',
    '',
    'BRIEF:',
    brief,
    '',
    'Write the nine briefings now, as JSON. Match the gold-standard tone. Mixed valence across the nine.',
  ].join('\n');

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-ep-briefings] anthropic error', err.message);
    return json(502, { error: 'briefings generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!raw) {
    return json(502, { error: 'briefings response was empty' });
  }

  // Tolerant JSON parse: extract first {...} block in case the model wraps
  // its output in commentary despite the system prompt instruction.
  let parsed = null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('[tg-ep-briefings] could not parse model output', raw.slice(0, 500));
    return json(502, { error: 'briefings output was not valid json' });
  }

  const raw_briefings = (parsed && parsed.briefings) || {};
  const briefings = {};
  let presentCount = 0;
  for (const ep of EPS) {
    const line = String(raw_briefings[ep.id] || '').trim();
    if (line) {
      // Strip any sneaky em dashes the model may have inserted despite the rule.
      briefings[ep.id] = line.replace(/—/g, '-').replace(/–/g, '-');
      presentCount++;
    } else {
      // Empty string per EP rather than missing key - keeps the front-end
      // contract stable (it can always read briefings.<id>).
      briefings[ep.id] = '';
    }
  }

  if (presentCount < 5) {
    // Less than 5 of 9 EPs produced a line - something went sideways, surface
    // as 502 so the front end can fall back to static quotes.
    console.error('[tg-ep-briefings] sparse output', presentCount, 'of 9');
    return json(502, { error: 'briefings were sparse' });
  }

  return json(200, {
    briefings,
    name_used: !!name,
  });
};
