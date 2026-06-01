/* ─────────────────────────────────────────────────────────────────────────────
   tg-imani-oped — bylined op-ed angler (Imani Brooks's tool).

   When a press release is the wrong tool, a bylined op-ed in the right
   outlet can do more for the founder's credibility than a wire blast.
   This function takes the brief + the founder's POV and returns:
   - Whether an op-ed angle is actually defensible here
   - A 3-paragraph op-ed outline (claim, evidence/argument, call-to-action)
   - Two target outlet candidates with rationale per pick
   - A short pitch email to the section editor at the top pick

   POST body : {
     pov:           string (the founder's actual opinion - the thing they could not say in a press release)
     industry_target: string (e.g. "healthtech founders", "FDA policymakers", "K-12 administrators")
     brief:         string
     name:          string (optional)
   }
   Response  : {
     defensible:   { yes: bool, why: string }
     outline:      { hook, argument, close }
     outlets:      [ { name, section, why, fit_score: 'strong'|'medium'|'weak' } ]
     pitch_email:  { subject, body }
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1800;
const BRIEF_MAX  = 6000;
const BRIEF_MIN  = 30;
const POV_MAX    = 400;
const POV_MIN    = 20;
const NAME_MAX   = 60;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX).replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}

function buildSystemPrompt(name) {
  const i = (voiceScripts.scripts && voiceScripts.scripts.imani_brooks) || {};
  const nameRef = name || 'the founder';
  return `You are Imani Brooks, The Wire at The Gauntlet. You are deciding whether ${nameRef}'s news should be a bylined op-ed instead of a press release, and if so, where to pitch it.

CHARACTER:
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read the brief and ${nameRef}'s POV. Decide:
  1. DEFENSIBLE? Is there a real argument here, with evidence? Or is this a wrapped-up sales pitch hoping to look like an essay? Op-ed editors smell the second one instantly and reject it. If it's not defensible, say so plainly and give the founder the version of an argument that WOULD be defensible.
  2. OUTLINE: If defensible, draft a 3-section outline. Hook (specific recent event or contradiction this op-ed responds to). Argument (the founder's claim + 2-3 evidence points that don't come from the founder's own product data). Close (what the reader should do, think, or stop accepting). Each section is 60-120 words of guidance for the founder to write to, not finished prose.
  3. OUTLETS: Name two target outlets. Real outlets that actually run op-eds in this lane. WSJ Opinion, NYT Op-Ed, STAT News First Opinion, Fortune Commentary, The Hill, BuiltIn, sector trade publications with named opinion sections. For each, give a one-sentence why and a fit_score.
  4. PITCH EMAIL: Subject line + 5-8 line body to the section editor (e.g. "WSJ Opinion section editor"). Names the hook, the founder's credibility for THIS argument, the requested length / timing.

RULES
  - No em dashes. Plain hyphens or restructure.
  - No marketing-cliche adjectives anywhere.
  - The op-ed argument must be defensible OUTSIDE the founder's own product. If the only evidence is the founder's own data, the piece is not an op-ed, it is a press release with extra steps.
  - The pitch email reads like Imani wrote it FOR the founder, not in Imani's voice. It's the founder's pitch with Imani's structural rigor.
  - If the op-ed is not defensible, fill outline / outlets / pitch_email with placeholder content explaining what would have to change to make it defensible.

OUTPUT JSON (exact shape):
{
  "defensible": {
    "yes": true_or_false,
    "why": "<one paragraph in your voice. If yes, name the strength. If no, name the gap and what the founder would have to add to earn an op-ed.>"
  },
  "outline": {
    "hook":     "<60-120 words: the recent event, contradiction, or moment this op-ed answers>",
    "argument": "<60-120 words: the claim + the evidence categories the founder needs to bring (not from their own product)>",
    "close":    "<60-120 words: the call-to-action for the reader>"
  },
  "outlets": [
    { "name": "<outlet>", "section": "<section name>", "why": "<one sentence>", "fit_score": "strong" or "medium" or "weak" },
    { "name": "<outlet>", "section": "<section name>", "why": "<one sentence>", "fit_score": "strong" or "medium" or "weak" }
  ],
  "pitch_email": {
    "subject": "<subject line, max 80 chars>",
    "body":    "<5-8 lines plain text, in the founder's voice, addressed to the top outlet's opinion editor>"
  }
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const pov             = String(body.pov || '').trim().slice(0, POV_MAX);
  const industry_target = String(body.industry_target || '').trim().slice(0, 120);
  const brief           = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name            = sanitizeName(body.name);

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to angle an op-ed' });
  if (pov.length < POV_MIN) return json(400, { error: 'POV is too short - what is the founder actually arguing?' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(name);
  const userPrompt = [
    `THE FOUNDER'S BRIEF:`,
    '"""', brief, '"""',
    '',
    `THE FOUNDER'S POV (the actual argument they want to make):`,
    '"""', pov, '"""',
    '',
    `INDUSTRY TARGET: ${industry_target || '(unspecified)'}`,
    '',
    'Angle the op-ed. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-imani-oped] anthropic error', err && err.message);
    return json(502, { error: 'op-ed angling failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-imani-oped] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const scrub = (s) => String(s || '').replace(/—/g, '-').replace(/–/g, '-');
  if (parsed.defensible) parsed.defensible.why = scrub(parsed.defensible.why);
  if (parsed.outline) {
    parsed.outline.hook = scrub(parsed.outline.hook);
    parsed.outline.argument = scrub(parsed.outline.argument);
    parsed.outline.close = scrub(parsed.outline.close);
  }
  (parsed.outlets || []).forEach(o => { o.why = scrub(o.why); });
  if (parsed.pitch_email) {
    parsed.pitch_email.subject = scrub(parsed.pitch_email.subject);
    parsed.pitch_email.body = scrub(parsed.pitch_email.body);
  }

  return json(200, parsed);
};
