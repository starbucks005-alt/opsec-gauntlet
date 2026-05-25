/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-brand — Brand Direction generator (Reid Callum's tool).

   Reads the visitor's brief and returns brand-identity direction:
   font pairing recommendations, logo direction (descriptive, not image),
   a color palette with usage notes, and tone descriptors. Words only -
   no image generation. Output is for the visitor to hand to a designer
   (or feed into Figma / Midjourney / a logo tool) as a brief.

   POST body : { brief, name }
   Response  : {
     fonts:            [{ pair: "Display + Body", reason }],
     logo_direction:   [string, ...],         // 3-5 stylistic descriptors
     palette:          [{ hex, name, role }], // 4-5 colors with usage
     tone_descriptors: [string, ...],         // 3-5 voice adjectives
     rationale:        string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1100;
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
  const r = (voiceScripts.scripts && voiceScripts.scripts.reid_callum) || {};
  const nameRef = name || 'the founder';
  return `You are Reid Callum, The Marketing Expert at The Gauntlet. You give founders brand-identity direction grounded in their actual idea.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${r.bio || ''}
  Role: ${r.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return brand direction the visitor can hand to a designer, a logo tool, or use to brief Figma:
    - 2 to 3 FONT PAIRINGS (display + body), each with a one-sentence reason tied to the brief's audience and category
    - 3 to 5 LOGO DIRECTION descriptors - stylistic words that point the designer (e.g., "wordmark, lowercase, monospace lockup with one custom glyph")
    - 4 to 5 COLORS as a palette, each with hex, a short name, and a usage role (primary, secondary, accent, neutral, surface)
    - 3 to 5 TONE DESCRIPTORS - adjectives that describe how the brand should sound across writing and visual choices

RULES
  - This is words only. You do not generate images. Logo direction is descriptive: shape, weight, lockup style, mark type. The visitor will use this as a designer brief.
  - Every choice ties to something in the brief. If the brief targets independent pharmacies, the palette and fonts read differently than if it targets enterprise SaaS buyers. Be specific about WHY.
  - Real font names that exist (Inter, Söhne, Source Serif, Merriweather, Tiempos, IBM Plex, etc.). No invented names.
  - Real hex codes. Format "#RRGGBB" uppercase.
  - Tone descriptors are crisp adjectives ("dry," "patient," "clipped," "warm-bureaucratic") not generic ("professional," "modern," "trustworthy").

RATIONALE
  - Two sentences. First sentence: what about the BRIEF drove these specific choices (which customer, which positioning angle). Second sentence: one thing the visitor should NOT do based on this direction (the trap this brand should avoid).

HARD CONSTRAINTS
  - Output is JSON only, exactly the shape below, nothing before or after.
  - No em dashes anywhere.

OUTPUT JSON:
{
  "fonts": [
    {"pair": "<Display Font + Body Font>", "reason": "<one sentence>"}
  ],
  "logo_direction":   ["<descriptor>", "<descriptor>"],
  "palette": [
    {"hex": "#RRGGBB", "name": "<short name>", "role": "primary"|"secondary"|"accent"|"neutral"|"surface"}
  ],
  "tone_descriptors": ["<adjective>", "<adjective>"],
  "rationale":        "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (every choice you make must trace back to something here):`,
    '"""', brief, '"""', '',
    'Draft the brand direction now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-reid-brand] anthropic error', err && err.message);
    return json(502, { error: 'brand direction generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-reid-brand] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const fonts     = Array.isArray(parsed.fonts) ? parsed.fonts.filter(f => f && f.pair).slice(0, 4) : [];
  const logo      = Array.isArray(parsed.logo_direction) ? parsed.logo_direction.filter(Boolean).slice(0, 6) : [];
  const palette   = Array.isArray(parsed.palette) ? parsed.palette.filter(p => p && /^#[0-9A-Fa-f]{6}$/.test(p.hex || '')).slice(0, 6) : [];
  const tones     = Array.isArray(parsed.tone_descriptors) ? parsed.tone_descriptors.filter(Boolean).slice(0, 6) : [];
  const rationale = String(parsed.rationale || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!fonts.length || !palette.length) return json(502, { error: 'incomplete response' });

  return json(200, {
    fonts,
    logo_direction:   logo,
    palette,
    tone_descriptors: tones,
    rationale,
  });
};
