/* ─────────────────────────────────────────────────────────────────────────────
   tg-arjun-manufacturing — Manufacturing Roadmap generator (Arjun's tool).

   Reads the visitor's brief and returns a roadmap for getting from idea
   to physical product. Categorizes the product class, ranks manufacturing
   approach options by stage, names manufacturer SHAPES (not specific
   companies - those go stale), lists realistic MOQs and lead times, and
   surfaces the questions to ask before signing.

   Names of specific contract manufacturers are intentionally NOT in the
   output. Companies churn, get acquired, change focus, get bad reviews.
   The shape ("Shenzhen consumer electronics CM with FCC experience")
   is the durable directive. The visitor uses that shape to search.

   POST body : { brief, name }
   Response  : {
     product_category:     string,
     approach_options:     [{ stage, name, when_it_fits, est_moq, est_lead_time }],
     manufacturer_shapes:  [{ shape, region, why }],
     questions_to_ask:     [string, ...],
     rationale:            string
   }
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
  return `You are Arjun Mehta, The Make-It-Real Expert at The Gauntlet. You build manufacturing roadmaps for founders who do not know who to call to get their idea built.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${a.bio || ''}
  Role: ${a.role || ''}

YOUR JOB
  Read ${nameRef}'s brief and return a manufacturing roadmap grounded in the actual idea. The output goes into the visitor's deliverable.

OUTPUT REQUIREMENTS
  1. PRODUCT CATEGORY - One concise classification line. Examples:
       "Consumer electronics (low-volume wearable, FCC class B)"
       "Soft goods (cut-and-sew apparel, no regulatory exposure)"
       "Class II medical device (FDA 510(k) likely)"
       "Packaged food (FDA registration, state cottage food law in play)"
       "Digital-only - no physical product"
     Be specific enough that a reader knows the regulatory and tooling landscape.

  2. APPROACH OPTIONS - 3 to 4 options ranked from earliest stage to scale:
     - "stage": one of "prototype", "small_run", "mid_volume", "scale"
     - "name": short descriptor ("Makerspace + 3D-printed v1", "Domestic small-run CM", etc.)
     - "when_it_fits": one sentence on when this is the right move
     - "est_moq": realistic minimum order quantity (e.g. "1-20 units", "100-500 units", "5,000-10,000 units"). Use ranges, not exact numbers.
     - "est_lead_time": realistic lead time (e.g. "2-4 weeks", "8-14 weeks", "16-26 weeks"). Use ranges.

  3. MANUFACTURER SHAPES - 5 to 8 SHAPES (not specific company names) the visitor should be looking for. Each shape includes:
     - "shape": the descriptor ("Shenzhen consumer electronics CM with FCC experience", "Tijuana medical device CM", "Pennsylvania cut-and-sew mill", "Local makerspace with laser cutter and CNC", "Domestic injection molder for low-MOQ pilots")
     - "region": which region or type of region ("Shenzhen / Dongguan", "Mexico (Tijuana / Monterrey)", "US Northeast", "Local makerspace", "EU - Czechia or Poland for short lead times")
     - "why": one sentence on why this shape fits THIS product category
   - DO NOT name specific companies. Specific companies go stale, get acquired, change focus. The shape is the durable directive. The visitor uses the shape to search.

  4. QUESTIONS TO ASK - 5 to 8 questions the visitor should ask EVERY manufacturer on the first call. Aim for the ones that separate real CMs from brokers, real shops from drop-shippers:
     - "Can I tour the facility, or speak with a current client at my volume tier?"
     - "What is your MOQ for the first run AND for the second run?" (Brokers raise MOQs on the second order. CMs do not.)
     - "Who owns the tooling once paid? Me, or you?"
     - "What is your QC process - inline checks during production, or final-pack inspection only?"
     - "How do you handle changes between revisions - cost and lead time impact?"
     - "Can you send a quote on a sample run before committing to tooling?"
     - "Do you have direct experience with [specific regulatory requirement, e.g. FCC, FDA 510k, REACH, CPSIA]?"
     - "Who is the project manager I will actually be talking to during production?"
     Pick the ones that hit hardest for THIS category.

  5. RATIONALE - Two sentences:
     - First sentence: what single thing about the brief makes this category recommendation hold.
     - Second sentence: the ONE biggest risk Arjun sees in the visitor's path, named directly.

DRAFTING RULES
  - Use square-bracket placeholders ([REGULATORY DETAIL], [BUDGET RANGE], [TARGET MARKET], [LAUNCH DATE]) for anything the brief does not specify. Never invent facts.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON. No commentary.

OUTPUT JSON:
{
  "product_category": "<one line>",
  "approach_options": [
    {"stage": "prototype|small_run|mid_volume|scale", "name": "<short descriptor>", "when_it_fits": "<one sentence>", "est_moq": "<range>", "est_lead_time": "<range>"}
  ],
  "manufacturer_shapes": [
    {"shape": "<descriptor>", "region": "<region>", "why": "<one sentence>"}
  ],
  "questions_to_ask": ["<question>", "<question>"],
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
    `THE FOUNDER'S BRIEF (this is the idea you are mapping - use only what's here, [PLACEHOLDER] anything missing):`,
    '"""', brief, '"""', '',
    'Draft the manufacturing roadmap now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-arjun-manufacturing] anthropic error', err && err.message);
    return json(502, { error: 'manufacturing roadmap generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-arjun-manufacturing] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const product_category = String(parsed.product_category || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const approach_options = Array.isArray(parsed.approach_options) ? parsed.approach_options.filter(o => o && o.name).slice(0, 5) : [];
  const manufacturer_shapes = Array.isArray(parsed.manufacturer_shapes) ? parsed.manufacturer_shapes.filter(s => s && s.shape).slice(0, 10) : [];
  const questions_to_ask = Array.isArray(parsed.questions_to_ask) ? parsed.questions_to_ask.filter(Boolean).slice(0, 10) : [];
  const rationale = String(parsed.rationale || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!product_category || !approach_options.length || !manufacturer_shapes.length) {
    return json(502, { error: 'incomplete response' });
  }

  return json(200, {
    product_category,
    approach_options,
    manufacturer_shapes,
    questions_to_ask,
    rationale,
  });
};
