/* ─────────────────────────────────────────────────────────────────────────────
   tg-score-original-background — Path 2: score the visitor's ORIGINAL
   (pre-EP) brief on the same 8 dimensions, with the same 3 judges, that
   the chamber will use on the FINAL brief. The delta is the EP value-proof.

   FLOW
   ====
   1. Chamber's first dimension call (tg-evaluate-stage) creates the
      evaluation row and FIRES this function fire-and-forget with the
      submission_id + triad. Background functions return 202 immediately;
      this function then runs for the next few minutes against Anthropic.
   2. We fetch the submission to grab original_description (frozen at
      intake from the visitor's welcome-modal brief).
   3. For each of 8 dimensions x 3 judges = 24 calls, score the ORIGINAL
      brief using the same prompt machinery as tg-evaluate-stage.
   4. Each result inserts into tg_judge_outputs_before (keyed on
      submission_id).
   5. At the end we compute the triangulation and insert into
      tg_triangulations_before.

   POST body : { submission_id, triad: [judge_id, judge_id, judge_id] }
   Response  : 202 immediately (Netlify background convention)

   IMPORTANT: prompt-building logic (DIMENSIONS, buildSystemPrompt,
   buildUserPrompt, computeTriangulationMulti, evaluateOneJudge) is a
   DELIBERATE DUPLICATE of tg-evaluate-stage. Keeping the duplicate is
   safer than introducing a shared module in the middle of this slice;
   if DIMENSIONS or the prompts change, both files must update together.

   Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const judgesMaster = require('../../config/judges_master.json');

const MODEL = 'claude-sonnet-4-6';

// ── DIMENSIONS (mirrors tg-evaluate-stage) ──────────────────────────────────
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
  risk: {
    label: 'RISK',
    definition: 'what can go wrong with this idea and how well the brief acknowledges it. Adoption risk (will users actually do the thing). Technical risk (can the thing be built). Market risk (will the market still want this when it ships). Regulatory risk (what governs this domain). Financial risk (what burns the runway). Execution risk (does the team have the muscles). The score reflects both the SIZE of the risks AND whether the brief names them and has a plausible plan against them.',
    bands: [
      '0-2  = critical risks unacknowledged. The brief reads as if nothing can go wrong. Major risk categories are silently ignored.',
      '3-4  = some risks named but mitigation is hand-wavy or absent. Founder is aware of one or two risks; missing the rest.',
      '5-6  = mainstream risks named with general mitigation. The serious second-order risks are still unaddressed.',
      '7-8  = risks named specifically with named mitigations. The brief shows the founder has stress-tested the plan.',
      '9-10 = comprehensive risk read. The founder names the risks I would have raised and shows specific mitigations or honest "we accept this" choices.',
    ],
    tonal_notes: [
      'Name the risk you see, in your domain. Be specific.',
      'A high risk that is ACKNOWLEDGED scores higher than a small risk that is HIDDEN. Awareness matters.',
      'Do NOT score risk down just because the idea is ambitious. Ambition is not a risk - unaddressed risk is.',
    ],
  },
  narrative: {
    label: 'NARRATIVE',
    definition: 'whether this idea has a story spine that holds up. Why now? Why this person? Why does the customer / audience care? Is there genuine stakes and friction, or is the brief written like a feature list? Strong narrative makes the idea memorable, repeatable, and pitchable. Weak narrative leaves a brief that no one can retell in their own words.',
    bands: [
      '0-2  = no narrative spine. Reads as a feature list with no why-now and no character.',
      '3-4  = narrative attempted but loose. Why-now is unclear or generic. No genuine stakes.',
      '5-6  = serviceable narrative. Why-now exists but is not compelling. The founder is in the story but not specifically.',
      '7-8  = strong narrative. Why-now lands. The founder is in the story specifically. Stakes are real.',
      '9-10 = exceptional narrative. The story spine is so clear that someone could retell it correctly five minutes after reading.',
    ],
    tonal_notes: [
      'Narrative is not marketing - it is structure. Score the structure of the story, not its polish.',
      'A brief with a strong product but no narrative still scores low here. That gap is real and worth naming.',
    ],
  },
  evidence: {
    label: 'EVIDENCE',
    definition: 'what empirical grounding the brief has. Customer interviews. Pilot results. Survey data. Academic literature. Domain expert input. Real metrics, not projections. Strong evidence is specific (named sources, specific findings); weak evidence is "research shows" without a citation. Evidence is what separates a strong opinion from a tested hypothesis.',
    bands: [
      '0-2  = no evidence. Pure assertion. Nothing concrete to ground the claims.',
      '3-4  = anecdotal only. Personal experience, one or two informal conversations.',
      '5-6  = early evidence. Some customer interviews, an informal pilot, a referenced framework.',
      '7-8  = solid evidence. Named studies, conducted pilots with results, specific customer data with numbers.',
      '9-10 = exceptional evidence. Multiple sources triangulated, specific named studies / experts / pilots with results, the brief reads as tested rather than asserted.',
    ],
    tonal_notes: [
      'Specific over vague. "We interviewed 12 nurses" beats "talked to users."',
      'Do NOT invent citations. If the brief lacks evidence, score it for what is there, and name the gap.',
      'A claim backed by one source is not yet evidence; it is one signal.',
    ],
  },
  cultural: {
    label: 'CULTURAL',
    definition: 'whether this idea fits the cultural moment - the zeitgeist, the trend curve, the audience\'s current attention and language. Cultural fit means the idea reads as timely (right now, not five years ago, not five years from now) AND respects the audience\'s actual frame of reference. Cultural mismatch is when the idea is technically sound but tonally or temporally wrong.',
    bands: [
      '0-2  = cultural mismatch. Dead trend, wrong tone, audience moved on, or the idea is in a category the audience now distrusts.',
      '3-4  = cultural drift. The idea is from a recent moment that has shifted. Salvageable with reframing.',
      '5-6  = cultural fit is okay. The idea is timely but not differentiated by its timing.',
      '7-8  = strong cultural fit. The idea is timely, the audience is paying attention, the tone matches.',
      '9-10 = exceptional cultural timing. The idea catches a trend curve at the right moment with the right tone, and the brief shows the founder reads the room.',
    ],
    tonal_notes: [
      'Be honest about timing. "Web3 social platform" in 2026 reads differently than in 2021.',
      'Cultural fit includes language. Brief that uses dated vocabulary signals a founder out of touch with the audience.',
    ],
  },
  psych: {
    label: 'PSYCH',
    definition: 'whether this idea respects how humans actually behave. Does it understand buyer psychology - what people emotionally need rather than what they say they want? Does it design against friction, not assume it away? Does the founder show real understanding of identity, status, loss aversion, certainty, belonging - or is the brief built for a hypothetical "rational user" who does not exist?',
    bands: [
      '0-2  = ignores human psychology. Built for rational-user-who-does-not-exist. Assumes adoption will happen because the product is good.',
      '3-4  = some psychological awareness, mostly surface. Names a use case without naming the emotional driver.',
      '5-6  = solid psychological grounding. Names the primary emotional driver of the buy, designs for friction.',
      '7-8  = strong behavioral design. Specific emotional drivers named, identity framing clear, friction designed against.',
      '9-10 = exceptional psychological literacy. The brief names what the customer wants to FEEL or BECOME, the trigger moment, the silent objections, and the design addresses them.',
    ],
    tonal_notes: [
      'Stated preferences are not revealed preferences. A brief that takes user-stated needs at face value scores lower than one that surfaces the underlying driver.',
      'People buy emotion and justify with logic. If the brief leads with logic, ask what emotional driver is actually doing the work.',
    ],
  },
  compliance: {
    label: 'COMPLIANCE',
    definition: 'the regulatory, legal, ethical, accessibility, privacy, and safety layer. Whether the brief has correctly identified which regimes apply (FDA, FCC, CPSC, REACH, CPSIA, GDPR / CCPA, WCAG accessibility, COPPA if children, financial advisor regs, medical claims, etc.) AND shown awareness of their requirements. Compliance failures are usually invisible until they are very expensive.',
    bands: [
      '0-2  = clear compliance failures. The brief makes claims or designs that would be illegal, unsafe, or block launch in the target market.',
      '3-4  = compliance ignored. The brief shows no awareness of the regimes that apply to its domain.',
      '5-6  = surface awareness. The brief names a regulatory regime without showing what compliance requires.',
      '7-8  = real compliance awareness. The brief names the route (510(k), CE mark, GDPR DPA, etc.) and shows the founder is engaging it.',
      '9-10 = exceptional compliance design. Privacy / accessibility / safety / regulatory baked into the product design from the beginning, not bolted on.',
    ],
    tonal_notes: [
      'Be specific about which regime applies and which does not. Vague compliance talk is worse than honest "we have not looked at this yet."',
      'Compliance is NOT legal advice. Score what the brief shows; recommend the founder talk to counsel.',
      'A consumer good with NO regulatory exposure can still score high here if the brief shows the founder verified that and addressed privacy / advertising / accessibility.',
    ],
  },
};

const SUPPORTED_DIMENSIONS = Object.keys(DIMENSIONS);

// ── Helpers ─────────────────────────────────────────────────────────────────
function findJudge(judgeId){
  return (judgesMaster.judges || []).find(j => j.id === judgeId);
}

function buildSystemPrompt(judge, visitorName, dimension){
  const dimCfg = DIMENSIONS[dimension];
  const toneRules  = (judge.tone_rules  || []).map(r => `- ${r}`).join('\n');
  const blindSpots = (judge.blind_spots || []).map(r => `- ${r}`).join('\n');
  const addressLine = visitorName
    ? `Address the submitter by name in vocative case at the start of your finding (e.g. "${visitorName}, ..."). Use the name once - do not repeat it.`
    : `Address the submitter directly in second person ("you"). No vocative name was provided.`;
  // Selene's AI-tell lens is INTENTIONALLY OMITTED here. The before-pass
  // scores the visitor's pristine original prose; we are not yet looking
  // for the EP-shaped patterns that lens exists to detect.
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

CONDUCT BACKSTOP: If the submission contains profanity, slurs, or personal attacks aimed at the judges or other users, do not score it on substance. Return score 0, confidence 0.5, and a finding that reads: "This submission contains language that does not meet The Chamber's conduct rules. I cannot score it on the substance until it is revised." Do not improvise around this rule.

Then return YOUR CONFIDENCE in your own scoring on a 0.00 to 1.00 decimal scale.

OUTPUT JSON only, exactly this shape, nothing before or after:
{"score": <integer 0-10>, "finding": "<2-3 sentences in your voice>", "confidence": <0.00-1.00>}`;
}

function buildUserPrompt(subRow, dimension){
  const dimCfg = DIMENSIONS[dimension];
  // The before-pass uses original_description (frozen at intake) - NOT
  // the description column which has been mutated by EP work.
  const base = [
    `SUBMISSION TITLE: ${subRow.title}`,
    '',
    `SUBMISSION DESCRIPTION:`,
    subRow.original_description,
    subRow.goal_audience ? `\nSTATED AUDIENCE: ${subRow.goal_audience}` : '',
    subRow.constraints   ? `\nSTATED CONSTRAINTS: ${subRow.constraints}` : '',
  ].filter(Boolean);
  base.push('', `Score ${dimCfg.label} now. Return JSON only.`);
  return base.join('\n');
}

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

  return { matrix, agreement_dimensions, conflict_dimensions, coverage_gaps, composite_score };
}

async function evaluateOneJudge(client, judge, subRow, visitorName, dimension){
  const systemPrompt = buildSystemPrompt(judge, visitorName, dimension);
  const userPrompt   = buildUserPrompt(subRow, dimension);
  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error(`[score-original-bg:${dimension}] anthropic error for ${judge.id}`, err && err.message);
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
    console.error(`[score-original-bg:${dimension}] parse fail for ${judge.id}`, raw && raw.slice(0, 400));
    return { judge, error: 'parse_failed' };
  }
  const score      = Math.max(0, Math.min(10, parseInt(parsed.score, 10) || 0));
  const finding    = String(parsed.finding || '').trim();
  const confidence = Math.max(0, Math.min(1, parseFloat(parsed.confidence) || 0));
  if (!finding) return { judge, error: 'no_finding' };
  return { judge, score, finding, confidence };
}

// ── Handler (Netlify background function) ───────────────────────────────────
// Returns 202 immediately; the work runs after the response is sent.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, body: 'invalid json' }; }

  const submission_id = String(body.submission_id || '').trim();
  const triadRaw      = Array.isArray(body.triad) ? body.triad : [];
  const visitorName   = String(body.visitor_name || '').trim().slice(0, 60);
  if (!submission_id || triadRaw.length !== 3) {
    return { statusCode: 400, body: 'submission_id and triad of 3 required' };
  }

  const triad = triadRaw
    .map(id => findJudge(String(id || '')))
    .filter(Boolean);
  if (triad.length !== 3) {
    console.error('[score-original-bg] invalid triad', triadRaw);
    return { statusCode: 400, body: 'one or more triad judges not recognized' };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY || !ANTHROPIC_KEY) {
    console.error('[score-original-bg] env missing');
    return { statusCode: 500, body: 'env missing' };
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const client   = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // 1. Fetch submission (we need original_description, title, audience,
  //    constraints).
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, title, original_description, description, goal_audience, constraints')
    .eq('id', submission_id)
    .single();

  if (subErr || !subRow) {
    console.error('[score-original-bg] submission fetch failed', subErr);
    return { statusCode: 404, body: 'submission not found' };
  }

  // 2. If original_description is empty or identical to the final
  //    description, the visitor never touched the brief in the corridor.
  //    There is no meaningful "before" to score; skip silently.
  const original = String(subRow.original_description || '').trim();
  if (!original) {
    console.log('[score-original-bg] no original_description, skipping');
    return { statusCode: 202, body: 'no original brief on submission; skipping' };
  }
  if (original === String(subRow.description || '').trim()) {
    console.log('[score-original-bg] original matches final, skipping');
    return { statusCode: 202, body: 'original matches final; nothing to do' };
  }

  // 3. Idempotency: if a triangulation_before row already exists for
  //    this submission, do not re-run. The bg function may get invoked
  //    multiple times if the chamber retries; we only score once.
  const { data: existingTri } = await supabase
    .from('tg_triangulations_before')
    .select('id')
    .eq('submission_id', submission_id)
    .maybeSingle();
  if (existingTri) {
    console.log('[score-original-bg] already scored, skipping');
    return { statusCode: 202, body: 'already scored' };
  }

  // 4. Loop dimensions x triad. For each dimension, fan out the 3 judge
  //    calls in parallel; serialize across dimensions to keep load even.
  const matrix = {};
  for (const dimension of SUPPORTED_DIMENSIONS) {
    const results = await Promise.all(
      triad.map(j => evaluateOneJudge(client, j, subRow, visitorName, dimension))
    );

    const dimEntry = {};
    for (const r of results) {
      if (r.error || typeof r.score !== 'number') {
        console.error(`[score-original-bg] ${dimension}/${r.judge && r.judge.id} failed: ${r.error || 'unknown'}`);
        continue;
      }
      // Persist the judge output to the _before table.
      const { error: outErr } = await supabase
        .from('tg_judge_outputs_before')
        .insert({
          submission_id,
          judge_id:           r.judge.id,
          stage:              dimension,
          dimension_scores:   { [dimension]: r.score },
          stage_critique:     r.finding,
          retrieved_evidence: [],
          confidence:         r.confidence,
        });
      if (outErr) console.error(`[score-original-bg:${dimension}] insert fail for ${r.judge.id}`, outErr);
      dimEntry[r.judge.id] = r.score;
    }
    matrix[dimension] = dimEntry;
  }

  // 5. Compute the triangulation across all dimensions and store.
  const triangulation = computeTriangulationMulti(matrix);
  if (!triangulation) {
    console.error('[score-original-bg] no valid scores produced');
    return { statusCode: 500, body: 'no valid scores' };
  }

  const { error: triErr } = await supabase
    .from('tg_triangulations_before')
    .insert({
      submission_id,
      matrix:               triangulation.matrix,
      agreement_dimensions: triangulation.agreement_dimensions,
      conflict_dimensions:  triangulation.conflict_dimensions,
      coverage_gaps:        triangulation.coverage_gaps,
      composite_score:      triangulation.composite_score,
    });
  if (triErr) {
    console.error('[score-original-bg] triangulation insert failed', triErr);
    return { statusCode: 500, body: 'triangulation insert failed' };
  }

  console.log(`[score-original-bg] complete for ${submission_id}: composite=${triangulation.composite_score}`);
  return { statusCode: 202, body: 'scored' };
};
