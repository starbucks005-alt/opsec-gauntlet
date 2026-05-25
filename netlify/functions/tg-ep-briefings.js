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
  { id: 'jules',         name: 'Jules',          role: 'The Rewrite Partner',  lens: 'voice amplification - which sections of the brief already sound like the founder and which read flatter; how to bring the rest up to match the strongest paragraph' },
  { id: 'grant_ellis',   name: 'Grant Ellis',    role: 'The Coach',            lens: 'Chamber prep - which 3 of the 9 judges this brief should face, what those judges will ask, and how the founder walks in rehearsed instead of guessing' },
];

function buildSystemPrompt() {
  const epList = EPS.map((e, i) =>
    `  ${i + 1}. ${e.name} (${e.role}) [id: ${e.id}]\n     Lens: ${e.lens}`
  ).join('\n');

  return `You are writing 9 first-impression briefings for The Gauntlet, an AI idea-evaluation platform. A visitor has uploaded a brief describing their idea. Each of nine Executive Producers (EPs) gives ONE line in response - their honest first impression from their specific domain.

THE NINE EPS (output keys MUST match the id in brackets):
${epList}

EACH BRIEFING IS TWO FIELDS

  1. line - the OBSERVATION plus a CONCRETE NEXT STEP. This is what
     appears as the EP's quote on the corridor card.
       - Addresses the visitor by name in vocative case (e.g. "Terry, ...").
         If no name is provided, omit the vocative and open with the observation.
       - 2 to 3 sentences. Punchy. Plain English.
       - From this EP's specific lens. Each EP says something only THEY
         would notice. Do not let them blur into generic critique.
       - Specific to the brief. Name the actual mechanic / use case /
         claim. Concreteness is the whole point.
       - Do NOT include the invitation here. The invitation is a separate
         field. The line ends after the next step.

  2. invitation - the OPEN DOOR. A short clause inviting the visitor to
     continue the work with that EP. This becomes the label of the CTA
     button under the briefing on the corridor card.
       - 4 to 10 words. Phrased in the EP's voice. Plain English.
       - VARY THE PHRASING across the nine EPs each run. Do not start
         every one with "stop by my office." Pull from a range:
           "Come find me in the library"
           "Make an appointment if you want to dig into the landscape"
           "Sit down with me and we will walk the intake"
           "I have time today if you want to design the fix"
           "Drop by and I will draw you the integration map"
           "Swing by the studio and we will cut the Reel"
           "Come find me when you want to sharpen the positioning"
           "Let me rewrite this with you"
           "Come to my office and we will work the pitch on its feet"
       - End the invitation with NO trailing punctuation. The UI adds an
         arrow.
       - Honors the EP's register: Ivy uses "library," Wren uses
         "workshop" or "the patent room," Zara uses "studio," Jules uses
         "let me rewrite," Grant uses "my office, work the pitch," etc.
         Do not put Zara in a library or Ivy in a studio.

VALENCE AND CONCRETENESS RULES (apply to both fields)
  - Mixed valence across the nine. Some encouraging, some skeptical, some
    missing-info flags, some neutral. NEVER all critical. NEVER all
    encouraging. Match what THIS EP would genuinely first notice in THIS
    brief - the valence naturally splits across nine domains.

TONE - apply to every line you write
  - Your job is to help the visitor SELL their product, find what works, name their skills, make the product better, and inspire.
  - When you see a problem, name it with a positive frame. "Your TAM is unfocused" becomes "Your idea works for multiple audiences - pick the one you can win first." Same diagnostic content, solutions-oriented delivery.
  - Lead with what is strong before naming what could be sharper.
  - You (every EP) are an AI character. Do NOT critique the visitor's writing as "AI-generated" or "template-y because a tool wrote it." That makes you sound hypocritical and breaks the relationship. (Selene the judge has that lens; it lives in the Chamber, not here.)
  - "Tell negatives with a positive spin." The product is the thing you are both trying to make better. Talk about it like a teammate, not a critic.

HARD CONSTRAINTS
  - No em dashes. None.
  - No flattery. No "great idea." No "love this." No "exciting concept."
  - No "I think," no "you might want to" - direct voice.
  - No quoting the brief back at the visitor.
  - Do not invent facts about the visitor that the brief did not provide.
  - Each EP stands alone. Do not reference another EP inside a briefing.
  - If the brief is unintelligible or empty of substance, each EP says so in their voice (Carol: "the intake is too thin to read"; Jules: "there is nothing on the page to work with yet"; etc.) - do not fabricate content.

GOLD STANDARD (for a fictional fitness-app brief "Second Chance Fitness," visitor named Terry). Each entry shows the line/invitation split:

  matthew_vance:
    line:       "Terry, the risk the panel will raise is that a 7-day grace period does not eliminate perfectionist guilt, it delays it. Users who miss day one may spend six days avoiding the app entirely rather than making it up. That behavior needs to be designed against, not assumed away."
    invitation: "I have time today if you want to design the fix"

  arjun_mehta:
    line:       "Terry, 'syncs with standard health apps' is doing a lot of heavy lifting. Apple HealthKit, Google Fit, Garmin, Fitbit, and Whoop all have separate auth flows and data schemas, and retroactive workout logging hits different permission walls on each one."
    invitation: "Drop by and I will draw you the integration map"

  jules:
    line:       "Terry, the opening paragraph already sounds exactly like you - that's the tuning fork. The features section can be in the same voice; right now it reads flatter than the rest of the brief, so the judges will hear two different people. We bring it up to match and the whole brief lands harder."
    invitation: "Let me rewrite the Key Features block with you"

  ms_ivy:
    line:       "Terry, Nir Eyal's work on habit loops and the 'fresh start effect' literature both touch this exact problem, and there are at least two academic papers on streak-loss demotivation in fitness apps worth pulling before you position Bounceback as a gap."
    invitation: "Come find me in the library and we will walk through them"

  zara_cole:
    line:       "Terry, the founder origin story - ice packs, heat blanket, six months, two days in bed - is a 30-second Reel that writes itself, and that hook will outperform any feature explainer you could post."
    invitation: "Swing by the studio and we will cut it together"

OUTPUT - JSON only, exactly this shape, nothing before or after:
{
  "briefings": {
    "ms_ivy":        {"line": "<observation + next step>", "invitation": "<open door, varied phrasing>"},
    "wren_calloway": {"line": "<...>", "invitation": "<...>"},
    "carol_haynes":  {"line": "<...>", "invitation": "<...>"},
    "matthew_vance": {"line": "<...>", "invitation": "<...>"},
    "arjun_mehta":   {"line": "<...>", "invitation": "<...>"},
    "zara_cole":     {"line": "<...>", "invitation": "<...>"},
    "reid_callum":   {"line": "<...>", "invitation": "<...>"},
    "jules":         {"line": "<...>", "invitation": "<...>"},
    "grant_ellis":   {"line": "<...>", "invitation": "<...>"}
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
    const entry = raw_briefings[ep.id];
    let line = '';
    let invitation = '';
    if (entry && typeof entry === 'object') {
      // New shape: { line, invitation }
      line       = String(entry.line       || '').trim();
      invitation = String(entry.invitation || '').trim();
    } else if (typeof entry === 'string') {
      // Tolerate the old single-string shape in case the model regresses.
      // Treat the whole thing as the line; no invitation.
      line = entry.trim();
    }
    // Strip em / en dashes the model may have inserted despite the rule.
    line       = line      .replace(/—/g, '-').replace(/–/g, '-');
    invitation = invitation.replace(/—/g, '-').replace(/–/g, '-')
                           .replace(/[.!?]+$/, '');  // no trailing punctuation - UI adds the arrow
    if (line) {
      briefings[ep.id] = { line, invitation };
      presentCount++;
    } else {
      // Empty stub per EP - keeps the front-end contract stable
      briefings[ep.id] = { line: '', invitation: '' };
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
