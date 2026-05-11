/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — The Gauntlet (background eval engine)

   Triggered by gauntlet-init.js with a run_id only. Reads parsed_text from
   the gauntlet_runs row, runs the multi-pass evaluation, persists, clears
   parsed_text for privacy.

   Background function: returns 202 immediately to caller; the actual work
   continues for up to 15 minutes.

   Architecture (per spec):
     1. Stagnation Heuristic — deterministic regex on 5 patterns
     2. Multi-pass evaluation: 3 passes, each producing all 5 Pillar bands,
        median band wins per Pillar (reproducibility)
     3. Anti-sycophancy validator: regex blocklist on each pass output;
        regen up to 2x; on 3rd consecutive failure, hard-fail the entire run,
        DO NOT charge credits, log to gauntlet_validator_failures
     4. Synthesis pass: executive summary, Red Ink List, tool recommendations
     5. Persist + deduct credits + clear parsed_text
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const PASSES = 3;
const REGEN_BUDGET = 2;                           // 1 attempt + 2 regens = 3 attempts max

const PILLARS = [
  'sensory_depth',
  'dialogue_vitality',
  'pacing_tension',
  'structural_integrity',
  'character_agency',
];

const BAND_ORDER = ['professional', 'competent', 'developmental', 'foundational'];

// ── Hedge scrubbing: removed silently from output before validation/parse ──
// First-person hedges are style violations, not sycophancy. Strip them.
const HEDGE_SCRUB_PATTERNS = [
  /\bI think\b\s*,?\s*/gi,
  /\bI believe\b\s*,?\s*/gi,
  /\bin my opinion\b\s*,?\s*/gi,
  /\bI feel(?:\s+that)?\b\s*/gi,
];

