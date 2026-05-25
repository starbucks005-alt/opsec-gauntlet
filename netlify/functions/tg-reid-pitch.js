/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-pitch — Media Pitch generator (Reid Callum's tool).

   Drafts a direct-to-journalist email pitch tied to the visitor's brief
   and the journalist beat the visitor specified. Output is a subject
   line + a 100-150 word email body. Pitches are higher-leverage than
   wire distribution and Reid says so in the Marketing Code.

   POST body : {
     journalist_beat: string (1-200 chars; e.g. "AI infrastructure", "indie pharmacy ops")
     pitch_angle:     string (optional, max 200 chars - what to lead with)
     brief:           string
     name:            string
   }
   Response  : {
     subject_line:  string,
     email_body:    string,
     rationale:     string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 800;
const BEAT_MAX   = 200;
const ANGLE_MAX  = 200;
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

function buildSystemPrompt(name, beat, angle) {
  const r = (voiceScripts.scripts && voiceScripts.scripts.reid_callum) || {};
  const nameRef = name || 'the founder';
  return `You are Reid Callum, The Marketing Expert at The Gauntlet. You draft media pitches that journalists actually open.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${r.bio || ''}
  Role: ${r.role || ''}

YOUR JOB
  Draft ONE direct-to-journalist email pitch for ${nameRef}, tied to their brief and tailored to a journalist who covers: ${beat}.
  ${angle ? `Lead the pitch with: ${angle}` : 'Choose the strongest angle from the brief.'}

PITCH STRUCTURE
  1. SUBJECT LINE - 6 to 10 words. Specific. Names the story, not the company. No "Press Release:" / "Story Idea:" prefix.
  2. EMAIL BODY - 100 to 150 words. Structure:
     a) ONE sentence opener that names what's new and why it matters to THIS journalist's beat (use the beat we have).
     b) TWO to THREE sentences with the concrete substance - the number, the customer, the change. No buzzwords.
     c) ONE sentence offering what the journalist can have: an interview, the data, a customer to talk to, an early demo. Specific.
     d) Sign-off with [YOUR NAME] / [YOUR ROLE] / [YOUR COMPANY] / [PHONE NUMBER] placeholders for the visitor to fill in.

DRAFTING RULES
  - Address the journalist as "Hi [FIRST NAME]," with a placeholder. The visitor will swap in the real name per pitch.
  - The opener must read like you actually know what this journalist covers. Reference the beat naturally.
  - Use SQUARE-BRACKET PLACEHOLDERS for facts you do not have ([NUMBER], [CUSTOMER NAME], [LAUNCH DATE]). NEVER invent.
  - No em dashes. No exclamation points. No "I hope this finds you well."
  - No "I think you'll find this interesting" / "thought this might be a fit" / "wanted to put this on your radar." Lead with the actual story.
  - Plain English. Short sentences. A journalist reads two lines before deciding.

RATIONALE
  - ONE sentence on why this angle works for this beat. For the founder, not the journalist.

HARD CONSTRAINTS
  - Output is JSON only, exactly the shape below, nothing before or after.
  - The "email_body" field must include real newlines (escape as \\n in JSON).

OUTPUT JSON:
{
  "subject_line": "<6-10 words>",
  "email_body":   "<full email with placeholders and \\n line breaks>",
  "rationale":    "<one sentence>"
}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const beat  = String(body.journalist_beat || '').trim().slice(0, BEAT_MAX);
  const angle = String(body.pitch_angle     || '').trim().slice(0, ANGLE_MAX);
  const brief = String(body.brief           || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);

  if (!beat)                    return json(400, { error: 'journalist_beat is required' });
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `THE FOUNDER'S BRIEF (this is the story you are pitching - use only what's here, placeholder anything missing):`,
    '"""', brief, '"""', '',
    `JOURNALIST BEAT: ${beat}`,
    angle ? `LEAD ANGLE: ${angle}` : '',
    '',
    'Draft the pitch now. JSON only.',
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name, beat, angle),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-reid-pitch] anthropic error', err && err.message);
    return json(502, { error: 'pitch generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-reid-pitch] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const subject   = String(parsed.subject_line || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const emailBody = String(parsed.email_body   || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const rationale = String(parsed.rationale    || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  if (!subject || !emailBody) return json(502, { error: 'incomplete response' });

  return json(200, {
    subject_line: subject,
    email_body:   emailBody,
    rationale,
  });
};
