/* ─────────────────────────────────────────────────────────────────────────────
   tg-chamber-freelance — free-form chamber chat.

   The chamber's structured conversation phase (tg-chamber-questions) gates
   on a submission record in Supabase. THIS endpoint is different: it lets
   the visitor say anything to any judge at any time, with or without a
   submission. The judge responds in character, 1-3 sentences, using their
   persona from judges_master.json.

   Used by chamber.html when the user types into the chat box and no
   structured-conversation resolver is parked. Powers the "I want to be
   able to communicate with the judges always" use case: direct visitors to
   /chamber.html who haven't submitted, OR mid-evaluation visitors who want
   to riff with a judge between stages.

   POST body : {
     message:        string (required, the visitor's typed message),
     judge_id:       string (optional, defaults to first id in active_panel),
     active_panel:   [string, ...] (optional, rotate through these),
     submission_id:  string (optional, used as context if present),
     visitor_name:   string (optional),
     history:        [{ role: 'user'|'judge', name?, body }, ...] (optional, last N msgs)
   }
   Response  : { judge_id, judge_name, role, body }
   Env: ANTHROPIC_API_KEY  (SUPABASE optional, only used if submission_id is provided)
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 250;
const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY = 12;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({
  statusCode,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

function findJudge(id) {
  return (judgesMaster.judges || []).find(j => j.id === id);
}
function cleanDashes(s) {
  return String(s == null ? '' : s).replace(/—/g, ', ').replace(/–/g, ', ');
}

function pickJudge(judgeId, activePanel) {
  if (judgeId) {
    const j = findJudge(judgeId);
    if (j) return j;
  }
  if (Array.isArray(activePanel) && activePanel.length) {
    for (const id of activePanel) {
      const j = findJudge(id);
      if (j) return j;
    }
  }
  // Last resort: first judge in the master roster
  return (judgesMaster.judges || [])[0] || null;
}

function buildSystemPrompt(judge, visitorName) {
  const toneRules = (judge.tone_rules || []).map(r => '- ' + r).join('\n');
  const addressLine = visitorName
    ? 'Address the visitor by name once if it is natural ("' + visitorName + ', ...").'
    : 'Address the visitor directly in second person ("you").';
  return [
    'You are ' + judge.name + ', ' + (judge.domain || 'a judge') + ' on The Gauntlet panel.',
    '',
    'Background: ' + (judge.background || ''),
    'Your lens: ' + (judge.lens || ''),
    'Character notes: ' + (judge.character_notes || ''),
    '',
    'Tone rules (follow every line):',
    toneRules,
    '',
    'This is the freelance chamber: the visitor is talking to you directly between or around the structured evaluation. They may be asking a question, pushing back on something you said, riffing on their idea, or just trying to understand your lens. Respond in YOUR voice, from YOUR domain, in 1 to 3 sentences.',
    '',
    'RULES',
    '- Stay in character. Use your voice and lens; do not generalize.',
    '- 1 to 3 sentences. No lectures. No bullet points. No numbered lists.',
    '- If the visitor is wrong, say so plainly without being cruel.',
    '- If the visitor is right, acknowledge it briefly and move forward; do not flatter.',
    '- No em dashes. No markdown. Plain prose only.',
    '- Do NOT score, do NOT verdict, do NOT pretend you have read a brief you have not seen.',
    '- ' + addressLine,
    '',
    'Output ONLY your spoken response. No JSON, no labels, no quotes around it. Just the words you would say.',
  ].join('\n');
}

function buildMessages(message, history) {
  // Convert history into alternating user/assistant turns. Judge entries
  // become "assistant", visitor entries become "user". Always end with the
  // current message as the final user turn.
  const msgs = [];
  if (Array.isArray(history)) {
    history.slice(-MAX_HISTORY).forEach(h => {
      if (!h || typeof h !== 'object') return;
      const body = String(h.body || '').trim();
      if (!body) return;
      const role = (h.role === 'judge' || h.role === 'assistant') ? 'assistant' : 'user';
      msgs.push({ role, content: body });
    });
  }
  msgs.push({ role: 'user', content: message });
  // Anthropic requires alternating roles and the last must be user. Collapse
  // consecutive same-role messages so we satisfy that.
  const collapsed = [];
  for (const m of msgs) {
    if (collapsed.length && collapsed[collapsed.length - 1].role === m.role) {
      collapsed[collapsed.length - 1].content += '\n\n' + m.content;
    } else {
      collapsed.push({ ...m });
    }
  }
  return collapsed;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return json(400, { error: 'message required' });

  const visitorName = String(body.visitor_name || '').trim().slice(0, 60).replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
  const judge = pickJudge(body.judge_id, body.active_panel);
  if (!judge) return json(500, { error: 'no judges configured' });

  const system = buildSystemPrompt(judge, visitorName);
  const messages = buildMessages(message, body.history);

  const client = new Anthropic({ apiKey });
  let modelOutput;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });
    modelOutput = (resp.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
  } catch (err) {
    console.error('[chamber-freelance] anthropic error', err && err.message);
    return json(502, { error: 'judge could not respond', detail: err && err.message });
  }

  if (!modelOutput) return json(502, { error: 'empty model output' });

  return json(200, {
    ok: true,
    judge_id: judge.id,
    judge_name: judge.name,
    role: judge.domain || 'On the panel',
    body: cleanDashes(modelOutput),
  });
};
