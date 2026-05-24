/* ─────────────────────────────────────────────────────────────────────────────
   tg-evaluate-stage-clarity — Stage 1 Clarity, ALL THREE chosen judges.

   The next step after the one-judge slice. Takes a submission and the
   triad of three chosen judges, creates one tg_evaluations row, fires
   three Anthropic calls in parallel (Promise.all), writes three
   tg_judge_outputs rows, and returns the three findings together.

   This is the foundation for triangulation - once we have three scored
   findings on the same dimension, the triangulation math (agreement
   <=0.15, conflict >=0.35) becomes computable.

   POST body : {
     submission_id: uuid (required)
     triad:         [string, string, string] (required - 3 judge ids)
   }
   Response  : {
     evaluation_id: uuid,
     findings: [
       { judge_id, judge_name, score: 0-10, finding: string, confidence: 0-1 },
       ...
     ]
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
  const toneRules  = (judge.tone_rules  || []).map(r => `- ${r}`).join('\n');
  const blindSpots = (judge.blind_spots || []).map(r => `- ${r}`).join('\n');
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

function buildUserPrompt(subRow){
  return [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    `SUBMISSION DESCRIPTION:`,
    subRow.description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
    '',
    'Score CLARITY now. Return JSON only.',
  ].filter(Boolean).join('\n');
}

async function evaluateOneJudge(client, judge, userPrompt){
  const systemPrompt = buildSystemPrompt(judge);
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error(`[stage-clarity] anthropic error for ${judge.id}`, err);
    return { judge, error: 'anthropic_failed' };
  }
  const raw = (response.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return { judge, error: 'empty' };
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error(`[stage-clarity] parse fail for ${judge.id}`, raw);
    return { judge, error: 'parse_failed' };
  }
  const score      = Math.max(0, Math.min(10, parseInt(parsed.score, 10) || 0));
  const finding    = String(parsed.finding || '').trim();
  const confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0));
  if (!finding) return { judge, error: 'no_finding' };
  return { judge, score, finding, confidence };
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
  const triad         = Array.isArray(body.triad) ? body.triad.slice(0, 3) : [];

  if (!UUID_RE.test(submission_id))         return json(400, { error: 'invalid submission_id' });
  if (triad.length !== 3)                   return json(400, { error: 'triad must be 3 judge ids' });
  if (!triad.every(t => JUDGE_ID_RE.test(t))) return json(400, { error: 'triad ids invalid' });
  if (new Set(triad).size !== 3)            return json(400, { error: 'triad ids must be distinct' });

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

  // 1. Load the submission. Service role bypass; user_id pulled from row.
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, user_id, title, description, goal_audience, constraints')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr) return json(500, { error: 'submission lookup failed', detail: subErr.message });
  if (!subRow) return json(404, { error: 'submission not found' });

  // 2. Find or create the tg_evaluations row for this submission + stage.
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

  // 3. Fire all three Anthropic calls IN PARALLEL.
  const userPrompt = buildUserPrompt(subRow);
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const results = await Promise.all(judges.map(j => evaluateOneJudge(client, j, userPrompt)));

  // 4. Write each successful result to tg_judge_outputs. Failures are
  //    surfaced in the response so the client can see which judge(s) did
  //    not complete and decide how to render.
  const writes = await Promise.all(results.map(async r => {
    if (r.error) return r;
    const { data: outRow, error: outErr } = await supabase
      .from('tg_judge_outputs')
      .insert({
        evaluation_id: evaluationId,
        judge_id: r.judge.id,
        stage: 'clarity',
        dimension_scores: { clarity: r.score },
        stage_critique: r.finding,
        retrieved_evidence: [],
        confidence: r.confidence,
      })
      .select('id')
      .single();
    if (outErr) {
      console.error(`[stage-clarity] insert fail for ${r.judge.id}`, outErr);
      return { ...r, error: 'write_failed' };
    }
    return { ...r, output_id: outRow.id };
  }));

  const findings = writes.map(r => ({
    judge_id:   r.judge.id,
    judge_name: r.judge.name,
    error:      r.error || null,
    score:      r.error ? null : r.score,
    finding:    r.error ? null : r.finding,
    confidence: r.error ? null : r.confidence,
    output_id:  r.output_id || null,
  }));

  // 5. Mark the evaluation completed if ALL three judges returned. Otherwise
  //    leave it in 'running' so a retry can finish the missing pieces.
  const allOk = findings.every(f => !f.error);
  if (allOk){
    await supabase
      .from('tg_evaluations')
      .update({ status: 'clarity_done', completed_at: new Date().toISOString() })
      .eq('id', evaluationId);
  }

  return json(200, { evaluation_id: evaluationId, findings });
};
