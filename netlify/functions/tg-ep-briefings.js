/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-briefings — tailored one-line first impressions from each of the 9
   Executive Producers, given the visitor's brief and (optionally) their name.

   PARALLEL implementation: 9 concurrent Claude calls (Promise.all), one per
   EP. Wall-clock time becomes ~ the slowest single call (5-10s) instead of
   the sum of all nine (which was busting Netlify's 26s sync cap and
   tripping the corridor's 30s client-side AbortController, leaving every
   card on its generic static quote even when the visitor had uploaded a
   real brief).

   Trade-offs vs single-call:
     - Cost: ~same total tokens, but 9 round-trips instead of 1.
     - Rate-limit: 9 concurrent calls per visitor. Comfortable inside
       Anthropic's per-org RPM at any reasonable site traffic. Revisit
       if we ever scale into thousands of corridor-loads per minute.
     - Resilience: a single slow / failed EP no longer kills the batch.
       Other 8 still personalize; the failed one falls back to its
       static voice-sample quote on the corridor card.

   POST body : {
     brief: string (required, 1-3000 chars) - the visitor's idea
     name:  string (optional, 1-60 chars)   - first name for personal address
   }
   Response  : 200 { briefings: { <ep_id>: { line, invitation }, ... } }
               400 { error } - bad input
               500 { error } - ANTHROPIC_API_KEY missing
               502 { error } - too few EPs returned (sparse output)

   Env vars  : ANTHROPIC_API_KEY (required)
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL          = 'claude-sonnet-4-6';
const BRIEF_MAX      = 3000;
const NAME_MAX       = 60;
const MAX_TOKENS_PER_EP = 400;          // line + invitation fit comfortably under this
const MIN_PRESENT    = 5;               // floor; below this we 502 so the UI can fall back

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

// ── The nine EPs in corridor order. id matches the front-end data-character
// attribute on each .corridor-wing. Each EP carries:
//   - lens: short domain description for the system prompt
//   - voice_register: one phrase that hints at invitation phrasing for THIS
//     EP specifically (Ivy uses "library", Zara uses "studio", Grant uses
//     "my office", etc.) so the model does not blur invitations together.
// ─────────────────────────────────────────────────────────────────────────
const EPS = [
  {
    id: 'ms_ivy',
    name: 'Ms. Ivy',
    role: 'The Librarian',
    lens: 'research and prior art - what already exists, where the real gap is, whether the novelty claim survives a quick scan of adjacent fields',
    voice_register: 'library / "come find me in the library" / "walk through the literature with you"',
  },
  {
    id: 'wren_calloway',
    name: 'Wren Calloway',
    role: 'The Scout',
    lens: 'landscape - prior art and white space (her existing read), where the idea can WORK (markets and beachhead), and other USES the same mechanic could serve in different problem domains',
    voice_register: 'patent room / workshop / "make an appointment if you want to dig into the landscape"',
  },
  {
    id: 'carol_haynes',
    name: 'Carol Haynes',
    role: 'The Screener',
    lens: 'pattern-matching - which comparable venture pattern this idea fits, what worked for that pattern, what failed, whether the variant has legs, the one thing that will kill it before the judges see it',
    voice_register: '"sit down with me and we will walk the intake" / "come see me before the panel does"',
  },
  {
    id: 'matthew_vance',
    name: 'Matthew Vance',
    role: 'The Behaviorist',
    lens: 'purchase psychology - what emotional driver the customer is actually buying on (status, identity, belonging, fear, certainty), the trigger moment that opens the buy window, and which other EP that driver routes into',
    voice_register: '"I have time today if you want to design the fix" / "step in if you want to work the behavior side"',
  },
  {
    id: 'arjun_mehta',
    name: 'Arjun Mehta',
    role: 'The Make-It-Real Expert',
    lens: 'getting from idea to physical product - manufacturer category to call, realistic MOQ and lead time, regulatory route if any, where prototyping actually happens',
    voice_register: '"drop by and I will draw you the manufacturing map" / "come by, we will name who to call first"',
  },
  {
    id: 'zara_cole',
    name: 'Zara Cole',
    role: 'The Influencer',
    lens: 'social media reach, content angles, authentic audience, which platforms actually fit',
    voice_register: 'studio / "swing by the studio and we will cut the Reel" / "come to the studio, we will draft the post"',
  },
  {
    id: 'reid_callum',
    name: 'Reid Callum',
    role: 'The Marketing Expert',
    lens: 'positioning, brand frame, messaging, press release strategy, monetization model - whether the audience can hear it, whether the price anchors who they think you are',
    voice_register: '"come find me when you want to sharpen the positioning" / "drop in, we will price this right"',
  },
  {
    id: 'jules',
    name: 'Jules',
    role: 'The Rewrite Partner',
    lens: 'voice amplification - which sections of the brief already sound like the founder and which read flatter; how to bring the rest up to match the strongest paragraph',
    voice_register: '"let me rewrite [section] with you" / "let us bring the rest up to match"',
  },
  {
    id: 'grant_ellis',
    name: 'Grant Ellis',
    role: 'The Coach',
    lens: 'Chamber prep - which 3 of the 9 judges this brief should face, what those judges will ask, and how the founder walks in rehearsed instead of guessing',
    voice_register: '"come to my office, we will work the pitch on its feet" / "sit down with me before the Chamber"',
  },
];

