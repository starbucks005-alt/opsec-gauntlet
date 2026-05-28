/* ─────────────────────────────────────────────────────────────────────────────
   tg-chamber-questions — Phase 1 of the Chamber: the conversation.

   Before any scoring happens, the three panel judges interrogate the
   client. This function reads the submission and generates 2-3 pointed
   questions per panel judge, each in that judge's voice and from their
   domain lens, targeting what the brief does NOT answer. The chamber
   presents them round-robin and gates on the client's typed answers.

   The answers do NOT affect scoring (scoring stays brief-only in
   tg-evaluate-stage). They feed tg-chamber-summary, which produces a
   conversation record for the report.

   POST body : {
     submission_id: uuid (required)
     triad:         [string, string, string] (required - 3 judge ids)
     visitor_name:  string (optional)
   }
   Response  : {
     questions: [
       { judge_id, judge_name, domain, questions: [string, ...] },  // ordered to match triad
       ...
     ]
   }
   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 400;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDGE_ID_RE = /^[a-z0-9_]+$/;
const MIN_Q = 2;
const MAX_Q = 3;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function findJudge(id){ return (judgesMaster.judges || []).find(j => j.id === id); }
function dashClean(s){ return String(s == null ? '' : s).replace(/—/g, '-').replace(/–/g, '-').trim(); }

function buildSystemPrompt(judge, visitorName){
  const toneRules = (judge.tone_rules || []).map(r => `- ${r}`).join('\n');
  const addressLine = visitorName
    ? `Address the client by name once if it is natural (e.g. "${visitorName}, ...").`
    : `Address the client directly in second person ("you").`;
  return `You are ${judge.name}, ${judge.domain} on The Gauntlet panel.

Background: ${judge.background || ''}
Your lens: ${judge.lens || ''}
Character notes: ${judge.character_notes || ''}

Tone rules (follow every line):
${toneRules}

This is the CONVERSATION phase, before any scoring. You are interrogating the client about their idea. Ask ${MIN_Q} to ${MAX_Q} sharp questions from YOUR domain lens - the things you most need to know that the brief does not already answer. These are the questions that would change how you see the idea.

RULES
- Questions only. Do NOT score. Do NOT give verdicts. Do NOT praise.
- Each question is one sentence, in your voice, plain English, no insider jargon.
- Target the gaps a ${judge.domain} expert would press on. Be specific to THIS idea, not generic.
- No em dashes. No markdown. No numbering inside the strings.
- ${addressLine}

OUTPUT JSON only, exactly this shape, nothing before or after:
{"questions": ["<question 1>", "<question 2>", "<question 3 optional>"]}`;
}

function buildUserPrompt(subRow){
  return [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    'SUBMISSION DESCRIPTION:',
    subRow.description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
    '',
    `Ask your ${MIN_Q} to ${MAX_Q} questions now. JSON only.`,
  ].filter(Boolean).join('\n');
}

async function askOneJudge(client, judge, subRow, visitorName){
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(judge, visitorName),
      messages: [{ role: 'user', content: buildUserPrompt(subRow) }],
    });
  } catch (err) {
    console.error('[chamber-questions] anthropic error for ' + judge.id, err && err.message);
    return { judge, error: 'anthropic_failed' };
  }
  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return { judge, error: 'empty' };
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[chamber-questions] parse fail for ' + judge.id, raw.slice(0, 300));
    return { judge, error: 'parse_failed' };
  }
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map(q => dashClean(q)).filter(Boolean).slice(0, MAX_Q)
    : [];
  if (questions.length < 1) return { judge, error: 'no_questions' };
  return { judge, questions };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const submission_id = String(body.submission_id || '').trim();
  const triad         = Array.isArray(body.triad) ? body.triad.slice(0, 3) : [];
  const visitorName   = String(body.visitor_name || '').trim().slice(0, 60).replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();

  if (!UUID_RE.test(submission_id))           return json(400, { error: 'invalid submission_id' });
  if (triad.length !== 3)                     return json(400, { error: 'triad must be 3 judge ids' });
  if (!triad.every(t => JUDGE_ID_RE.test(t))) return json(400, { error: 'triad ids invalid' });

  const judges = triad.map(findJudge);
  if (judges.some(j => !j)) return json(404, { error: 'one or more judges not found' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });
  if (!ANTHROPIC_KEY)                return json(500, { error: 'anthropic env missing' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, title, description, goal_audience, constraints')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr)  return json(500, { error: 'submission lookup failed', detail: subErr.message });
  if (!subRow) return json(404, { error: 'submission not found' });

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const results = await Promise.all(judges.map(j => askOneJudge(client, j, subRow, visitorName)));

  const questions = results.map(r => ({
    judge_id:   r.judge.id,
    judge_name: r.judge.name,
    domain:     r.judge.domain,
    questions:  r.error ? [] : r.questions,
    error:      r.error || null,
  }));

  // If every judge failed, signal failure so the client can fall back to
  // scoring directly (graceful degradation - the client still gets a report).
  if (questions.every(q => q.error)) {
    return json(502, { error: 'all judges failed to produce questions' });
  }

  return json(200, { questions });
};
