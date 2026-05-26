/* ─────────────────────────────────────────────────────────────────────────────
   tg-evaluate-stage — Generic multi-dimension stage evaluator.

   Replaces the per-dimension function pattern (tg-evaluate-stage-clarity.js).
   Takes a `dimension` parameter and dispatches to the matching rubric.
   Adding new dimensions is now ~30 lines of config (in the DIMENSIONS map
   below) rather than a new function file.

   POST body : {
     submission_id: uuid (required)
     triad:         [string, string, string] (required - 3 judge ids)
     dimension:     'clarity' | 'viability' | ... (required)
     visitor_name:  string (optional, max 60 chars)
     revisions:     array (optional - EP corridor revision log; only used
                          by Selene's AI-tell lens, same as before)
   }
   Response  : same shape as tg-evaluate-stage-clarity but per-dimension:
   {
     evaluation_id: uuid,
     dimension:     <dimension>,
     findings: [{ judge_id, judge_name, score, finding, confidence, output_id }, ...],
     triangulation: {
       matrix:               { <dimension>: { judge_id: score, ... } },   // accumulates across stages
       agreement_dimensions: [...],
       conflict_dimensions:  [...],
       coverage_gaps:        [...],
       composite_score:      0.00-1.00,                                   // mean across all stored dimensions
       verdict:              'agreement' | 'conflict' | 'middle'
     } | null
   }

   The triangulation row is UPSERTED per evaluation_id. Each stage call
   merges its dimension into the existing matrix so the report sees a
   single triangulation row that grows as more stages complete.

   Env vars  : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JUDGE_ID_RE = /^[a-z0-9_]+$/;

// AI-tell lens lives with Selene only (Clarity dimension specifically).
const AI_TELL_JUDGE = 'selene_voss';
const MAX_REVISIONS_IN_PROMPT = 24;
const MAX_REV_FIELD_CHARS     = 480;

// ─────────────────────────────────────────────────────────────────────────
// DIMENSION RUBRIC CONFIG
//
// Each dimension defines what's being measured, the 0-10 scoring bands,
// what counts as a high vs. low score, and (optionally) any dimension-
// specific judge instructions. Adding a new dimension is just a new
// entry here - no new function file required.
// ─────────────────────────────────────────────────────────────────────────
const DIMENSIONS = {
  clarity: {
    label: 'CLARITY',
    definition: 'how clearly the user articulates (a) the problem they are responding to, (b) the shape of their proposed solution, and (c) the audience or context. It is NOT about whether the idea is good. Only how clearly it is expressed.',
    bands: [
      '0-2  = vague. No clear problem, no clear solution.',
      '3-4  = problem identified but solution shape is unclear.',
      '5-6  = both problem and solution stated, audience is hazy.',
      '7-8  = clear problem, clear solution, clear audience.',
      '9-10 = exceptionally precise on problem, solution, audience, and the "why".',
    ],
    tonal_notes: [
      'If the score is below 4, do not soften - your tone rules apply.',
      'If the score is 7 or above, do not flatter - say what is clear and what could still tighten.',
    ],
  },
  viability: {
    label: 'VIABILITY',
    definition: 'whether this idea holds up as a sustainable thing. For a business: is there a real revenue path, does the unit economics survive scrutiny, can this founder actually build it. For a mission / nonprofit / movement: is there a real sustaining engine - funding model, recurring impact, audience that returns - or is this a one-time push with no second year. NOT about whether the idea is good in principle. Only whether it can sustain itself.',
    bands: [
      '0-2  = not viable. No path to revenue or sustained impact. Math obviously does not work.',
      '3-4  = viability unclear. Several critical assumptions untested. Founder may not be the right person to test them.',
      '5-6  = viable with significant risks. Revenue or sustaining mechanism named but unproven. Some key viability questions still open.',
      '7-8  = clearly viable. Revenue / sustaining path is plausible. Founder fits the work. Unit economics or impact math could work.',
      '9-10 = exceptionally well-grounded viability. Specific revenue or sustaining mechanism, named first customers or beneficiaries, founder-market fit demonstrated, math holds under scrutiny.',
    ],
    tonal_notes: [
      'Viability questions are uncomfortable. Ask the question the founder has been avoiding.',
      'Pull from the brief. If the brief lacks the revenue path or the math, score lower and name that.',
      'Do NOT confuse novelty with viability. Novel ideas often die from viability failures.',
    ],
  },
};

const SUPPORTED_DIMENSIONS = Object.keys(DIMENSIONS);

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

// Selene-only AI-tell lens (Clarity stage). Other dimensions skip this.
function buildSeleneLensClause(){
  return `

SECONDARY LENS - AI WRITING TELLS
You also clock AI-writing fingerprints because 99 percent of what crosses your desk was written by AI. The long dash is the most reliable tell. Stock listy transitions ("Furthermore," "Moreover," "In conclusion"), generic abstract framing, and template-y prose are next. When you see the pattern in this submission's prose, name it once, briefly, in your finding - one phrase, flat affect, no theatrics - and let it pull your CLARITY score down. Templatey prose obscures the idea even when the structure looks tidy; the visitor's actual articulation is buried under the template, so clarity suffers.

If you do not see AI tells, do not mention them. Do not lecture. Do not hedge about being an AI character yourself - you are evaluating the prose on the page, not yourself.`;
}

function buildSystemPrompt(judge, visitorName, dimension){
  const dimCfg = DIMENSIONS[dimension];
  const toneRules  = (judge.tone_rules  || []).map(r => `- ${r}`).join('\n');
  const blindSpots = (judge.blind_spots || []).map(r => `- ${r}`).join('\n');
  const addressLine = visitorName
    ? `Address the submitter by name in vocative case at the start of your finding (e.g. "${visitorName}, ..."). Use the name once - do not repeat it.`
    : `Address the submitter directly in second person ("you"). No vocative name was provided.`;
  // Selene's AI-tell lens fires ONLY on the Clarity stage. On other
  // dimensions she scores on substance like everyone else.
  const seleneLens = (dimension === 'clarity' && judge.id === AI_TELL_JUDGE)
    ? buildSeleneLensClause()
    : '';
  const tonalNotes = (dimCfg.tonal_notes || []).map(n => `  - ${n}`).join('\n');
  return `You are ${judge.name}, ${judge.domain} on The Gauntlet panel.

Background: ${judge.background || ''}
Your lens: ${judge.lens || ''}

Character notes: ${judge.character_notes || ''}

Tone rules (follow these every line):
${toneRules}

Be aware of your own blind spots so you do not over-index on them:
${blindSpots}

You are evaluating ONE dimension of this submission: ${dimCfg.label}.

${dimCfg.label} = ${dimCfg.definition}

Score ${dimCfg.label} on a 0-10 integer scale:
${dimCfg.bands.map(b => '  ' + b).join('\n')}

Write a 2-3 sentence FINDING addressed directly to the submitter, in YOUR voice (use first person where natural, e.g. "I would..."). Plain English. NO insider jargon. NO em dashes. NO emojis. NO markdown. The user is not another expert.

${addressLine}

DIMENSION-SPECIFIC NOTES
${tonalNotes}

CONDUCT BACKSTOP: If the submission contains profanity, slurs, or personal attacks aimed at the judges or other users, do not score it on substance. Return score 0, confidence 0.5, and a finding that reads: "This submission contains language that does not meet The Chamber's conduct rules. I cannot score it on the substance until it is revised." Do not improvise around this rule.${seleneLens}

Then return YOUR CONFIDENCE in your own scoring on a 0.00 to 1.00 decimal scale.

OUTPUT JSON only, exactly this shape, nothing before or after:
{"score": <integer 0-10>, "finding": "<2-3 sentences in your voice>", "confidence": <0.00-1.00>}`;
}

// Revision-log sanitization (Selene/Clarity only consumer)
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

function buildUserPrompt(subRow, judge, revisions, dimension){
  const dimCfg = DIMENSIONS[dimension];
  const base = [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    `SUBMISSION DESCRIPTION:`,
    subRow.description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
  ].filter(Boolean);

  // Selene + clarity only: include the corridor revision log.
  if (dimension === 'clarity' && judge && judge.id === AI_TELL_JUDGE) {
    base.push('', formatRevisionLog(revisions || []));
  }

  base.push('', `Score ${dimCfg.label} now. Return JSON only.`);
  return base.join('\n');
}

// Triangulation math. Now multi-dimensional: matrix may contain multiple
// dimensions. agreement/conflict/coverage/composite all span ALL stored
// dimensions.
function computeTriangulationMulti(matrix){
  const matrixKeys = Object.keys(matrix || {});
  if (!matrixKeys.length) return null;

  const agreement_dimensions = [];
  const conflict_dimensions  = [];
  const coverage_gaps        = [];
  const allScores = [];

  matrixKeys.forEach(dim => {
    const judgeMap = matrix[dim] || {};
    const scores = Object.values(judgeMap).filter(s => typeof s === 'number');
    if (scores.length < 2) { coverage_gaps.push(dim); }
    else {
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      const normalizedSpread = (max - min) / 10;
      if (normalizedSpread <= 0.15) agreement_dimensions.push(dim);
      else if (normalizedSpread >= 0.35) conflict_dimensions.push(dim);
    }
    scores.forEach(s => allScores.push(s));
  });

  if (!allScores.length) return null;
  const mean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
  const composite_score = Math.round((mean / 10) * 100) / 100;

  let verdict = 'middle';
  if (agreement_dimensions.length && !conflict_dimensions.length) verdict = 'agreement';
  else if (conflict_dimensions.length) verdict = 'conflict';

  return { matrix, agreement_dimensions, conflict_dimensions, coverage_gaps, composite_score, verdict };
}

async function evaluateOneJudge(client, judge, subRow, visitorName, revisions, dimension){
  const systemPrompt = buildSystemPrompt(judge, visitorName, dimension);
  const userPrompt   = buildUserPrompt(subRow, judge, revisions, dimension);
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error(`[evaluate-stage:${dimension}] anthropic error for ${judge.id}`, err && err.message);
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
    console.error(`[evaluate-stage:${dimension}] parse fail for ${judge.id}`, raw && raw.slice(0, 400));
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
  const dimension     = String(body.dimension || '').trim().toLowerCase();
  const visitorName   = String(body.visitor_name || '')
                          .trim().slice(0, 60)
                          .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '')
                          .trim();
  const revisions     = sanitizeRevisions(body.revisions);

  if (!UUID_RE.test(submission_id))           return json(400, { error: 'invalid submission_id' });
  if (triad.length !== 3)                     return json(400, { error: 'triad must be 3 judge ids' });
  if (!triad.every(t => JUDGE_ID_RE.test(t))) return json(400, { error: 'triad ids invalid' });
  if (new Set(triad).size !== 3)              return json(400, { error: 'triad ids must be distinct' });
  if (!SUPPORTED_DIMENSIONS.includes(dimension)) {
    return json(400, { error: `dimension must be one of: ${SUPPORTED_DIMENSIONS.join(', ')}` });
  }

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

  // 1. Load the submission.
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, user_id, title, description, goal_audience, constraints')
    .eq('id', submission_id)
    .maybeSingle();
  if (subErr) return json(500, { error: 'submission lookup failed', detail: subErr.message });
  if (!subRow) return json(404, { error: 'submission not found' });

  // 2. Find or create the tg_evaluations row. Single row per submission;
  //    stage advances as more dimensions complete.
  let evaluationId;
  {
    const { data: existing } = await supabase
      .from('tg_evaluations')
      .select('id')
      .eq('submission_id', submission_id)
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
          stage: dimension,           // stage advances; latest dimension goes here
          status: 'running',
        })
        .select('id')
        .single();
      if (createErr) return json(500, { error: 'evaluation row create failed', detail: createErr.message });
      evaluationId = created.id;
    }
  }

  // 3. Fire all three Anthropic calls IN PARALLEL for this dimension.
  const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const results = await Promise.all(
    judges.map(j => evaluateOneJudge(client, j, subRow, visitorName, revisions, dimension))
  );

  // 4. Write each successful result to tg_judge_outputs. One row per
  //    (judge, dimension) since the judge scores each dimension separately.
  const writes = await Promise.all(results.map(async r => {
    if (r.error) return r;
    const { data: outRow, error: outErr } = await supabase
      .from('tg_judge_outputs')
      .insert({
        evaluation_id: evaluationId,
        judge_id: r.judge.id,
        stage: dimension,
        dimension_scores: { [dimension]: r.score },
        stage_critique: r.finding,
        retrieved_evidence: [],
        confidence: r.confidence,
      })
      .select('id')
      .single();
    if (outErr) {
      console.error(`[evaluate-stage:${dimension}] insert fail for ${r.judge.id}`, outErr);
      return { ...r, error: 'write_failed' };
    }
    return { ...r, output_id: outRow.id };
  }));

  const findings = writes.map(r => ({
    judge_id:   r.judge.id,
    judge_name: r.judge.name,
    dimension,
    error:      r.error || null,
    score:      r.error ? null : r.score,
    finding:    r.error ? null : r.finding,
    confidence: r.error ? null : r.confidence,
    output_id:  r.output_id || null,
  }));

  // 5. Triangulation. Multi-dimensional: read existing row, merge this
  //    dimension's matrix, recompute agreement/conflict/coverage/composite
  //    across ALL stored dimensions, upsert.
  let triangulation = null;
  try {
    // Build matrix entry for this dimension from current findings.
    const thisDimMatrix = {};
    findings.filter(f => !f.error && typeof f.score === 'number').forEach(f => {
      thisDimMatrix[f.judge_id] = f.score;
    });

    // Read existing triangulation row (if any) so we can merge.
    const { data: priorRows } = await supabase
      .from('tg_triangulations')
      .select('id, matrix')
      .eq('evaluation_id', evaluationId)
      .order('created_at', { ascending: false })
      .limit(1);
    const priorRow = (priorRows && priorRows[0]) || null;
    const priorMatrix = (priorRow && priorRow.matrix && typeof priorRow.matrix === 'object') ? priorRow.matrix : {};

    // Merge: this dimension overwrites the same key in the prior matrix.
    const mergedMatrix = { ...priorMatrix, [dimension]: thisDimMatrix };

    triangulation = computeTriangulationMulti(mergedMatrix);
    if (triangulation) {
      if (priorRow) {
        const { error: updErr } = await supabase
          .from('tg_triangulations')
          .update({
            matrix:               triangulation.matrix,
            agreement_dimensions: triangulation.agreement_dimensions,
            conflict_dimensions:  triangulation.conflict_dimensions,
            coverage_gaps:        triangulation.coverage_gaps,
            composite_score:      triangulation.composite_score,
          })
          .eq('id', priorRow.id);
        if (updErr) console.error('[evaluate-stage] triangulation update failed', updErr);
      } else {
        const { error: insErr } = await supabase
          .from('tg_triangulations')
          .insert({
            evaluation_id:        evaluationId,
            matrix:               triangulation.matrix,
            agreement_dimensions: triangulation.agreement_dimensions,
            conflict_dimensions:  triangulation.conflict_dimensions,
            coverage_gaps:        triangulation.coverage_gaps,
            composite_score:      triangulation.composite_score,
          });
        if (insErr) console.error('[evaluate-stage] triangulation insert failed', insErr);
      }
    }
  } catch (err) {
    console.error('[evaluate-stage] triangulation computation failed', err);
  }

  // 6. Update evaluation status. Mark complete only if all 3 judges
  //    returned for this dimension.
  const allOk = findings.every(f => !f.error);
  if (allOk){
    await supabase
      .from('tg_evaluations')
      .update({
        stage: dimension,
        status: `${dimension}_done`,
        completed_at: new Date().toISOString(),
      })
      .eq('id', evaluationId);
  }

  return json(200, {
    evaluation_id: evaluationId,
    dimension,
    findings,
    triangulation,
  });
};