// ── Per-EP system prompt. Smaller, focused, no nine-EP roster to confuse
// the model. Carries the tone rules and hard constraints inline because
// they apply to every individual call.
// ─────────────────────────────────────────────────────────────────────────
function buildSystemPromptForEP(ep, hasName) {
  const vocativeRule = hasName
    ? '- Address the visitor by name in vocative case (e.g. "Terry, ..."). Use it once at the start of the line. Do not repeat it.'
    : '- No vocative name was provided. Open with the observation directly. Use second-person ("you") sparingly.';

  return `You are ${ep.name}, ${ep.role} at The Gauntlet. The visitor has uploaded a brief describing their idea. You write ONE first-impression briefing in your voice.

YOUR LENS
  ${ep.lens}

YOUR INVITATION REGISTER (use phrasing that fits YOUR voice; do not borrow another EP's register):
  ${ep.voice_register}

YOUR OUTPUT IS TWO FIELDS

  1. line - the OBSERVATION plus a CONCRETE NEXT STEP. This is what appears as your quote on the corridor card.
     ${vocativeRule}
     - 2 to 3 sentences. Punchy. Plain English.
     - From YOUR specific lens. Say something only YOU would notice. Do not blur into generic critique.
     - Specific to THIS brief. Name the actual mechanic, use case, claim, customer. Concreteness is the whole point.
     - Do NOT include the invitation here. The invitation is a separate field. The line ends after the next step.

  2. invitation - the OPEN DOOR. A short clause inviting the visitor to continue the work with you. This becomes the label of the CTA under your briefing.
     - 4 to 10 words. Phrased in YOUR voice. Plain English.
     - Honor YOUR register (see above). Do not put yourself in another EP's office.
     - End with NO trailing punctuation. The UI adds an arrow.

TONE
  - Help the visitor SELL their product. Find what works. Name their skill. Make the product better. Inspire when the brief earns it.
  - When you see a problem, name it with a positive frame. "Your TAM is unfocused" becomes "Your idea works for multiple audiences - pick the one you can win first." Same diagnostic content, solutions-oriented delivery.
  - Lead with what is strong before naming what could be sharper.
  - Your valence depends on what YOU honestly notice in this brief - encouraging, skeptical, missing-info, neutral. Pick whichever fits the read.
  - You are an AI character. Do NOT critique the visitor's writing as "AI-generated" or "template-y because a tool wrote it." (Selene the judge has that lens; it lives in the Chamber, not here.)

HARD CONSTRAINTS
  - No em dashes. None.
  - No flattery. No "great idea." No "love this." No "exciting concept."
  - No "I think," no "you might want to" - direct voice.
  - No quoting the brief back at the visitor.
  - Do not invent facts about the visitor that the brief did not provide.
  - Do NOT reference any other EP inside your line or invitation. You stand alone.
  - If the brief is unintelligible or empty of substance, say so in your voice. Do not fabricate content.

OUTPUT - JSON only, exactly this shape, nothing before or after:
{
  "line":       "<observation + next step, 2-3 sentences>",
  "invitation": "<open door, 4-10 words, your register, no trailing punctuation>"
}`;
}

