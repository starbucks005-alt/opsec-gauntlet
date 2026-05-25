/* ─────────────────────────────────────────────────────────────────────────────
   tg-carol-screen — Screening Report generator (Carol's tool).

   Reads the visitor's brief and returns Carol's pattern-matched read:
   which comparable venture patterns the idea fits, what worked / what
   failed for each pattern, where the visitor's variant sits relative
   to the field, a legs-assessment with internal signal score, tactical
   improvement actions, and the single thing that will kill it.

   Patterns are NAMED in plain language (e.g. "subscription habit tracker
   for fitness comebacks", "B2B compliance SaaS for vertical X"). Specific
   company names are intentionally NOT in the output - companies churn,
   get acquired, change focus, fail without leaving a trail. The pattern
   is the durable directive. Same logic as Arjun's manufacturer shapes.

   POST body : { brief, name }
   Response  : {
     patterns:           [{ pattern_name, what_worked, what_failed, your_position }],
     legs_assessment:    { verdict, signal_score, reasons_for, reasons_against },
     improvement_actions:[{ action, ep_referral? }],
     one_thing_that_kills_it: string,
     rationale:          string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1600;
const BRIEF_MAX  = 6000;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

// Other EPs Carol may route the visitor to as part of improvement actions.
// Carol's routing is lighter than Matthew's - she names a specific EP only
// when an improvement action genuinely lives in that EP's office.
const VALID_EPS = {
  reid_callum:   'Reid (positioning, brand direction)',
  zara_cole:     'Zara (social media content)',
  jules:         'Jules (founder voice in the brief)',
  grant_ellis:   'Grant (Chamber prep)',
  arjun_mehta:   'Arjun (manufacturing, build path)',
  matthew_vance: 'Matthew (buyer psychology)',
  wren_calloway: 'Wren (patent and market landscape)',
  ms_ivy:        'Ivy (research, prior art)',
};

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
  const c = (voiceScripts.scripts && voiceScripts.scripts.carol_haynes) || {};
  const nameRef = name || 'the founder';
  const epList = Object.entries(VALID_EPS).map(([id, label]) => `  - ${id}: ${label}`).join('\n');
  return `You are Carol Haynes, The Screener at The Gauntlet. You build pattern-matched screening reports for founders before they face the panel.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${c.bio || ''}
  Role: ${c.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a screening report that compares this idea against the comparable venture patterns you have seen come through your office over twenty years. You are NOT a market researcher; you are a pattern-matcher. You see the eight underlying shapes that most ideas come in.

OUTPUT REQUIREMENTS

  1. PATTERNS - 3 to 5 comparable venture patterns the idea fits or partially fits. Each pattern includes:
     - "pattern_name": plain-language name (e.g., "subscription habit tracker for fitness comebacks", "vertical B2B compliance SaaS", "marketplace for hourly local services", "physical product targeting nostalgic millennials"). NOT a company name. The pattern is the durable directive.
     - "what_worked": one sentence on what tends to work when founders execute this pattern well.
     - "what_failed": one sentence on the most common failure mode for this pattern.
     - "your_position": one sentence on where the visitor's variant sits relative to this pattern - same, differentiated by [specific factor], or vulnerable to [specific risk].

  2. LEGS ASSESSMENT - Carol's internal read on whether this has legs:
     - "verdict": one of "strong", "has_legs", "marginal", "uphill".
     - "signal_score": integer 1-10. Carol's own quick read, NOT the Chamber score. 1-3 means uphill / dead pattern. 4-6 means marginal / needs work. 7-8 means has legs / strong variant. 9-10 means rare.
     - "reasons_for": 2-4 specific reasons this could work, each one sentence, tied to the brief.
     - "reasons_against": 2-4 specific reasons it could die, each one sentence, tied to the brief.

  3. IMPROVEMENT ACTIONS - 5 to 8 tactical actions ${nameRef} should take BEFORE the panel sees this. Each action:
     - "action": a specific instruction, not generic advice. "Tighten the audience description to nurses on twelve-hour shifts" beats "be clearer about the audience."
     - "ep_referral": OPTIONAL. If this action genuinely lives in another EP's office, name the EP id. Otherwise omit. Valid EP ids (use exactly these strings):
${epList}
     - DO NOT route every action to an EP. Most improvement actions are things ${nameRef} can do themselves. Only route when the action is genuinely that EP's tool.

  4. ONE THING THAT KILLS IT - the single biggest risk Carol sees, named directly. One sentence. The thing she would flag in the first five minutes if ${nameRef} walked into her office.

  5. RATIONALE - Two sentences:
     - First sentence: what about THIS brief drove the primary pattern match.
     - Second sentence: what ${nameRef} should do first, of all the improvement actions you listed.

DRAFTING RULES
  - Honest, not unkind. Carol's tone rule applies every line.
  - Specific over abstract. "The TAM claim of $50B with no segmentation" beats "TAM is vague."
  - If the brief lacks something you need, use a [SQUARE BRACKET PLACEHOLDER]. Never invent.
  - No specific competing company names in the patterns - patterns only. The visitor will search for specific examples themselves.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "patterns": [
    {"pattern_name": "<plain language>", "what_worked": "<one sentence>", "what_failed": "<one sentence>", "your_position": "<one sentence>"}
  ],
  "legs_assessment": {
    "verdict": "strong|has_legs|marginal|uphill",
    "signal_score": <1-10 integer>,
    "reasons_for":     ["<one sentence>", "<one sentence>"],
    "reasons_against": ["<one sentence>", "<one sentence>"]
  },
  "improvement_actions": [
    {"action": "<specific instruction>", "ep_referral": "<optional valid EP id>"}
  ],
  "one_thing_that_kills_it": "<one sentence>",
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
    `THE FOUNDER'S BRIEF (read against the patterns you have seen):`,
    '"""', brief, '"""', '',
    'Draft the screening report now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-carol-screen] anthropic error', err && err.message);
    return json(502, { error: 'screening report generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-carol-screen] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // Patterns
  const patterns = Array.isArray(parsed.patterns) ? parsed.patterns.filter(p => p && p.pattern_name).slice(0, 6) : [];
  // Legs assessment
  const legsRaw = parsed.legs_assessment && typeof parsed.legs_assessment === 'object' ? parsed.legs_assessment : {};
  const VALID_VERDICTS = new Set(['strong', 'has_legs', 'marginal', 'uphill']);
  const legs_assessment = {
    verdict:         VALID_VERDICTS.has(legsRaw.verdict) ? legsRaw.verdict : 'marginal',
    signal_score:    Math.max(1, Math.min(10, parseInt(legsRaw.signal_score, 10) || 5)),
    reasons_for:     Array.isArray(legsRaw.reasons_for)     ? legsRaw.reasons_for.filter(Boolean).slice(0, 5)     : [],
    reasons_against: Array.isArray(legsRaw.reasons_against) ? legsRaw.reasons_against.filter(Boolean).slice(0, 5) : [],
  };
  // Improvement actions - validate ep_referral against the known list
  const improvement_actions = Array.isArray(parsed.improvement_actions)
    ? parsed.improvement_actions
        .filter(a => a && a.action)
        .map(a => {
          const refRaw = String(a.ep_referral || '').trim();
          const ep_referral = VALID_EPS[refRaw] ? refRaw : '';
          return {
            action:      String(a.action).replace(/—/g, '-').replace(/–/g, '-').trim(),
            ep_referral: ep_referral || undefined,
          };
        })
        .slice(0, 10)
    : [];
  const one_thing_that_kills_it = String(parsed.one_thing_that_kills_it || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const rationale = String(parsed.rationale || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!patterns.length || !improvement_actions.length) {
    return json(502, { error: 'incomplete response' });
  }

  return json(200, {
    patterns,
    legs_assessment,
    improvement_actions,
    one_thing_that_kills_it,
    rationale,
  });
};
