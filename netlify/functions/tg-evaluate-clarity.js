/* ─────────────────────────────────────────────────────────────────────────────
   tg-evaluate-clarity — Stage 1 Clarity, one judge, end-to-end.

   The first piece of the actual evaluation pipeline. Takes a submission and
   a judge id, loads the submission from Supabase, builds a persona-aware
   prompt from judges_master.json, asks Claude to score CLARITY (0-10) and
   write a 2-3 sentence finding in the judge's voice, then writes one row
   to tg_judge_outputs and returns the finding.

   For slice 1 this is the only dimension evaluated, by only the first of
   the three chosen judges. The full panel + triangulation + report come
   in later slices.

   POST body : {
     submission_id: uuid (required)
     judge_id:      string (required, e.g. 'selene_voss')
     triad:         [string, string, string] (required - the 3 chosen judges)
   }
   Auth      : none (anonymous tool; user_id pulled from the submission row)
   Response  : {
     evaluation_id, output_id, judge_id,
     score: 0-10, finding: string, confidence: 0.00-1.00
   }
   Env vars  : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDGE_ID_RE = /^[a-z0-9_]+$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

function findJudge(judgeId){
  return (judgesMaster.judges || []).find(j => j.id === judgeId);
}

function buildSystemPrompt(judge){
  const toneRules    = (judge.tone_rules    || []).map(r => `- ${r}`).join('\n');
  const blindSpots   = (judge.blind_spots   || []).map(r => `- ${r}`).join('\n');
  return `You are ${judge.name}, ${judge.domain} on The Gauntlet panel.

Background: ${judge.background || ''}
Your lens: ${judge.lens || ''}

Character notes: ${judge.character_notes || ''}

Tone rules (follow these every line):
${toneRules}

Be aware of your own blind spots so you do not over-index on them:
${blindSpots}

You are evaluating ONE dimension of this submission: CLARITY.

CLARITY = how clearly the user articulates (a) the problem they are responding to, (b) the shape of their proposed solution, and (c) the audience or context. It is NOT about whether the idea is good. Only how clearly it is expressed.

Score CLARITY on a 0-10 integer scale:
  0-2  = vague. No clear problem, no clear solution.
  3-4  = problem identified but solution shape is unclear.
  5-6  = both problem and solution stated, audience is hazy.
  7-8  = clear problem, clear solution, clear audience.
  9-10 = exceptionally precise on problem, solution, audience, and the "why".

Write a 2-3 sentence FINDING addressed directly to the submitter, in YOUR voice (use first person where natural, e.g. "I would..."). Plain English. NO insider jargon. NO em dashes. NO emojis. NO markdown. The user is not another expert.

If the score is below 4, do not soften - your tone rules apply.
If the score is 7 or above, do not flatter - say what is clear and what could still tighten.

Then return YOUR CONFIDENCE in your own scoring on a 0.00 to 1.00 decimal scale.

OUTPUT JSON only, exactly this shape, nothing before or after:
{"score": <integer 0-10>, "finding": "<2-3 sentences in your voice>", "confidence": <0.00-1.00>}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const submission_id = String(body.submission_id || '').trim();
  const judge_id      = String(body.judge_id      || '').trim();
  const triad         = Array.isArray(body.triad) ? body.triad.slice(0, 3) : [];

  if (!UUID_RE.test(submission_id))     return json(400, { error: 'invalid submission_id' });
  if (!JUDGE_ID_RE.test(judge_id))      return json(400, { error: 'invalid judge_id' });
  if (triad.length !== 3)               return json(400, { error: 'triad must contain 3 judge ids' });
  if (!triad.every(t => JUDGE_ID_RE.test(t))) return json(400, { error: 'triad ids invalid' });

  const judge = findJudge(judge_id);
  if (!judge) return json(404, { error: 'judge not found' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });
  if (!ANTHROPIC_KEY)                return json(500, { error: 'anthropic env missing' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Load the submission. user_id and prose come from here, not from the
  //    client - trusting the client with user_id would let anyone evaluate
  //    a submission they did not own.
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, user_id, title, description, goal_audience, constraints')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr) return json(500, { error: 'submission lookup failed', detail: subErr.message });
  if (!subRow) return json(404, { error: 'submission not found' });

  // 2. Find or create the tg_evaluations row for this submission + stage.
  //    Slice 1: one evaluation per submission, stage='clarity'.
  let evaluationId;
  {
    const { data: existing } = await supabase
      .from('tg_evaluations')
      .select('id')
      .eq('submission_id', submission_id)
      .eq('stage', 'clarity')
      .limit(1);
    if (existing && existing.length > 0){
      evaluationId = existing[0].id;
    } else {
      const { data: created, error: createErr } = await supabase
        .from('tg_evaluations')
        .insert({
          submission_id,
          user_id: subRow.user_id,
          triad,
          stage: 'clarity',
          status: 'running',
        })
        .select('id')
        .single();
      if (createErr) return json(500, { error: 'evaluation row create failed', detail: createErr.message });
      evaluationId = created.id;
    }
  }

  // 3. Build the prompt and call Claude.
  const systemPrompt = buildSystemPrompt(judge);
  const userPrompt = [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    `SUBMISSION DESCRIPTION:`,
    subRow.description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
    '',
    'Score CLARITY now. Return JSON only.',
  ].filter(Boolean).join('\n');

  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-evaluate-clarity] anthropic error', err);
    return json(502, { error: 'clarity evaluation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'model returned empty' });

  // Tolerant JSON parse.
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('[tg-evaluate-clarity] could not parse', raw);
    return json(502, { error: 'invalid model output' });
  }

  const score      = Math.max(0, Math.min(10, parseInt(parsed.score, 10) || 0));
  const finding    = String(parsed.finding || '').trim();
  const confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0));
  if (!finding) return json(502, { error: 'no finding in model output' });

  // 4. Write tg_judge_outputs.
  const { data: outRow, error: outErr } = await supabase
    .from('tg_judge_outputs')
    .insert({
      evaluation_id: evaluationId,
      judge_id,
      stage: 'clarity',
      dimension_scores: { clarity: score },
      stage_critique: finding,
      retrieved_evidence: [],
      confidence,
    })
    .select('id')
    .single();
  if (outErr) return json(500, { error: 'judge output write failed', detail: outErr.message });

  return json(200, {
    evaluation_id: evaluationId,
    output_id:     outRow.id,
    judge_id,
    score,
    finding,
    confidence,
  });
};
