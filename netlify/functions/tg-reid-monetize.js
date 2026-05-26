/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-monetize — Monetization Strategy generator (Reid's tool).

   Reads the visitor's brief and returns Reid's monetization read:
     - Pricing model recommendation (subscription / usage_based / freemium /
       per_seat / transactional / tiered / one_time / hybrid)
     - 2-3 concrete pricing tier suggestions with anchor prices
     - Revenue stream mix (primary + secondary)
     - Comparable monetization pattern (pattern_name + what_worked +
       what_failed + your_position - same shape as Carol's patterns)
     - Pricing psychology levers (light cross-pollination with Matthew's
       behavioral frame - which Cialdini / loss aversion / identity hooks
       apply when this product is priced)
     - Launch pricing strategy (where to start, when to raise)
     - One thing to avoid

   Prices are presented as ANCHOR ranges, not exact dollar amounts. The
   visitor will validate with their own market data. Reid is honest that
   the model does not have current price-of-X data; the ranges are
   read-of-the-pattern, not market quotes.

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

const VALID_PRICING_TYPES = new Set([
  'subscription', 'usage_based', 'freemium', 'per_seat',
  'transactional', 'tiered', 'one_time', 'hybrid',
]);

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
  return `You are Reid Callum, The Marketing Expert at The Gauntlet. You build monetization strategies for founders before they price the thing wrong and burn six months.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${r.bio || ''}
  Role: ${r.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a monetization strategy grounded in the actual product, customer, and category. Pricing is positioning - the move you choose anchors who the customer thinks you are.

OUTPUT REQUIREMENTS

  1. PRICING MODEL - the recommended primary pricing model. Object with:
     - "type": one of "subscription" | "usage_based" | "freemium" | "per_seat" | "transactional" | "tiered" | "one_time" | "hybrid"
     - "why": 2-3 sentences on why this model fits THIS product and customer. Reference the actual customer behavior the model assumes.

  2. PRICING TIERS - 2 to 3 concrete tier suggestions. Each tier:
     - "name": short name ("Starter", "Pro", "Team", "Founder Pricing", etc. - or a category-specific name)
     - "price_anchor": a realistic anchor PRICE RANGE in USD (e.g., "$19-29/month", "$0 + 2% per transaction", "$2,400-3,600 one-time"). Use ranges. NEVER an exact dollar amount as if quoting a market.
     - "what_it_includes": 1-2 sentences naming the specific capability set
     - "target_buyer": one short phrase naming the specific customer this tier is for
   - If the brief lacks pricing context, use [PRICE RANGE] placeholders.

  3. REVENUE STREAMS - primary + 1-2 secondary streams. Object with:
     - "primary": { "type": short label like "Subscription SaaS", "Transaction fee", "Marketplace commission", "License + services". "estimated_share": rough percentage as a number 0-100. "rationale": one sentence }
     - "secondary": array of 0-2 items, each with the same shape as primary
   - Total share should sum to roughly 100. Use the secondary streams to surface monetization options the brief might be ignoring.

  4. MONETIZATION PATTERN - the comparable pattern this idea fits. Same shape Carol uses for venture patterns. Object with:
     - "pattern_name": plain-language pattern (e.g., "vertical SaaS for SMBs with low marketing budget", "platform with payments-as-monetization", "open-source-core with paid hosting").
     - "what_worked": one sentence on what tends to work for this monetization pattern
     - "what_failed": one sentence on the most common failure mode for this pattern
     - "your_position": one sentence on where the visitor's variant sits relative to this pattern

  5. PRICING PSYCHOLOGY - 2 to 3 psychological levers to apply when pricing. Light cross-pollination with Matthew's domain - the buyer's emotional driver shapes which lever works. Each lever:
     - "lever": one of "scarcity" | "social_proof" | "loss_aversion" | "anchoring" | "identity_pricing" | "decoy_effect" | "certainty_close" | "reciprocity"
     - "how_to_apply": one sentence on how this lever shows up in the pricing or sales flow for THIS product

  6. LAUNCH STRATEGY - the pricing motion for go-to-market. Object with:
     - "start_at": where to start (e.g., "Founder Pricing at $39/month for first 100 customers", "free pilot + paid expansion", "white-glove $5K pilots until 5 case studies")
     - "when_to_raise": the specific signal that means it is time to raise prices (e.g., "when conversion exceeds 8% on cold landing page traffic", "when third unsolicited inbound case study lands")
     - "why": one sentence on why this motion fits

  7. ONE THING TO AVOID - the single biggest pricing mistake Reid sees in the brief. One sentence.

  8. RATIONALE - Two sentences:
     - First sentence: what about THIS brief drove the pricing-model recommendation
     - Second sentence: the one move ${nameRef} should make in the next 30 days based on this strategy

DRAFTING RULES
  - Honest about what the model can and cannot do. The price ranges are based on PATTERN reads, not live market data. Surface that in the rationale if relevant.
  - Use square-bracket placeholders ([PRICE RANGE], [CUSTOMER SIZE], [TARGET MARGIN]) when the brief lacks the input. Never invent specific numbers as if quoting real data.
  - Pattern-matching over specific company-name dropping. Same rule as Carol.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "pricing_model": {"type": "<one of the valid types>", "why": "<2-3 sentences>"},
  "pricing_tiers": [
    {"name": "<short name>", "price_anchor": "<range>", "what_it_includes": "<1-2 sentences>", "target_buyer": "<short phrase>"}
  ],
  "revenue_streams": {
    "primary":   {"type": "<short label>", "estimated_share": <0-100>, "rationale": "<one sentence>"},
    "secondary": [{"type": "<short label>", "estimated_share": <0-100>, "rationale": "<one sentence>"}]
  },
  "monetization_pattern": {
    "pattern_name": "<plain language>",
    "what_worked":  "<one sentence>",
    "what_failed":  "<one sentence>",
    "your_position": "<one sentence>"
  },
  "pricing_psychology": [
    {"lever": "<valid lever>", "how_to_apply": "<one sentence>"}
  ],
  "launch_strategy": {
    "start_at":     "<motion>",
    "when_to_raise": "<signal>",
    "why":          "<one sentence>"
  },
  "one_thing_to_avoid": "<one sentence>",
  "rationale":          "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (this is the product and customer you are pricing):`,
    '"""', brief, '"""', '',
    'Draft the monetization strategy now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-reid-monetize] anthropic error', err && err.message);
    return json(502, { error: 'monetization strategy generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-reid-monetize] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  // Pricing model - validate type
  const pmRaw = parsed.pricing_model && typeof parsed.pricing_model === 'object' ? parsed.pricing_model : null;
  const pricing_model = pmRaw && VALID_PRICING_TYPES.has(pmRaw.type) ? {
    type: pmRaw.type,
    why:  strip(pmRaw.why),
  } : null;

  // Tiers
  const pricing_tiers = Array.isArray(parsed.pricing_tiers)
    ? parsed.pricing_tiers.filter(t => t && t.name).slice(0, 4).map(t => ({
        name:             strip(t.name),
        price_anchor:     strip(t.price_anchor),
        what_it_includes: strip(t.what_it_includes),
        target_buyer:     strip(t.target_buyer),
      }))
    : [];

  // Revenue streams
  const rsRaw = parsed.revenue_streams && typeof parsed.revenue_streams === 'object' ? parsed.revenue_streams : {};
  function cleanStream(s) {
    if (!s || !s.type) return null;
    const share = Math.max(0, Math.min(100, parseInt(s.estimated_share, 10) || 0));
    return {
      type:            strip(s.type),
      estimated_share: share,
      rationale:       strip(s.rationale),
    };
  }
  const revenue_streams = {
    primary:   cleanStream(rsRaw.primary),
    secondary: Array.isArray(rsRaw.secondary) ? rsRaw.secondary.map(cleanStream).filter(Boolean).slice(0, 3) : [],
  };

  // Monetization pattern
  const mpRaw = parsed.monetization_pattern && typeof parsed.monetization_pattern === 'object' ? parsed.monetization_pattern : null;
  const monetization_pattern = mpRaw && mpRaw.pattern_name ? {
    pattern_name:  strip(mpRaw.pattern_name),
    what_worked:   strip(mpRaw.what_worked),
    what_failed:   strip(mpRaw.what_failed),
    your_position: strip(mpRaw.your_position),
  } : null;

  // Pricing psychology
  const VALID_LEVERS = new Set([
    'scarcity', 'social_proof', 'loss_aversion', 'anchoring',
    'identity_pricing', 'decoy_effect', 'certainty_close', 'reciprocity',
  ]);
  const pricing_psychology = Array.isArray(parsed.pricing_psychology)
    ? parsed.pricing_psychology.filter(p => p && VALID_LEVERS.has(p.lever)).slice(0, 4).map(p => ({
        lever:        p.lever,
        how_to_apply: strip(p.how_to_apply),
      }))
    : [];

  // Launch strategy
  const lsRaw = parsed.launch_strategy && typeof parsed.launch_strategy === 'object' ? parsed.launch_strategy : null;
  const launch_strategy = lsRaw ? {
    start_at:       strip(lsRaw.start_at),
    when_to_raise:  strip(lsRaw.when_to_raise),
    why:            strip(lsRaw.why),
  } : null;

  const one_thing_to_avoid = strip(parsed.one_thing_to_avoid);
  const rationale          = strip(parsed.rationale);

  if (!pricing_model || !pricing_tiers.length || !revenue_streams.primary) {
    return json(502, { error: 'incomplete response' });
  }

  return json(200, {
    pricing_model,
    pricing_tiers,
    revenue_streams,
    monetization_pattern,
    pricing_psychology,
    launch_strategy,
    one_thing_to_avoid,
    rationale,
  });
};
