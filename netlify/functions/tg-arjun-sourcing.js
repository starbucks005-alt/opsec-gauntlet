/* ─────────────────────────────────────────────────────────────────────────────
   tg-arjun-sourcing — Sourcing Map generator (Arjun's tool).

   Reads the visitor's brief and returns a sourcing map: bill-of-materials
   categorized by part type, with 2-3 sourcing channels per category, plus
   a critical-path warning list naming any single-source dependencies the
   visitor should de-risk before scaling.

   Channels are GENERAL ("Mouser for electronics", "McMaster-Carr for
   mechanical fasteners") not specific company-and-part-number quotes.
   Specifics go stale; channel-level recommendations are durable.

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
  return `You are Arjun Mehta, The Make-It-Real Expert at The Gauntlet. You build sourcing maps for founders who do not yet know what their bill of materials looks like or where to source each part category.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${a.bio || ''}
  Role: ${a.role || ''}

YOUR JOB
  Read ${nameRef}'s brief and return a sourcing map: part categories that make up this product, example components per category, and 2-3 sourcing channels per category. Plus a critical-path warning list for single-source dependencies.

OUTPUT REQUIREMENTS

  1. CATEGORIES - 4 to 7 part categories that make up the product. Each:
     - "category_name": plain language (e.g., "Custom PCB", "Off-the-shelf electronics modules", "Injection-molded enclosure", "Mechanical fasteners", "Packaging", "Cut-and-sew soft goods", "Battery and charging").
     - "example_parts": 2-3 example components in this category (e.g., for "Off-the-shelf electronics": "ESP32 dev board", "MAX17048 fuel gauge", "ST7789 1.3-inch display").
     - "sourcing_channels": 2-3 channels per category. Each channel:
         - "channel": real channel name ("Mouser", "Digi-Key", "Alibaba", "McMaster-Carr", "ThomasNet", "MakersRow", "Maker's Row", "Tindie", "Adafruit/SparkFun", "JLCPCB", "PCBWay", "Protolabs", "Xometry", "Hubs (formerly 3D Hubs)", "Fabric.com", "ULINE for packaging").
         - "best_for": one short clause on when this channel is the right pick.
         - "gotcha": one short clause on the trap (e.g., "MOQs balloon on second order with Alibaba sellers", "Digi-Key US pricing is high vs. Mouser International on some chip families").

  2. CRITICAL PATH WARNINGS - 2 to 4 specific single-source-dependency or supply-chain-fragility warnings. Each:
     - "item": which part / category is fragile
     - "risk": one sentence on what goes wrong if this dependency breaks
     - "de_risk": one sentence on how to qualify a backup source before shipping

  3. RATIONALE - Two sentences:
     - First sentence: which one or two categories ${nameRef} should source FIRST and why.
     - Second sentence: the channel ${nameRef} should call this week to start, with the specific category name.

DRAFTING RULES
  - Channel-level recommendations only. NO specific product part numbers as if quoting current market pricing - those go stale fast.
  - Use [SQUARE BRACKET PLACEHOLDERS] for facts the brief lacks ([VOLTAGE], [CASE MATERIAL], [VOLUME ESTIMATE]).
  - Honest about scope: if the product is digital-only (software), return categories that fit (cloud hosting, developer tooling, payment processing, customer comms) rather than forcing a hardware BOM frame.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "categories": [
    {
      "category_name": "<plain language>",
      "example_parts": ["<part>", "<part>"],
      "sourcing_channels": [
        {"channel": "<real channel>", "best_for": "<short clause>", "gotcha": "<short clause>"}
      ]
    }
  ],
  "critical_path_warnings": [
    {"item": "<which part/category>", "risk": "<one sentence>", "de_risk": "<one sentence>"}
  ],
  "rationale": "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (this is the product you are mapping the sourcing for):`,
    '"""', brief, '"""', '',
    'Draft the sourcing map now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-arjun-sourcing] anthropic error', err && err.message);
    return json(502, { error: 'sourcing map generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-arjun-sourcing] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  const categories = Array.isArray(parsed.categories)
    ? parsed.categories.filter(c => c && c.category_name).slice(0, 8).map(c => ({
        category_name: strip(c.category_name),
        example_parts: Array.isArray(c.example_parts) ? c.example_parts.filter(Boolean).slice(0, 4).map(strip) : [],
        sourcing_channels: Array.isArray(c.sourcing_channels)
          ? c.sourcing_channels.filter(s => s && s.channel).slice(0, 4).map(s => ({
              channel:  strip(s.channel),
              best_for: strip(s.best_for),
              gotcha:   strip(s.gotcha),
            }))
          : [],
      }))
    : [];

  const critical_path_warnings = Array.isArray(parsed.critical_path_warnings)
    ? parsed.critical_path_warnings.filter(w => w && w.item).slice(0, 6).map(w => ({
        item:    strip(w.item),
        risk:    strip(w.risk),
        de_risk: strip(w.de_risk),
      }))
    : [];

  const rationale = strip(parsed.rationale);

  if (!categories.length) return json(502, { error: 'incomplete response' });

  return json(200, { categories, critical_path_warnings, rationale });
};