// ── Single per-EP call. Returns { line, invitation } on success, or
// { error } on any failure (parse, network, empty). Failures do NOT
// throw - they bubble up as soft misses so the batch aggregator can
// keep the other 8 EPs.
// ─────────────────────────────────────────────────────────────────────────
async function generateOneEPBriefing(client, ep, brief, name) {
  const userPrompt = [
    name ? `VISITOR NAME: ${name}` : 'VISITOR NAME: (not provided - omit the vocative)',
    '',
    'BRIEF:',
    brief,
    '',
    `Write YOUR briefing now, as ${ep.name}. JSON only.`,
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS_PER_EP,
      system:     buildSystemPromptForEP(ep, !!name),
      messages:   [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error(`[tg-ep-briefings] anthropic error for ${ep.id}`, err && err.message);
    return { error: 'anthropic_failed' };
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return { error: 'empty' };

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error(`[tg-ep-briefings] parse fail for ${ep.id}`, raw.slice(0, 300));
    return { error: 'parse_failed' };
  }

  let line       = String(parsed.line       || '').trim();
  let invitation = String(parsed.invitation || '').trim();

  // Strip em / en dashes regardless of what the model returns.
  line       = line.replace(/—/g, '-').replace(/–/g, '-');
  invitation = invitation.replace(/—/g, '-').replace(/–/g, '-')
                         .replace(/[.!?]+$/, '');  // UI adds the arrow

  if (!line) return { error: 'no_line' };

  return { line, invitation };
}

// ── Handler ─────────────────────────────────────────────────────────────
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
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = String(body.name  || '').trim().slice(0, NAME_MAX);

  if (!brief) return json(400, { error: 'brief is required' });
  if (brief.length < 12) return json(400, { error: 'brief is too short to read' });

  const client = new Anthropic({ apiKey });

  // Fire all nine in parallel. Promise.all rejects only if ONE of the
  // mapped promises rejects - we already wrap each per-EP call so it
  // resolves with { error } instead of throwing, so Promise.all will
  // settle with all nine results regardless of individual failures.
  const results = await Promise.all(
    EPS.map(ep => generateOneEPBriefing(client, ep, brief, name))
  );

  const briefings = {};
  let presentCount = 0;
  EPS.forEach((ep, i) => {
    const r = results[i];
    if (r && !r.error && r.line) {
      briefings[ep.id] = { line: r.line, invitation: r.invitation || '' };
      presentCount++;
    } else {
      // Empty stub keeps the front-end contract stable - the corridor JS
      // checks for non-empty lines before swapping the card text.
      briefings[ep.id] = { line: '', invitation: '' };
    }
  });

  if (presentCount < MIN_PRESENT) {
    // Less than 5 of 9 returned - something is broken across the board.
    // Surface 502 so the front end falls back to static voice-sample quotes
    // instead of leaving cards stuck on "is reading your brief...".
    console.error('[tg-ep-briefings] sparse output', presentCount, 'of 9');
    return json(502, { error: 'briefings were sparse' });
  }

  return json(200, {
    briefings,
    name_used: !!name,
    // Surface count so the client can show "8 of 9 EPs ready" if useful
    // (currently the UI does not, but the field is cheap).
    present_count: presentCount,
  });
};
