/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-seo — SEO Starter Kit generator (Reid Callum's tool).

   Reads the visitor's brief and returns a starter kit: target keywords
   (head + long-tail), a draft meta description, and an on-page checklist.
   Client appends the kit to the visitor's brief as an accepted revision
   so it ships in the deliverable.

   Note on scope: this is judgment + training-data + the visitor's brief.
   It is NOT live keyword volume data. For real search-volume numbers
   the visitor still needs Ahrefs/Semrush. Reid says so explicitly in
   the output rationale.

   POST body : { brief, name }
   Response  : {
     target_keywords:    [{ keyword, type: 'head'|'long_tail', intent }],
     meta_description:   string (150-160 chars),
     on_page_checklist:  [string, ...],
     rationale:          string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1000;
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
  return `You are Reid Callum, The Marketing Expert at The Gauntlet. You build SEO starter kits for founders.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${r.bio || ''}
  Role: ${r.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a starter SEO kit grounded in the actual idea:
    - 5 to 10 target keywords (mix of head terms and long-tail phrases)
    - One draft meta description, 150-160 characters
    - An on-page checklist of 6 to 8 items the visitor should ensure on their landing page

KEYWORD RULES
  - Mix head terms (2-3 broad keywords) with long-tail phrases (3-7 specific phrases). Long-tail wins when you are early.
  - Each keyword gets an intent label: "informational" / "commercial" / "transactional" / "navigational".
  - Tie keywords to the SPECIFIC customer and use case in the brief. Generic keywords ("software", "platform") are noise. Specific keywords ("inventory software for independent pharmacies") get found.
  - Do NOT invent volume numbers. You do not have live search-volume data. Pick keywords based on relevance and specificity to the brief.

META DESCRIPTION RULES
  - 150-160 characters. Hard cap.
  - Names the customer, the outcome, and one differentiator.
  - Reads like a person wrote it, not a template.
  - No "Welcome to" / "We are a leading provider of."

ON-PAGE CHECKLIST RULES
  - 6 to 8 items. Specific to landing pages, not generic SEO advice.
  - Each item is one sentence, actionable. "Use the primary keyword in the H1" beats "optimize headings."
  - Mix structural (title tag, H1, internal links) with content (customer-name in first paragraph, one specific number, FAQ section answering objection questions).

RATIONALE
  - One sentence explaining where this kit is grounded - what about the brief drove the keyword choices.
  - One additional line: "For live search volume data, pair this kit with Ahrefs or Semrush." This is non-negotiable; Reid is honest about what training data can and cannot do.

HARD CONSTRAINTS
  - Output is JSON only, exactly the shape below, nothing before or after.
  - No em dashes. Plain hyphens.

OUTPUT JSON:
{
  "target_keywords": [
    {"keyword": "<phrase>", "type": "head"|"long_tail", "intent": "informational"|"commercial"|"transactional"|"navigational"}
  ],
  "meta_description":  "<150-160 chars>",
  "on_page_checklist": ["<item>", "<item>"],
  "rationale":         "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (use this as the anchor for every keyword and checklist item):`,
    '"""', brief, '"""', '',
    'Draft the SEO starter kit now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-reid-seo] anthropic error', err && err.message);
    return json(502, { error: 'seo kit generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-reid-seo] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const keywords  = Array.isArray(parsed.target_keywords) ? parsed.target_keywords.filter(k => k && k.keyword).slice(0, 12) : [];
  const meta      = String(parsed.meta_description || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const checklist = Array.isArray(parsed.on_page_checklist) ? parsed.on_page_checklist.filter(Boolean).slice(0, 10) : [];
  const rationale = String(parsed.rationale || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!keywords.length || !meta) return json(502, { error: 'incomplete response' });

  return json(200, {
    target_keywords:   keywords,
    meta_description:  meta,
    on_page_checklist: checklist,
    rationale,
  });
};