function scrubHedges(text) {
  let out = text;
  for (const re of HEDGE_SCRUB_PATTERNS) out = out.replace(re, '');
  // Capitalize a sentence start that lost its leading "I think, "
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

// ── Anti-sycophancy validator: hard-fail on compensatory praise patterns ─────
// Tightened to actual sycophancy markers. Generic critical language ("on the
// other hand", "has potential", "solid foundation") is allowed; the validator
// only rejects the pattern of cushioning critique with praise.
const BANNED_PATTERNS = [
  /great job,?\s*but\b/i,
  /strong start,?\s*but\b/i,
  /however,?\s+the strengths include/i,
  /while this works well/i,
  /\bthis is a strong start\b/i,
  /\bwith some polish\b/i,
  /\bthe author shows promise\b/i,
  /\bcompelling start\b/i,
  /\bto be fair\b/i,
];

// ─────────────────────────────────────────────────────────────────────────────
// Entry — Background function
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400 }; }

  const { run_id: runId } = body;
  if (!runId) return { statusCode: 400 };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    console.error('[gauntlet-bg] server not configured');
    return { statusCode: 500 };
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    await processGauntlet(runId, supabase, ANTHROPIC_KEY);
  } catch (err) {
    console.error('[gauntlet-bg] uncaught error', err);
    await supabase.from('gauntlet_runs').update({
      status: 'failed',
      error_message: err.message || String(err),
      parsed_text: null,
    }).eq('id', runId).then(() => {}, () => {});
  }

  return { statusCode: 202 };  // Background functions: response is dropped, this is just for the event log
};

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────
async function processGauntlet(runId, supabase, anthropicKey) {
  const startTime = Date.now();

  // Load the run
  const { data: run, error: loadErr } = await supabase
    .from('gauntlet_runs')
    .select('*')
    .eq('id', runId)
    .single();
  if (loadErr || !run) throw new Error('Could not load run: ' + (loadErr?.message || 'not found'));
  if (run.status !== 'queued') {
    console.warn(`[gauntlet-bg] run ${runId} not in queued state (${run.status}), aborting`);
    return;
  }

  const text = run.parsed_text;
  if (!text) throw new Error('Run row missing parsed_text');

  const { user_id: userId, scope, excerpt_context: excerptContext, user_scope: userScope } = run;
  // Cost map keyed on user_scope (the tier the user picked + paid for).
  // Falls back to backend scope for legacy rows.
  const SCOPE_COSTS = {
    chapter: 25, novella_20k: 50, novella_50k: 75, manuscript: 100,
    full_manuscript: 100, full_chapter: 25, excerpt: 25,  // legacy fallback
  };
  const cost = SCOPE_COSTS[userScope] ?? SCOPE_COSTS[scope] ?? 25;

  // Mark running
  await supabase.from('gauntlet_runs').update({ status: 'running' }).eq('id', runId);
  console.log(`[gauntlet-bg] ${runId}: status=running, scope=${scope}, words=${text.split(/\s+/).length}`);

  // 180s per LLM call. Synth with 6000-token budget can run 90-120s legitimately.
  // 4 calls × 180s = 12 min, still under the 15-min BG cap.
  const client = new Anthropic({ apiKey: anthropicKey, timeout: 180000, maxRetries: 1 });

  // ── Stagnation Heuristic (deterministic regex) ────────────────────────────
  const stagnation = analyzeStagnation(text);
  if (stagnation.pattern3_flagged_paragraphs?.length) {
    const rows = stagnation.pattern3_flagged_paragraphs.map((p) => ({
      run_id: runId,
      paragraph_text: p.text.slice(0, 2000),
      paragraph_index: p.index,
      sensory_word_count: p.sensory_count,
      abstract_verb_count: p.abstract_count,
      sentence_count: p.sentence_count,
    }));
    supabase.from('gauntlet_pattern3_flags').insert(rows).then(() => {}, () => {});
  }

  // ── Multi-pass evaluation ──────────────────────────────────────────────────
  const passResults = [];
  let validatorRegens = 0;
  const validatorAttemptLog = [];

  for (let p = 0; p < PASSES; p++) {
    let result = null;
    let lastViolation = null;

    for (let attempt = 0; attempt <= REGEN_BUDGET; attempt++) {
      const t0 = Date.now();
      console.log(`[gauntlet-bg] ${runId}: pass ${p+1}/${PASSES} attempt ${attempt+1} starting`);
      const evalRes = await runEvalPass({
        client, text, scope, excerptContext, passNum: p, attempt, lastViolation,
      });
      console.log(`[gauntlet-bg] ${runId}: pass ${p+1} attempt ${attempt+1} done in ${Date.now()-t0}ms, rawText=${evalRes.rawText.length}b, parsed=${!!evalRes.parsed}`);
      const validation = validateAntiSycophancy(evalRes.rawText);
      if (validation.passed && evalRes.parsed) {
        result = evalRes.parsed;
        break;
      }
      validatorRegens++;
      validatorAttemptLog.push({
        pass: p,
        attempt,
        output_excerpt: evalRes.rawText.slice(0, 800),
        banned_phrases_matched: validation.matched,
      });
      lastViolation = validation.matched;
    }

    if (!result) {
      // Hard fail — abort run, refund credits (by not charging), log
      await supabase.from('gauntlet_validator_failures').insert({
        run_id: runId,
        user_id: userId,
        scope,
        prompt_excerpt: text.slice(0, 500),
        attempts: validatorAttemptLog,
      });
      await supabase.from('gauntlet_runs').update({
        status: 'failed',
        error_message: 'Anti-sycophancy validator rejected 3 consecutive outputs (hard fail per spec). Credits not charged. This is a system failure, not a content failure — please retry or contact support if it recurs.',
        validator_regens: validatorRegens,
        elapsed_runtime_ms: Date.now() - startTime,
        parsed_text: null,
      }).eq('id', runId);
      return;
    }

    passResults.push(result);
  }

  // ── Resolve bands (median per pillar) ──────────────────────────────────────
  const pillarBands = resolveBands(passResults);
  const honestyScore = computeHonestyScore(pillarBands);

  // ── Synthesis pass ─────────────────────────────────────────────────────────
  const tSyn = Date.now();
  console.log(`[gauntlet-bg] ${runId}: synthesis pass starting`);
  const synthesis = await runSynthesisPass({
    client, text, scope, excerptContext, passResults, stagnation, pillarBands, honestyScore,
  });
  console.log(`[gauntlet-bg] ${runId}: synthesis done in ${Date.now()-tSyn}ms`);

  const elapsedMs = Date.now() - startTime;

  // ── Persist final ──────────────────────────────────────────────────────────
  await supabase.from('gauntlet_runs').update({
    status: 'complete',
    honesty_score: honestyScore,
    pillar_bands: pillarBands,
    pillar_findings: synthesis.pillar_findings,
    stagnation_flags: {
      patterns_detected: stagnation.patterns_detected,
      density_per_pattern: stagnation.density_per_pattern,
      routed_to_enricher: stagnation.routed_to_enricher,
    },
    chapter_heat_map: synthesis.chapter_heat_map,
    executive_summary: synthesis.executive_summary,
    red_ink_list: synthesis.red_ink_list,
    tool_recommendations: synthesis.tool_recommendations,
    pass_raw_bands: passResults.map((r) => r.bands),
    validator_regens: validatorRegens,
    credits_charged: cost,
    elapsed_runtime_ms: elapsedMs,
    parsed_text: null,                              // privacy: clear after eval
  }).eq('id', runId);

  // ── Deduct credits ─────────────────────────────────────────────────────────
  const { data: balRow } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  const currentBalance = balRow?.balance ?? 0;
  await supabase.from('gp_credits').update({
    balance: Math.max(0, currentBalance - cost),
  }).eq('user_id', userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-sycophancy validator
// ─────────────────────────────────────────────────────────────────────────────
function validateAntiSycophancy(text) {
  const matched = [];
  for (const re of BANNED_PATTERNS) {
    const m = text.match(re);
    if (m) matched.push(m[0]);
  }
  return { passed: matched.length === 0, matched };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stagnation Heuristic — five patterns, deterministic regex
// ─────────────────────────────────────────────────────────────────────────────
function analyzeStagnation(text) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  const totalWords = words.length;

  // Pattern 1: Passive construction
  const passiveRe = /\b(?:was|were|is|are|been|being|be|had been|has been|have been)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi;
  const passiveMatches = (text.match(passiveRe) || []).length;
  const passiveDensity = totalWords > 0 ? passiveMatches / totalWords : 0;
  const pattern1 = passiveDensity > 0.03;

  // Pattern 2: Adverb-dependent dialogue tags
  const dialogueTagRe = /(?:said|asked|replied|whispered|shouted|murmured|exclaimed|stated|cried|growled|hissed|added|yelled|sighed|grumbled|muttered|snapped|barked)\b/gi;
  const advTagRe = /(?:said|asked|replied|whispered|shouted|murmured|exclaimed|stated|cried|growled|hissed|added|yelled|sighed|grumbled|muttered|snapped|barked)\s+\w+ly\b/gi;
  const totalTags = (text.match(dialogueTagRe) || []).length;
  const advTags = (text.match(advTagRe) || []).length;
  const advTagRatio = totalTags > 0 ? advTags / totalTags : 0;
  const pattern2 = totalTags >= 4 && advTagRatio > 0.25;

  // Pattern 3: Abstract summary (regex proxy)
  const sensoryRe = /\b(?:saw|see|seen|seeing|watched|spotted|glanced|stared|looked|heard|listened|listening|smelled|tasted|felt|touched|brushed|warmth|cold|chill|bright|dim|sharp|soft|loud|quiet|silence|sweet|bitter|salty|sour|rough|smooth|wet|dry|hot|cool|breeze|wind|sun|shadow|smell|scent|aroma|taste|flavor|sound|noise|whisper|hum|crackle|clatter|rustle)\b/gi;
  const abstractVerbRe = /\b(?:was|were|had|became|seemed|felt that|knew that|thought that|realized|understood|considered|believed|wondered|imagined)\b/gi;
  const pattern3FlaggedParagraphs = [];
  let pattern3FlaggedCount = 0;
  paragraphs.forEach((p, idx) => {
    const sentenceCount = (p.match(/[.!?]+/g) || []).length;
    if (sentenceCount < 3) return;
    const sensoryCount = (p.match(sensoryRe) || []).length;
    const abstractCount = (p.match(abstractVerbRe) || []).length;
    const pWords = p.split(/\s+/).filter(Boolean).length;
    const abstractDensity = pWords > 0 ? abstractCount / pWords : 0;
    if (sensoryCount === 0 && pWords >= 50 && abstractDensity > 0.05) {
      pattern3FlaggedCount++;
      if (pattern3FlaggedParagraphs.length < 20) {
        pattern3FlaggedParagraphs.push({
          text: p, index: idx, sensory_count: sensoryCount,
          abstract_count: abstractCount, sentence_count: sentenceCount,
        });
      }
    }
  });
  const pattern3 = pattern3FlaggedCount >= Math.max(2, paragraphs.length * 0.10);

  // Pattern 4: Repetitive sentence structure
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  let pattern4Hits = 0;
  for (let i = 0; i + 4 < sentences.length; i++) {
    const window = sentences.slice(i, i + 5);
    const heads = window.map((s) => s.split(/\s+/).slice(0, 2).join(' ').toLowerCase());
    const counts = {};
    for (const h of heads) counts[h] = (counts[h] || 0) + 1;
    const max = Math.max(...Object.values(counts));
    const dominant = Object.keys(counts).find((k) => counts[k] === max) || '';
    const isCommonHead = /^(the|he|she|i|it|they)\b/.test(dominant);
    if (max >= 3 && !isCommonHead) pattern4Hits++;
  }
  const pattern4 = pattern4Hits >= Math.max(2, sentences.length * 0.05);

  // Pattern 5: Stative verb chains
  const stativeRe = /\b(?:was|were|seemed|appeared|felt|knew|thought|believed|wanted|loved|hated|existed|remained|had|has|is|are|exists)\b/gi;
  const dynamicRe = /\b(?:ran|jumped|grabbed|threw|slammed|pulled|pushed|opened|closed|walked|spun|crashed|drove|rushed|gasped|laughed|kicked|fired|hit|struck|caught|broke|shouted|sprinted|charged|leapt)\b/gi;
  const stativeCount = (text.match(stativeRe) || []).length;
  const dynamicCount = (text.match(dynamicRe) || []).length;
  const stativeRatio = (stativeCount + dynamicCount) > 0
    ? stativeCount / (stativeCount + dynamicCount)
    : 0;
  const pattern5 = (stativeCount + dynamicCount) >= 20 && stativeRatio > 0.60;

  const patterns = [
    { id: 'passive_construction', tripped: pattern1, density: passiveDensity },
    { id: 'adverb_dialogue_tags', tripped: pattern2, density: advTagRatio },
    { id: 'abstract_summary',     tripped: pattern3, density: pattern3FlaggedCount / Math.max(1, paragraphs.length) },
    { id: 'repetitive_structure', tripped: pattern4, density: pattern4Hits / Math.max(1, sentences.length) },
    { id: 'stative_verb_chains',  tripped: pattern5, density: stativeRatio },
  ];
  const tripped = patterns.filter((p) => p.tripped);
  const routedToEnricher = tripped.length >= 2;

  return {
    patterns_detected: tripped.map((p) => p.id),
    density_per_pattern: Object.fromEntries(patterns.map((p) => [p.id, +(p.density.toFixed(4))])),
    routed_to_enricher: routedToEnricher,
    pattern3_flagged_paragraphs: pattern3FlaggedParagraphs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-pass evaluation
// ─────────────────────────────────────────────────────────────────────────────
async function runEvalPass({ client, text, scope, excerptContext, passNum, attempt, lastViolation }) {
  const systemPrompt = buildEvalSystemPrompt({ scope, attempt, lastViolation });
  const userPrompt = buildEvalUserPrompt({ text, scope, excerptContext, passNum });

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0.7,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt, cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  });

  const rawText = scrubHedges((resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(''));

  let parsed = null;
  try {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch { /* parsed stays null */ }

  return { rawText, parsed };
}

function buildEvalSystemPrompt({ scope, attempt, lastViolation }) {
  let regenSteer = '';
  if (attempt > 0) {
    regenSteer = `\n\nYour previous output contained these compensatory-praise structures: ${JSON.stringify(lastViolation || [])}. Rewrite without any cushioning. State problems directly. State strengths directly when they are genuinely strong. No "great job but", no "however the strengths include", no "with some polish", no compensatory framing of any kind.`;
  }

  const provisionalNote = scope === 'excerpt'
    ? 'On excerpts, Pacing/Tension, Structural Integrity, and Character Agency are PROVISIONAL — base your bands on what is observable in the excerpt and explicitly flag judgments that depend on context not provided.'
    : '';

  return `You are the Gauntlet, a manuscript diagnostic. You evaluate fiction against the standard of professional publishable fiction in the genre. The standard is fixed. Beginners do not get easier grading.

You are strictly prohibited from being polite, encouraging, or compensatory. You distinguish craft failures from stylistic choices: craft failures are stated as failures; stylistic choices are noted as choices the writer is making.

Write in third-person observational voice. Never use first-person ("I think", "I believe", "in my opinion", "I feel"). Findings are observations: "pacing drags in scene 3", not "I think pacing drags in scene 3".

Banned compensatory-praise structures that MUST NOT appear: "great job, but", "strong start, but", "however the strengths include", "while this works well", "this is a strong start", "with some polish", "the author shows promise", "compelling start", "to be fair". Do not cushion. Do not compensate criticism with praise.

Do not use em dashes (—) in your output. Use periods, commas, colons, or short sentences instead. Em dashes are an AI tell and are banned from all GP-produced text.

Apply the PAID framework: Position the manuscript honestly. Audit the actual writing. Interrogate weaknesses. Demand specifics.

Evaluate across five Tests:
  1. SENSORY DEPTH — concrete sensory rendering vs. abstract summary
  2. DIALOGUE VITALITY — distinct voices, subtext, vs. on-the-nose / exposition
  3. PACING AND TENSION — rhythm; stalling, compression, sprawl
  4. STRUCTURAL INTEGRITY — beats, escalation, scene-level accomplishment
  5. CHARACTER AGENCY — characters drive vs. are dragged by plot

Each Test receives ONE band:
  - PROFESSIONAL    — meets the standard of currently publishable fiction
  - COMPETENT       — working command, identified weaknesses to address in revision
  - DEVELOPMENTAL   — substantive problems requiring focused revision
  - FOUNDATIONAL    — fundamental problems requiring rebuilding rather than revising

${provisionalNote}

OUTPUT FORMAT — return a single JSON object, no preamble, no markdown fences:
{
  "bands": {
    "sensory_depth":         "professional|competent|developmental|foundational",
    "dialogue_vitality":     "professional|competent|developmental|foundational",
    "pacing_tension":        "professional|competent|developmental|foundational",
    "structural_integrity":  "professional|competent|developmental|foundational",
    "character_agency":      "professional|competent|developmental|foundational"
  },
  "findings_per_pillar": {
    "sensory_depth":         { "summary": "...", "holes": [{"ref": "para 4", "finding": "..."}, ...] },
    "dialogue_vitality":     { "summary": "...", "holes": [...] },
    "pacing_tension":        { "summary": "...", "holes": [...] },
    "structural_integrity":  { "summary": "...", "holes": [...] },
    "character_agency":      { "summary": "...", "holes": [...] }
  },
  "red_ink_candidates": [
    {"finding": "...", "author_action": "..."},
    {"finding": "...", "author_action": "..."}
  ]
}

Each summary is one to three sentences. Each hole is a specific reference + a specific finding (not "could be improved" — describe what is wrong). Red Ink candidates are problems no GP tool will fix; the author has to address them.${regenSteer}`;
}

function buildEvalUserPrompt({ text, scope, excerptContext, passNum }) {
  let header = `MANUSCRIPT SCOPE: ${scope.replace('_', ' ')}\n`;
  if (scope === 'excerpt' && excerptContext) {
    header += `\nEXCERPT CONTEXT (provided by author):\n`;
    header += `- Position in work: ${excerptContext.position || 'unknown'}\n`;
    if (excerptContext.protagonist) header += `- Protagonist's situation: ${excerptContext.protagonist}\n`;
    if (excerptContext.prior_scene) header += `- What just happened: ${excerptContext.prior_scene}\n`;
  }
  header += `\nPASS: ${passNum + 1} of ${PASSES} (multi-pass for reproducibility — independent evaluation, your bands will be combined with other passes via median)\n\n`;
  header += `MANUSCRIPT:\n---\n`;
  return header + text + '\n---\n\nReturn the JSON object now.';
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis pass
// ─────────────────────────────────────────────────────────────────────────────
async function runSynthesisPass({ client, text, scope, excerptContext, passResults, stagnation, pillarBands, honestyScore }) {
  const systemPrompt = `You are the Gauntlet's synthesis layer. The 5-Test bands have already been resolved across 3 passes. Your job is to write the Report Card prose: an executive summary, per-Test findings, the Red Ink List, and tool recommendations.

Same anti-sycophancy rules apply. No hedging, no cushioning, no "I think". Direct statements only.

Write in third-person observational voice. No first-person ("I think", "I believe", "in my opinion"). Banned compensatory structures: "great job, but", "with some polish", "shows promise", "compelling start", "to be fair".

Do not use em dashes (—) in your output. Use periods, commas, colons, or short sentences instead.

Apply the Remediation Map:
  - Low Sensory Depth → Prose Enricher
  - Flat Dialogue → Add Dialogue
  - Sparse Source in adaptation flow → Adapt from Source (only if that's the workflow; not for restructuring novels with structural issues)
  - Structural problems in existing manuscript → Structural Rebuild
  - Weak Pacing → Scene Builder
  - Repetitive Vocabulary or Generic Description → Descriptor Library
  - Stagnant Prose Patterns → Prose Enricher
  - Character voice questions or testing how a character sounds → Character Interviewer (Author Playground)
  - Manuscript world-building gaps or location lore questions → World-Building Map Explorer (Author Playground)
  - Wanting a podcast-style critique of pacing, arcs, structure → Podcast-Style Reviewer (Author Playground)
  - Foundational Problems → no tool routing; author revision required

OUTPUT FORMAT — single JSON object, no preamble, no markdown fences:
{
  "executive_summary": "Cold blunt assessment, ~200 words. Lead with what is not working. Note genuine strengths only when they are genuinely strong.",
  "pillar_findings": {
    "sensory_depth":        { "summary": "...", "holes": [...] },
    "dialogue_vitality":    { "summary": "...", "holes": [...] },
    "pacing_tension":       { "summary": "...", "holes": [...] },
    "structural_integrity": { "summary": "...", "holes": [...] },
    "character_agency":     { "summary": "...", "holes": [...] }
  },
  "chapter_heat_map": [],
  "red_ink_list": [
    { "rank": 1, "finding": "specific problem", "author_action": "specific action no tool can do" }
  ],
  "tool_recommendations": [
    { "tool": "enrich" | "dialog" | "adapt" | "structural_rebuild" | "scene_builder" | "descriptor_library" | "character_interviewer" | "podcast_reviewer" | "worldbuilding_map", "excerpt": "the relevant excerpt", "diagnosis": "what is wrong", "why": "why this tool addresses it" }
  ]
}

Red Ink List: 3-5 items where no tool will fix the problem.
Tool Recommendations: only include tools that ACTUALLY address the diagnosed issue. Better to recommend nothing than to recommend a tool that doesn't fit.`;

  const userPrompt = `PILLAR BANDS (resolved across 3 passes):
${JSON.stringify(pillarBands, null, 2)}

HONESTY SCORE: ${honestyScore}

PER-PASS FINDINGS:
${JSON.stringify(passResults.map((r) => r.findings_per_pillar), null, 2)}

PER-PASS RED INK CANDIDATES:
${JSON.stringify(passResults.flatMap((r) => r.red_ink_candidates || []), null, 2)}

STAGNATION HEURISTIC:
- Patterns detected: ${JSON.stringify(stagnation.patterns_detected)}
- Routed to Prose Enricher: ${stagnation.routed_to_enricher}

SCOPE: ${scope}${scope === 'excerpt' ? `\nEXCERPT CONTEXT: ${JSON.stringify(excerptContext)}` : ''}

MANUSCRIPT:
---
${text}
---

Return the JSON object now.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 6000,
    temperature: 0.4,
    system: [
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: userPrompt }] },
    ],
  });

  const rawText = scrubHedges((resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(''));

  // Strip ```json or """json fences if present, then extract outermost {…}
  const cleaned = rawText
    .replace(/^(?:```|""")(?:json)?\s*/i, '')
    .replace(/(?:```|""")\s*$/i, '');
  let parsed = {
    executive_summary: cleaned.slice(0, 600),
    pillar_findings: {}, chapter_heat_map: [], red_ink_list: [], tool_recommendations: [],
  };
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('[gauntlet-bg] synthesis JSON parse failed:', e.message);
  }

  return parsed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Band resolution (median per pillar)
// ─────────────────────────────────────────────────────────────────────────────
function resolveBands(passResults) {
  const out = {};
  for (const pillar of PILLARS) {
    const ranks = passResults
      .map((r) => r.bands?.[pillar])
      .filter(Boolean)
      .map((b) => BAND_ORDER.indexOf(b.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    if (ranks.length === 0) {
      out[pillar] = 'developmental';
      continue;
    }
    const median = ranks[Math.floor(ranks.length / 2)];
    out[pillar] = BAND_ORDER[median];
  }
  return out;
}

function computeHonestyScore(pillarBands) {
  const ranks = Object.values(pillarBands)
    .map((b) => BAND_ORDER.indexOf(b))
    .filter((i) => i >= 0);
  if (!ranks.length) return 'developmental';
  const worst = Math.max(...ranks);
  return BAND_ORDER[worst];
}
