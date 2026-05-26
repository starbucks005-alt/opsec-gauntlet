/* ─────────────────────────────────────────────────────────────────────────────
   tg-arjun-regulatory — Regulatory Path generator (Arjun's tool).

   Reads the visitor's brief and returns the regulatory route the product
   needs. If FDA / FCC / CPSC / REACH / CPSIA / EU MDR / cosmetics / food /
   privacy regimes apply, names the route, estimated timeline, estimated
   cost range, the first concrete step. If unregulated, says so plainly
   and explains the few compliance items that still might matter (privacy,
   advertising standards, accessibility).

   No legal advice. Arjun maps the path; the founder hires counsel for
   the specifics. The map saves the founder from finding out about a
   regulation six months into tooling.

   POST body : { brief, name }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const BRIEF_MAX  = 6000;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX)
    .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}

function buildSystemPrompt(name) {
  const a = (voiceScripts.scripts && voiceScripts.scripts.arjun_mehta) || {};
  const nameRef = name || 'the founder';
  return `You are Arjun Mehta, The Make-It-Real Expert at The Gauntlet. You map regulatory routes for founders before they tool up and find out they should have talked to a compliance consultant six months earlier.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${a.bio || ''}
  Role: ${a.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Determine whether their product touches a regulated domain. Map the route. This is NOT legal advice; it is a map. The founder hires counsel for the specifics. Your map exists so the founder is not surprised.

OUTPUT REQUIREMENTS

  1. REGULATORY CLASSIFICATION - one classification object:
     - "classification": short label (e.g., "FDA Class II medical device (510(k) likely)", "FCC Part 15 Class B electronics", "CPSIA-compliant children's product (lead and phthalate testing)", "FDA cosmetic with structure/function claims", "FDA food/dietary supplement", "EU MDR Class IIa medical device", "Unregulated consumer good (privacy + advertising standards apply)").
     - "confidence": one of "high" | "medium" | "low" - how confident you are based on what the brief says vs. what is unclear.

  2. ROUTES - 1 to 3 regulatory routes the product likely needs. Each:
     - "route_name": real route name (e.g., "FDA 510(k) Premarket Notification", "FCC Part 15 certification", "CPSIA third-party testing", "EU CE marking under MDR", "FDA OTC Monograph registration").
     - "what_it_requires": 1-2 sentences on what the route involves
     - "estimated_timeline": realistic range (e.g., "3-9 months for 510(k) review post-submission, plus 4-8 months prep").
     - "estimated_cost_range": realistic range INCLUDING consultant fees (e.g., "$25K-75K for 510(k) prep + filing fee").
     - "first_step": ONE concrete next step the founder should take this week (e.g., "consult with an FDA regulatory consultant for a 1-hour scoping call - typical cost $300-600").

  3. TESTING / CERTIFICATION LABS - 2 to 3 TYPES of labs to look for (not specific company names; the types are durable). Each:
     - "lab_type": short label (e.g., "Nationally Recognized Testing Lab (NRTL) for FCC and UL", "ISO 17025-accredited materials lab for CPSIA", "GLP-compliant biocompatibility lab for ISO 10993 testing").
     - "best_for": one sentence on when to engage this type.

  4. ONE THING TO KNOW - the single most important regulatory fact the founder should not forget. One sentence.

  5. RATIONALE - Two sentences:
     - First sentence: what about the brief drove the classification choice. Name the specific feature/claim.
     - Second sentence: the move ${nameRef} should make in the next 30 days based on this map. If the product is unregulated, name the one privacy / advertising / accessibility item that still does apply.

DRAFTING RULES
  - This is a MAP, not legal advice. State that posture in the rationale if needed.
  - Real route names, real classification labels, real lab types. NEVER invent regulation names.
  - Use [SQUARE BRACKET PLACEHOLDERS] when the brief lacks the input (e.g., [TARGET MARKET REGION], [INTENDED USE STATEMENT]).
  - For unregulated products, return classification: "Unregulated consumer good" with confidence and explain what residual compliance items still apply (typically privacy regimes if data is collected, advertising standards if claims are made, accessibility if a digital product).
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "classification": {"classification": "<label>", "confidence": "high|medium|low"},
  "routes": [
    {"route_name": "<real route>", "what_it_requires": "<1-2 sentences>", "estimated_timeline": "<range>", "estimated_cost_range": "<range>", "first_step": "<concrete next step>"}
  ],
  "testing_labs": [
    {"lab_type": "<type>", "best_for": "<one sentence>"}
  ],
  "one_thing_to_know": "<one sentence>",
  "rationale": "<two sentences>"
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `THE FOUNDER'S BRIEF (read this for the regulatory exposure - what is the product, where will it sell, what claims does it make):`,
    '"""', brief, '"""', '',
    'Map the regulatory path now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-arjun-regulatory] anthropic error', err && err.message);
    return json(502, { error: 'regulatory path generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-arjun-regulatory] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const VALID_CONFIDENCE = new Set(['high', 'medium', 'low']);

  const crRaw = parsed.classification && typeof parsed.classification === 'object' ? parsed.classification : null;
  const classification = crRaw ? {
    classification: strip(crRaw.classification),
    confidence:     VALID_CONFIDENCE.has(crRaw.confidence) ? crRaw.confidence : 'medium',
  } : null;

  const routes = Array.isArray(parsed.routes)
    ? parsed.routes.filter(r => r && r.route_name).slice(0, 4).map(r => ({
        route_name:           strip(r.route_name),
        what_it_requires:     strip(r.what_it_requires),
        estimated_timeline:   strip(r.estimated_timeline),
        estimated_cost_range: strip(r.estimated_cost_range),
        first_step:           strip(r.first_step),
      }))
    : [];

  const testing_labs = Array.isArray(parsed.testing_labs)
    ? parsed.testing_labs.filter(l => l && l.lab_type).slice(0, 4).map(l => ({
        lab_type: strip(l.lab_type),
        best_for: strip(l.best_for),
      }))
    : [];

  const one_thing_to_know = strip(parsed.one_thing_to_know);
  const rationale = strip(parsed.rationale);

  if (!classification) return json(502, { error: 'incomplete response' });

  return json(200, {
    classification,
    routes,
    testing_labs,
    one_thing_to_know,
    rationale,
  });
};
