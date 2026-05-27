/* ─────────────────────────────────────────────────────────────────────────────
   tg-grant-coach — Chamber-prep panel recommendation (Grant's first move).

   Reads the visitor's brief. Returns:
     1. The three judges Grant recommends from the nine, with per-judge rationale
        tied directly to the brief
     2. For each recommended judge: 3-5 questions in that judge's voice that
        the brief will likely provoke
     3. A walk-in line - the one sentence the visitor should keep in their
        head as they enter the Chamber

   This is the "set the table" step. The follow-up work-through-the-answers
   step lives in the existing tg-ep-chat (Grant's chat thread) and tg-ep-chat
   drill mode (one judge at a time). Both already exist; this primes them.

   POST body : { brief, name }
   Response  : {
     recommended_panel: [
       { judge_id, judge_name, beat, why_for_this_brief }
     ],
     likely_questions: {
       <judge_id>: [
         { question, what_they_are_really_asking }
       ]
     },
     walk_in_line: string,
     rationale: string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1200;
const BRIEF_MAX  = 4500;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

// The nine judges Grant can recommend. id matches judges_master.json; label
// is the short name used in dialogue; beat is the lens that judge brings.
const JUDGES = {
  selene_voss:    { name: 'Selene Voss',    beat: 'AI / emerging tech / consumer software',     short: 'Selene'  },
  marcus_holt:    { name: 'Marcus Holt',    beat: 'finance / exit math / capital strategy',     short: 'Marcus'  },
  priya_anand:    { name: 'Priya Anand',    beat: 'health / clinical / regulated products',     short: 'Priya'   },
  raymond_chen:   { name: 'Raymond Chen',   beat: 'operations / unit economics / hardware',     short: 'Raymond' },
  astrid_lund:    { name: 'Astrid Lund',    beat: 'legal / IP / regulatory / compliance',       short: 'Astrid'  },
  osei_mensah:    { name: 'Osei Mensah',    beat: 'research / data / evidence quality',         short: 'Osei'    },
  grace_nakamura: { name: 'Grace Nakamura', beat: 'national security / dual-use / public sector', short: 'Grace' },
  devon_sloane:   { name: 'Devon Sloane',   beat: 'media / narrative / brand voice',            short: 'Devon'   },
  cassidy_mercer: { name: 'Cassidy Mercer', beat: 'consumer behavior / psychology read',        short: 'Cassidy' },
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
  const g = (voiceScripts.scripts && voiceScripts.scripts.grant_ellis) || {};
  const nameRef = name || 'the founder';
  const judgeList = Object.entries(JUDGES)
    .map(([id, j]) => `  - ${id}: ${j.name} (${j.beat})`)
    .join('\n');

  return `You are Grant Ellis, The Coach at The Gauntlet. The last office before the Chamber. You read the brief and tell the founder which three of the nine judges to face, what those three will ask, and how to walk in rehearsed instead of guessing.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${g.bio || ''}
  Role: ${g.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Pick the THREE judges who will produce the most useful pressure on THIS brief. Not the judges who will be friendliest. The ones whose pressure will sharpen the brief the most before it enters the world. Tell ${nameRef} the questions those three will ask, in their voice, before they ever sit down.

PICKING THE PANEL - HOW TO THINK
  - Pick for COVERAGE. Three judges should together stress-test three different load-bearing parts of the brief. Don't pick three judges who would all hit the same nerve.
  - Pick for FIT to this brief. A consumer-software brief usually wants Selene + Cassidy + one more. A hardware brief usually wants Raymond + Astrid + one more. A health brief usually wants Priya + one more. A public-sector or dual-use brief usually wants Grace + one more. Read the brief - don't auto-pick.
  - Pick for the WEAKEST claim. The judge who would hit the weakest part of the brief belongs on the panel. Friendly panels don't help anyone.

THE NINE JUDGES YOU CAN RECOMMEND (use exactly these ids in the "judge_id" field):
${judgeList}

OUTPUT REQUIREMENTS

  1. RECOMMENDED_PANEL - exactly 3 entries. Each entry:
       - judge_id: one of the nine ids above
       - judge_name: the judge's full name
       - beat: short beat from the list above
       - why_for_this_brief: ONE specific sentence tying THIS judge's lens to THIS brief. Not generic. Reference something from the brief.

  2. LIKELY_QUESTIONS - one key per recommended judge_id. Each value is an array of EXACTLY 3 questions. Each question is an object:
       - question: ONE sentence the judge would say, in their voice. Specific to ${nameRef}'s brief.
       - what_they_are_really_asking: ONE short sentence translating what the judge is actually testing.

  3. WALK_IN_LINE - ONE line ${nameRef} should keep in their head as they enter the Chamber. Short. Memorable. Specific to this brief. Not "you got this." Something like "the audience is postpartum, not 'busy parents' - say that" or "lead with the retention number, not the mission statement."

  4. RATIONALE - Two short sentences:
       - Sentence 1: what about THIS brief drove the panel pick.
       - Sentence 2: which of the three judges to rehearse against FIRST and why.

DRAFTING RULES
  - You are a coach who watched tape. Concrete. Specific. Names from the brief.
  - Each judge's voice must sound different. Selene clipped + forward-looking. Marcus combative + numbers-first. Priya quiet + clinical. Raymond unit-economics-direct. Astrid careful + legal. Osei pushes on evidence. Grace asks about dual-use and public-sector exposure. Devon listens for narrative inconsistency. Cassidy reads behavior under the words.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "recommended_panel": [
    {
      "judge_id": "<one of the nine>",
      "judge_name": "<full name>",
      "beat": "<short beat>",
      "why_for_this_brief": "<one specific sentence>"
    },
    {"judge_id": "...", "judge_name": "...", "beat": "...", "why_for_this_brief": "..."},
    {"judge_id": "...", "judge_name": "...", "beat": "...", "why_for_this_brief": "..."}
  ],
  "likely_questions": {
    "<judge_id_1>": [
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."}
    ],
    "<judge_id_2>": [
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."}
    ],
    "<judge_id_3>": [
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."},
      {"question": "...", "what_they_are_really_asking": "..."}
    ]
  },
  "walk_in_line": "<one sentence>",
  "rationale": "<two sentences>"
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
    `THE FOUNDER'S BRIEF (read it like a coach watching tape):`,
    '"""', brief, '"""', '',
    'Pick the three judges, name the questions each will ask, and the walk-in line. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-grant-coach] anthropic error', err && err.message);
    return json(502, { error: 'coach generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-grant-coach] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // Validate the panel: 3 entries, each with a known judge_id.
  const panelRaw = Array.isArray(parsed.recommended_panel) ? parsed.recommended_panel : [];
  const seen = new Set();
  const recommended_panel = panelRaw
    .filter(p => p && JUDGES[p.judge_id] && !seen.has(p.judge_id) && seen.add(p.judge_id))
    .slice(0, 3)
    .map(p => ({
      judge_id:   p.judge_id,
      judge_name: JUDGES[p.judge_id].name,
      beat:       JUDGES[p.judge_id].beat,
      why_for_this_brief: String(p.why_for_this_brief || '').replace(/—/g, '-').replace(/–/g, '-').trim(),
    }));
  if (recommended_panel.length !== 3) return json(502, { error: 'panel must be exactly 3 valid judges' });

  // Validate per-judge questions.
  const likelyRaw = (parsed.likely_questions && typeof parsed.likely_questions === 'object') ? parsed.likely_questions : {};
  const likely_questions = {};
  for (const entry of recommended_panel) {
    const arr = Array.isArray(likelyRaw[entry.judge_id]) ? likelyRaw[entry.judge_id] : [];
    const cleaned = arr
      .filter(q => q && q.question)
      .slice(0, 3)
      .map(q => ({
        question: String(q.question || '').replace(/—/g, '-').replace(/–/g, '-').trim(),
        what_they_are_really_asking: String(q.what_they_are_really_asking || '').replace(/—/g, '-').replace(/–/g, '-').trim(),
      }))
      .filter(q => q.question);
    if (cleaned.length < 2) {
      return json(502, { error: 'incomplete questions for ' + entry.judge_id });
    }
    likely_questions[entry.judge_id] = cleaned;
  }

  const walk_in_line = String(parsed.walk_in_line || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  const rationale    = String(parsed.rationale    || '').replace(/—/g, '-').replace(/–/g, '-').trim();
  if (!walk_in_line || !rationale) return json(502, { error: 'incomplete response' });

  return json(200, {
    recommended_panel,
    likely_questions,
    walk_in_line,
    rationale,
  });
};
