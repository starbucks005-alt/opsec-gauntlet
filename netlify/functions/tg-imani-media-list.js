/* ─────────────────────────────────────────────────────────────────────────────
   tg-imani-media-list — targeted media list (Imani Brooks's tool).

   The visitor brings a brief + announcement type + sector. The function
   returns 8-12 named journalists/publications worth pitching, each with a
   reason this beat fits THIS news + a pitch angle tailored to that
   journalist. Imani names real-pattern outlets and lanes (e.g. "the
   FierceBiotech newsletter editor", "TechCrunch's enterprise reporter",
   "Stat News policy desk") rather than inventing specific writer names
   she cannot verify. The visitor uses the list to build their own outreach
   spreadsheet AFTER they verify current contacts at each outlet.

   POST body : {
     announcement_type: string
     sector:            string
     audience_focus:    string (optional, e.g. "enterprise IT buyers", "policy makers", "general consumer")
     brief:             string
     name:              string (optional)
   }
   Response  : {
     list: [
       {
         outlet:        string
         beat_or_desk:  string
         why_them:      string
         pitch_angle:   string
         tier:          'A' | 'B' | 'C'
       },
       ...
     ],
     verification_note: string,    // remind founder to verify current bylines
     pitch_template:    string     // 4-6 line pitch email template they can adapt per outlet
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 2200;
const BRIEF_MAX  = 6000;
const BRIEF_MIN  = 30;
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
  return `You are Imani Brooks, The Wire at The Gauntlet. You build the media list.

CHARACTER:
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read ${nameRef}'s brief and the announcement parameters. Return 8-12 targeted media targets that cover THIS sector and audience focus. Each pick names the outlet and the relevant desk/beat (not a specific writer's name unless that writer is famously beat-defining), explains why this outlet fits THIS news, and supplies a one-sentence pitch angle tailored to that outlet's beat.

TIERING
  - A-tier: top reach + best fit. Pitch these first. 2-4 outlets.
  - B-tier: solid fit, secondary reach. Pitch within 24 hours of A-tier. 4-6 outlets.
  - C-tier: trade-specific or niche but high-quality. Worth the email. 2-4 outlets.

WHAT NOT TO DO
  - Do NOT invent specific writer names you cannot verify (e.g. "Sarah Chen at TechCrunch covers this"). Stay at the desk/beat level (e.g. "TechCrunch enterprise desk").
  - Do NOT pad with generic outlets that don't fit the sector. A short list of real fits beats a long list of misses.
  - Do NOT recommend outlets that have shuttered or pivoted away from this beat.
  - No em dashes anywhere. Plain hyphens or restructure.
  - No marketing-cliche adjectives.

PITCH TEMPLATE
  Provide a 4-6 line subject + body that the founder can adapt per outlet. Personalize-the-{angle} style. Real-sounding subject line that names the news, not generic ("Quick story for [outlet]").

VERIFICATION NOTE
  Remind ${nameRef} that bylines and desk assignments change. The list is a starting point, not a sourced contact sheet. They need to spend 15 minutes per A-tier outlet verifying the current beat reporter before they send.

OUTPUT JSON (exact shape, nothing else):
{
  "list": [
    {
      "outlet":        "<outlet name>",
      "beat_or_desk":  "<the specific desk or beat at that outlet>",
      "why_them":      "<one sentence on why this outlet fits THIS news>",
      "pitch_angle":   "<one sentence: the angle that makes their reader care>",
      "tier":          "A" or "B" or "C"
    }
  ],
  "verification_note": "<one paragraph in your voice on what the founder still has to verify before they send>",
  "pitch_template":    "<subject line + 4-6 line body in plain text, with [PLACEHOLDERS] for the angle that changes per outlet>"
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

  const announcement_type = String(body.announcement_type || '').trim().slice(0, 60);
  const sector            = String(body.sector || '').trim().slice(0, 60);
  const audience_focus    = String(body.audience_focus || '').trim().slice(0, 120);
  const brief             = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name              = sanitizeName(body.name);

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to build a media list' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });
  const systemPrompt = buildSystemPrompt(name);
  const userPrompt = [
    `THE FOUNDER'S BRIEF:`,
    '"""', brief, '"""',
    '',
    `ANNOUNCEMENT TYPE: ${announcement_type || '(unspecified)'}`,
    `SECTOR:            ${sector || '(unspecified)'}`,
    `AUDIENCE FOCUS:    ${audience_focus || '(unspecified)'}`,
    '',
    'Build the media list. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-imani-media-list] anthropic error', err && err.message);
    return json(502, { error: 'media list generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-imani-media-list] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const scrub = (s) => String(s || '').replace(/—/g, '-').replace(/–/g, '-');
  (parsed.list || []).forEach(o => {
    o.why_them = scrub(o.why_them);
    o.pitch_angle = scrub(o.pitch_angle);
  });
  parsed.verification_note = scrub(parsed.verification_note);
  parsed.pitch_template = scrub(parsed.pitch_template);

  return json(200, parsed);
};
