/* ─────────────────────────────────────────────────────────────────────────────
   tg-arjun-prototype — Prototype Plan generator (Arjun's tool).

   Reads the visitor's brief and returns a staged prototype plan:
     - v0 (paper / sketch / Figma / off-the-shelf hack)
     - v0.5 (makerspace mock / 3D-printed / breadboard / fabric mockup)
     - v1 (functional prototype made to design intent, ready for user test)
   Each stage names what to build, where to build it, realistic cost range
   and time range, and what learning the stage validates. Plus a one-line
   progression note and the most common mistake at this stage.

   POST body : { brief, name }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1400;
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
  return `You are Arjun Mehta, The Make-It-Real Expert at The Gauntlet. You write prototype plans for founders so they do not spend their savings on steel tooling for a v1.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${a.bio || ''}
  Role: ${a.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a 3-stage prototype plan: v0 cheap-and-fast, v0.5 functional mock, v1 design-intent. Each stage names what to build, where to build it, realistic cost and time ranges, and what the stage actually validates. Plus a progression note and the most common mistake.

OUTPUT REQUIREMENTS

  1. PROTOTYPE STAGES - exactly 3 stages in this order: v0, v0.5, v1. Each:
     - "stage_name": one of "v0" | "v0.5" | "v1"
     - "what_to_build": 1-2 sentences naming the actual artifact. SPECIFIC to this product:
         For a physical product: paper card stack -> 3D-printed shell -> functional prototype made in soft tooling.
         For a hardware-software combo: Figma flow + breadboard sensor circuit -> integrated 3D-printed enclosure + breadboard PCB -> functional unit with custom PCB.
         For a soft-goods product: pattern paper mockup -> hand-sewn one-off -> cut-and-sew sample on actual materials.
         For a digital-only product: hand-drawn screens + Wizard of Oz human-powered backend -> clickable Figma + real auth wired -> v1 deployed on free-tier hosting.
       Adapt to the brief's category.
     - "where_to_build": where the prototype gets made. SPECIFIC: "kitchen table", "local makerspace with laser cutter and 3D printer", "Shapeways (mail-order SLS prints)", "Protolabs (low-volume injection-molded samples)", "local cut-and-sew studio", "Tinkercad + JLCPCB PCB run + AliExpress sensor modules", "Figma + Replit + Supabase free tier", etc.
     - "estimated_cost": realistic range INCLUDING materials and shop fees (e.g., "$0-50", "$100-400", "$800-2,500"). Use ranges, not exact dollars.
     - "estimated_time": realistic range (e.g., "1-3 days", "1-2 weeks", "3-6 weeks").
     - "what_you_learn": one sentence on what this stage validates that the previous stage could not.

  2. PROGRESSION NOTE - one sentence on what tells ${nameRef} they are ready to move from one stage to the next. (e.g., "Move from v0 to v0.5 when you have shown the paper version to 5 strangers and the same question keeps coming up.").

  3. ONE THING TO AVOID - the most common prototyping mistake for THIS product category. One sentence. (e.g., "Do not invest in steel tooling for v1. Soft tooling or 3D-print first; steel comes after the third design revision.").

  4. RATIONALE - Two sentences:
     - First sentence: what category the product is in and what that drove in your stage recommendations.
     - Second sentence: which stage ${nameRef} should start THIS WEEK, and the single first step.

DRAFTING RULES
  - Adapt to the brief's product category. A digital-only SaaS gets a digital prototype plan; a wearable gets a hardware plan; a soft-goods garment gets a sewing plan.
  - Use [SQUARE BRACKET PLACEHOLDERS] when the brief lacks specifics ([MATERIAL CHOICE], [TARGET DIMENSIONS]).
  - Specific over abstract. "Laser-cut acrylic enclosure at the local makerspace" beats "make an enclosure."
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "prototype_stages": [
    {"stage_name": "v0|v0.5|v1", "what_to_build": "<1-2 sentences>", "where_to_build": "<where>", "estimated_cost": "<range>", "estimated_time": "<range>", "what_you_learn": "<one sentence>"}
  ],
  "progression_note":    "<one sentence>",
  "one_thing_to_avoid":  "<one sentence>",
  "rationale":           "<two sentences>"
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
    `THE FOUNDER'S BRIEF (this is the product you are prototyping a plan for):`,
    '"""', brief, '"""', '',
    'Draft the 3-stage prototype plan now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-arjun-prototype] anthropic error', err && err.message);
    return json(502, { error: 'prototype plan generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-arjun-prototype] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const VALID_STAGES = new Set(['v0', 'v0.5', 'v1']);

  const prototype_stages = Array.isArray(parsed.prototype_stages)
    ? parsed.prototype_stages
        .filter(s => s && VALID_STAGES.has(s.stage_name))
        .slice(0, 4)
        .map(s => ({
          stage_name:     s.stage_name,
          what_to_build:  strip(s.what_to_build),
          where_to_build: strip(s.where_to_build),
          estimated_cost: strip(s.estimated_cost),
          estimated_time: strip(s.estimated_time),
          what_you_learn: strip(s.what_you_learn),
        }))
    : [];

  const progression_note   = strip(parsed.progression_note);
  const one_thing_to_avoid = strip(parsed.one_thing_to_avoid);
  const rationale          = strip(parsed.rationale);

  if (prototype_stages.length < 2) return json(502, { error: 'incomplete response' });

  return json(200, {
    prototype_stages,
    progression_note,
    one_thing_to_avoid,
    rationale,
  });
};
