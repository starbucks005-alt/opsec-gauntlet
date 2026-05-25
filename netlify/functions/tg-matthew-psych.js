/* ─────────────────────────────────────────────────────────────────────────────
   tg-matthew-psych — Buyer Psychology Profile generator (Matthew's tool).

   Reads the visitor's brief and returns a purchase-psychology profile:
   primary emotional driver, secondary drivers, the trigger moment that
   opens the buy window, identity framing, applied behavioral-econ
   frameworks, AND cross-EP referrals naming which other EP each finding
   routes to. The cross-EP referrals make the deliverable a MAP, not a
   closed loop with Matthew alone.

   POST body : { brief, name }
   Response  : {
     primary_driver:      { driver, why },
     secondary_drivers:   [{ driver, why }],
     trigger_moment:      string,
     identity_framing:    string,
     frameworks_applied:  [{ framework, relevance }],
     cross_ep_referrals:  [{ ep, ep_label, reason }],
     rationale:           string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1400;
const BRIEF_MAX  = 6000;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

// EPs Matthew can route the visitor to. Used to validate the cross-EP
// referrals so the model cannot invent an EP that does not exist.
const VALID_EPS = {
  reid_callum:   'Reid Callum (brand direction, marketing, PR)',
  zara_cole:     'Zara Cole (social media content)',
  jules:         'Jules (founder voice in the brief)',
  grant_ellis:   'Grant Ellis (Chamber prep, judge anticipation)',
  arjun_mehta:   'Arjun Mehta (manufacturing, where it gets made, trust signals)',
  carol_haynes:  'Carol Haynes (intake clarity, audience focus)',
  wren_calloway: 'Wren Calloway (patent / market landscape)',
  ms_ivy:        'Ms. Ivy (research, prior art, literature)',
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
  const m = (voiceScripts.scripts && voiceScripts.scripts.matthew_vance) || {};
  const nameRef = name || 'the founder';
  const epList = Object.entries(VALID_EPS).map(([id, label]) => `  - ${id}: ${label}`).join('\n');
  return `You are Matthew Vance, The Behaviorist at The Gauntlet. You build buyer-psychology profiles for founders who underestimate how much of their customer's decision is emotional.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${m.bio || ''}
  Role: ${m.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a buyer-psychology profile grounded in the actual customer and product. People buy emotion and justify with logic - your job is to surface the emotion under this purchase.

OUTPUT REQUIREMENTS

  1. PRIMARY DRIVER - the SINGLE strongest emotional driver behind the buy:
       - Status (be seen a certain way)
       - Control (regain agency over a process)
       - Belonging (be part of a tribe)
       - Identity (become who they want to be)
       - Fear (avoid a specific loss)
       - Certainty (escape ambiguity)
       - Novelty (the new thing, before others)
       - Care (act on behalf of someone they love)
       - Vindication (be proven right)
       - Mastery (get demonstrably better at something)
     Plus a one-sentence "why" tying it to the brief.

  2. SECONDARY DRIVERS - 2 to 3 supporting drivers from the same list, each with a why.

  3. TRIGGER MOMENT - the SPECIFIC moment the customer feels the pain that opens the buy window. Not "they want X." The actual scene. "It's 11pm, they just finished their fourth attempt, and they cannot tell whether the file saved." That kind of specificity. Tied to the brief.

  4. IDENTITY FRAMING - what the customer wants to BECOME by buying this. One sentence. ("The kind of person whose business runs itself." "The parent who actually figured this out.")

  5. FRAMEWORKS APPLIED - 2 to 4 named behavioral-economics frameworks that fit this purchase, each with a one-sentence "relevance" line. Frameworks to pick from (use real names): Cialdini's principles (reciprocity, commitment, social proof, authority, liking, scarcity, unity), Kahneman fast/slow (System 1 vs System 2), loss aversion, BJ Fogg behavior model (B = MAP: motivation + ability + prompt), defaults / friction, status games, identity-as-product, jobs-to-be-done. Name the framework, then say in one sentence why it fits.

  6. CROSS-EP REFERRALS - 2 to 4 specific other EPs the visitor should walk to next, because psychology turns into deliverables in their offices. Each referral names the EP and ties the psychology directly to that EP's tool:
       - reid_callum: when the primary driver is status / identity / certainty - their brand direction is where the visual signal of that driver lives.
       - zara_cole: when secondary drivers include social proof, belonging, or novelty - her content generator is where the social signal lives.
       - jules: when identity framing means the brief itself needs to sound like the founder, not like a tool.
       - grant_ellis: when the trigger moment maps directly to a judge's likely question (Marcus on exit, Cassidy on behavior, etc.).
       - arjun_mehta: when buying decisions are tied to trust signals about where / how the product is made.
       - carol_haynes: when the customer's emotional driver is so specific that the brief's stated audience needs to narrow to match.
       - wren_calloway: when identity / status driver depends on perceived novelty - check whether the novelty claim survives prior-art scanning.
       - ms_ivy: when the trigger moment maps to a known behavioral-psych literature finding worth grounding.
     VALID EP IDs (use exactly these strings in the "ep" field):
${epList}

  7. RATIONALE - Two sentences:
     - First sentence: the single line about THIS brief that drove your primary-driver choice.
     - Second sentence: the one cross-EP routing that matters MOST for this product, and why ${nameRef} should walk there first.

DRAFTING RULES
  - You see the customer's emotion, not their stated need. Stated needs are noise; emotional drivers are signal.
  - Specific over abstract. "Status among other engineers at conferences" beats "wants status."
  - Use square-bracket placeholders ([TARGET CUSTOMER], [SPECIFIC SCENE]) only when the brief truly lacks the detail. Most of the time the brief gives you enough - you just have to read it the way Matthew reads it.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "primary_driver":     {"driver": "<from the list>", "why": "<one sentence>"},
  "secondary_drivers":  [{"driver": "<from the list>", "why": "<one sentence>"}],
  "trigger_moment":     "<the specific scene>",
  "identity_framing":   "<what the customer wants to become>",
  "frameworks_applied": [{"framework": "<real framework name>", "relevance": "<one sentence>"}],
  "cross_ep_referrals": [{"ep": "<valid EP id>", "ep_label": "<short name like Reid / Zara / Jules>", "reason": "<one sentence tying the driver to that EP's tool>"}],
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
    `THE FOUNDER'S BRIEF (read this for emotion, not stated need):`,
    '"""', brief, '"""', '',
    'Draft the buyer-psychology profile now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-matthew-psych] anthropic error', err && err.message);
    return json(502, { error: 'profile generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-matthew-psych] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // Validate cross-EP referrals against the known list. Drop invalid IDs.
  const referralsRaw = Array.isArray(parsed.cross_ep_referrals) ? parsed.cross_ep_referrals : [];
  const cross_ep_referrals = referralsRaw
    .filter(r => r && VALID_EPS[r.ep])
    .map(r => ({
      ep:       r.ep,
      ep_label: String(r.ep_label || '').trim().slice(0, 40) || (VALID_EPS[r.ep] || '').split(' ')[0],
      reason:   String(r.reason   || '').replace(/—/g, '-').replace(/–/g, '-').trim(),
    }))
    .slice(0, 5);

  const primary = parsed.primary_driver && typeof parsed.primary_driver === 'object' ? parsed.primary_driver : null;
  if (!primary || !primary.driver) return json(502, { error: 'incomplete - no primary driver' });

  const secondary = Array.isArray(parsed.secondary_drivers)
    ? parsed.secondary_drivers.filter(d => d && d.driver).slice(0, 4)
    : [];
  const frameworks = Array.isArray(parsed.frameworks_applied)
    ? parsed.frameworks_applied.filter(f => f && f.framework).slice(0, 5)
    : [];

  const trigger_moment = String(parsed.trigger_moment   || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const identity_framing = String(parsed.identity_framing || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const rationale = String(parsed.rationale || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!trigger_moment || !identity_framing) return json(502, { error: 'incomplete response' });

  return json(200, {
    primary_driver:    primary,
    secondary_drivers: secondary,
    trigger_moment,
    identity_framing,
    frameworks_applied: frameworks,
    cross_ep_referrals,
    rationale,
  });
};
