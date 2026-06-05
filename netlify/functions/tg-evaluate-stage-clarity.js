/* ─────────────────────────────────────────────────────────────────────────────
   tg-evaluate-stage-clarity — Stage 1 Clarity, all three chosen judges,
                                plus triangulation math.

   Takes a submission and the triad, creates one tg_evaluations row, fires
   three Anthropic calls in parallel (Promise.all), writes three
   tg_judge_outputs rows, computes the triangulation (agreement <=0.15,
   conflict >=0.35 on normalized spread), writes tg_triangulations, and
   returns everything in one payload.

   POST body : {
     submission_id: uuid (required)
     triad:         [string, string, string] (required - 3 judge ids)
   }
   Response  : {
     evaluation_id: uuid,
     findings: [
       { judge_id, judge_name, score: 0-10, finding: string, confidence: 0-1 },
       ...
     ],
     triangulation: {
       matrix:               { clarity: { judge_id: score, ... } },
       agreement_dimensions: ['clarity'] | [],
       conflict_dimensions:  ['clarity'] | [],
       coverage_gaps:        [],
       composite_score:      0.00-1.00,
       verdict:              'agreement' | 'conflict' | 'middle'
     } | null
   }
   Env vars  : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDGE_ID_RE = /^[a-z0-9_]+$/;

// AI-tell lens lives with Selene only. Other judges score clarity blind to
// what the EPs rewrote vs what the visitor wrote.
const AI_TELL_JUDGE = 'selene_voss';

// Caps for the revision log we forward into Selene's user prompt. The log
// is user-influenced (sessionStorage on the visitor's browser before POST),
// so it gets truncated/sanitized before it lands in any prompt.
const MAX_REVISIONS_IN_PROMPT = 24;
const MAX_REV_FIELD_CHARS     = 480;

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

// Selene gets a secondary lens (AI-writing tells) on top of the generic
// clarity prompt. Other judges return null and run unchanged.
function buildSeleneLensClause(){
  return `

SECONDARY LENS - AI WRITING TELLS
You also clock AI-writing fingerprints because 99 percent of what crosses your desk was written by AI. The em dash is the most reliable tell. Stock listy transitions ("Furthermore," "Moreover," "In conclusion"), generic abstract framing, and template-y prose are next. When you see the pattern in this submission's prose, name it once, briefly, in your finding - one phrase, flat affect, no theatrics - and let it pull your CLARITY score down. Templatey prose obscures the idea even when the structure looks tidy; the visitor's actual articulation is buried under the template, so clarity suffers.

If you do not see AI tells, do not mention them. Do not lecture. Do not hedge about being an AI character yourself - you are evaluating the prose on the page, not yourself.`;
}

function buildSystemPrompt(judge, visitorName){
  const toneRules  = (judge.tone_rules  || []).map(r => `- ${r}`).join('\n');
  const blindSpots = (judge.blind_spots || []).map(r => `- ${r}`).join('\n');
  const addressLine = visitorName
    ? `Address the submitter by name in vocative case at the start of your finding (e.g. "${visitorName}, ..."). Use the name once - do not repeat it.`
    : `Address the submitter directly in second person ("you"). No vocative name was provided.`;
  const seleneLens = judge.id === AI_TELL_JUDGE ? buildSeleneLensClause() : '';
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

${addressLine}

If the score is below 4, do not soften - your tone rules apply.
If the score is 7 or above, do not flatter - say what is clear and what could still tighten.

CONDUCT BACKSTOP: If the submission contains profanity, slurs, or personal attacks aimed at the judges or other users, do not score it on substance. Return score 0, confidence 0.5, and a finding that reads: "This submission contains language that does not meet The Chamber's conduct rules. I cannot score it on the substance until it is revised." Do not improvise around this rule.${seleneLens}

Then return YOUR CONFIDENCE in your own scoring on a 0.00 to 1.00 decimal scale.

OUTPUT JSON only, exactly this shape, nothing before or after:
{"score": <integer 0-10>, "finding": "<2-3 sentences in your voice>", "confidence": <0.00-1.00>}`;
}

// Sanitize the visitor-submitted revision log before it ever reaches a
// prompt. Drop anything we cannot validate, cap the array, truncate fields.
function sanitizeRevisions(input){
  if (!Array.isArray(input)) return [];
  const clean = [];
  for (const r of input) {
    if (!r || typeof r !== 'object') continue;
    const ep_id     = String(r.ep_id || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
    const operation = (r.operation === 'append' || r.operation === 'replace') ? r.operation : '';
    const section   = String(r.section_label || '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 80);
    const before    = String(r.before || '').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').slice(0, MAX_REV_FIELD_CHARS);
    const after     = String(r.after  || '').replace(/[\x00-\x08\x0b-\x1f]/g, ' ').slice(0, MAX_REV_FIELD_CHARS);
    if (!ep_id || !operation || !after) continue;
    clean.push({ ep_id, operation, section_label: section, before, after });
    if (clean.length >= MAX_REVISIONS_IN_PROMPT) break;
  }
  return clean;
}

function formatRevisionLog(revisions){
  if (!revisions.length) {
    return 'REVISION LOG: empty. The visitor accepted no EP rewrites; every paragraph in the brief is their original prose.';
  }
  const lines = ['REVISION LOG (sections that were rewritten or extended by an Executive Producer in the corridor; anything not in this list is the visitor\'s original prose):', ''];
  revisions.forEach((r, i) => {
    lines.push(`#${i + 1} [${r.ep_id}] [${r.operation}] section: "${r.section_label || 'unlabeled'}"`);
    if (r.operation === 'replace' && r.before) {
      lines.push(`  before: ${JSON.stringify(r.before)}`);
    }
    lines.push(`  after:  ${JSON.stringify(r.after)}`);
  });
  return lines.join('\n');
}

function buildUserPrompt(subRow, judge, revisions){
  const base = [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    `SUBMISSION DESCRIPTION:`,
    subRow.description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
  ].filter(Boolean);

  // Only Selene sees the corridor revision log. It is irrelevant noise for
  // the other judges at the clarity stage.
  if (judge && judge.id === AI_TELL_JUDGE) {
    base.push('', formatRevisionLog(revisions || []));
  }

  base.push('', 'Score CLARITY now. Return JSON only.');
  return base.join('\n');
}

// Triangulation math. Pure function over scored findings.
//
//   matrix:               { <dimension>: { <judge_id>: score, ... } }
//   agreement_dimensions: dimensions where (max - min) / 10 <= 0.15
//   conflict_dimensions:  dimensions where (max - min) / 10 >= 0.35
//   coverage_gaps:        dimensions with <2 valid scores
//   composite_score:      mean of all valid scores, normalized 0-1
//   verdict:              'agreement' | 'conflict' | 'middle'
//
// Slice 1 has one dimension (clarity), so most arrays have at most 1 entry.
// The structure is dimension-keyed so the rest of slice 1 (more dimensions)
// can plug into the same math without code changes.
function computeTriangulation(findings){
  const valid = findings.filter(f => !f.error && typeof f.score === 'number');
  if (valid.length === 0) return null;

  const dimensionScores = { clarity: valid.map(f => f.score) };
  const matrix = { clarity: {} };
  valid.forEach(f => { matrix.clarity[f.judge_id] = f.score; });

  const agreement_dimensions = [];
  const conflict_dimensions  = [];
  const coverage_gaps        = [];

  Object.entries(dimensionScores).forEach(([dim, scores]) => {
    if (scores.length < 2){ coverage_gaps.push(dim); return; }
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const normalizedSpread = (max - min) / 10;
    if (normalizedSpread <= 0.15) agreement_dimensions.push(dim);
    else if (normalizedSpread >= 0.35) conflict_dimensions.push(dim);
  });

  const flat = Object.values(dimensionScores).flat();
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  const composite_score = Math.round((mean / 10) * 100) / 100;

  let verdict = 'middle';
  if (agreement_dimensions.length && !conflict_dimensions.length) verdict = 'agreement';
  else if (conflict_dimensions.length) verdict = 'conflict';

  return { matrix, agreement_dimensions, conflict_dimensions, coverage_gaps, composite_score, verdict };
}

async function evaluateOneJudge(client, judge, subRow, visitorName, revisions){
  const systemPrompt = buildSystemPrompt(judge, visitorName);
  const userPrompt   = buildUserPrompt(subRow, judge, revisions);
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
  // Optional. Sanitize hard - this string goes straight into a system prompt,
  // so strip anything that could look like instructions. Letters / spaces /
  // hyphens / apostrophes only, max 60 chars.
  const visitorName   = String(body.visitor_name || '')
                          .trim().slice(0, 60)
                          .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '')
                          .trim();
  // Optional. Corridor revision log forwarded from chamber.html. Used only
  // when Selene is in the triad. Sanitized before any prompt sees it.
  const revisions     = sanitizeRevisions(body.revisions);

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

  // 3. Fire all three Anthropic calls IN PARALLEL. Each judge gets a
  //    prompt built fresh because Selene's user prompt includes the
  //    revision log; the other two do not.
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const results = await Promise.all(judges.map(j => evaluateOneJudge(client, j, subRow, visitorName, revisions)));

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

  // 5. Triangulation. Pure math over the findings - no LLM in this layer.
  //    Writes tg_triangulations and includes the math in the response so
  //    the chamber can render a verdict line after the three findings.
  let triangulation = null;
  try {
    triangulation = computeTriangulation(findings);
    if (triangulation){
      const { error: triErr } = await supabase
        .from('tg_triangulations')
        .insert({
          evaluation_id:        evaluationId,
          matrix:               triangulation.matrix,
          agreement_dimensions: triangulation.agreement_dimensions,
          conflict_dimensions:  triangulation.conflict_dimensions,
          coverage_gaps:        triangulation.coverage_gaps,
          composite_score:      triangulation.composite_score,
        });
      if (triErr) console.error('[stage-clarity] triangulation insert failed', triErr);
    }
  } catch (err) {
    console.error('[stage-clarity] triangulation computation failed', err);
  }

  // 6. Mark the evaluation completed if ALL three judges returned. Otherwise
  //    leave it in 'running' so a retry can finish the missing pieces.
  const allOk = findings.every(f => !f.error);
  if (allOk){
    await supabase
      .from('tg_evaluations')
      .update({ status: 'clarity_done', completed_at: new Date().toISOString() })
      .eq('id', evaluationId);
  }

  return json(200, { evaluation_id: evaluationId, findings, triangulation });
};
