/* ─────────────────────────────────────────────────────────────────────────────
   tg-chamber-summary — Phase 3 of the Chamber: the conversation record.

   After the panel finishes scoring, the client's answers to the judges'
   questions are turned into a short summary for the report. This is a
   record of the interaction ONLY. It does not affect any score - scoring
   is brief-only and already complete by the time this runs.

   POST body : {
     submission_id: uuid (optional - used only for the title line)
     visitor_name:  string (optional)
     qa: [
       { judge_name, questions: [string, ...], answer: string },
       ...
     ]
   }
   Response  : { summary: string }   // 2-3 short paragraphs, plain prose

   Env: ANTHROPIC_API_KEY (Supabase not needed - the qa transcript is
   passed in directly from the chamber client).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 700;
const MAX_QA = 6;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function dashClean(s){ return String(s == null ? '' : s).replace(/—/g, '-').replace(/–/g, '-').trim(); }

function sanitizeQa(input){
  if (!Array.isArray(input)) return [];
  const clean = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const judge_name = String(item.judge_name || '').slice(0, 80).trim();
    const questions  = Array.isArray(item.questions)
      ? item.questions.map(q => String(q || '').slice(0, 400).trim()).filter(Boolean).slice(0, 3)
      : [];
    const answer     = String(item.answer || '').slice(0, 2000).trim();
    if (!judge_name || !questions.length) continue;
    clean.push({ judge_name, questions, answer });
    if (clean.length >= MAX_QA) break;
  }
  return clean;
}

function buildPrompt(qa, visitorName){
  const blocks = qa.map((x, i) => {
    const qs = x.questions.map(q => '   - ' + q).join('\n');
    return `[${i + 1}] ${x.judge_name} asked:\n${qs}\n   ${visitorName || 'The client'} answered: ${x.answer || '(no answer given)'}`;
  }).join('\n\n');

  return `You are the rapporteur for The Gauntlet panel. The three judges questioned the client about their idea before scoring. Below is the full exchange. Write a short summary of the conversation FOR THE CLIENT'S REPORT.

THE EXCHANGE:
${blocks}

WRITE
- 2 to 3 short paragraphs of plain prose.
- Summarize what the panel pressed on, what the client clarified or revealed, and what questions remain only partially answered.
- Neutral and factual. This is a record of the conversation, not a verdict and not a score. Do NOT assign or imply scores.
- No em dashes. No markdown. No headers. No bullet points. Just paragraphs.

Return JSON only, exactly this shape:
{"summary": "<2-3 paragraphs>"}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const visitorName = String(body.visitor_name || '').trim().slice(0, 60).replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
  const qa = sanitizeQa(body.qa);
  if (!qa.length) return json(400, { error: 'qa transcript is empty' });

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: buildPrompt(qa, visitorName) }],
    });
  } catch (err) {
    console.error('[chamber-summary] anthropic error', err && err.message);
    return json(502, { error: 'summary generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty summary response' });
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[chamber-summary] parse fail', raw.slice(0, 300));
    return json(502, { error: 'summary response was not valid json' });
  }

  const summary = dashClean(parsed.summary || '').slice(0, 4000);
  if (!summary) return json(502, { error: 'no summary produced' });

  return json(200, { summary });
};
