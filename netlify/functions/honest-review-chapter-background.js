/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review · STAGE 2: Chapter Evaluation

   One invocation per sampled chapter. Five chapters run in parallel.
   Each invocation:
     1. Loads its chapter slot from the honest_reviews row.
     2. Runs 3 independent diagnostic passes through the eval engine.
     3. Resolves the chapter's median band per Test.
     4. Writes its results back to the chapter_evaluations[slot] entry.
     5. Checks if all 5 chapters are now status='complete'. If so, triggers
        the Synthesis BG. (Race condition handled by synthesis BG checking
        status before doing work.)

   Anti-sycophancy validator on every pass output (same as Gauntlet/brief).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const PASSES_PER_CHAPTER = 3;
const REGEN_BUDGET = 2;
const TESTS = ['sensory_depth', 'dialogue_vitality', 'pacing_tension', 'structural_integrity', 'character_agency'];
const BAND_ORDER = ['professional', 'competent', 'developmental', 'foundational'];

const HEDGE_SCRUB_PATTERNS = [
  /\bI think\b\s*,?\s*/gi, /\bI believe\b\s*,?\s*/gi,
  /\bin my opinion\b\s*,?\s*/gi, /\bI feel(?:\s+that)?\b\s*/gi,
];
function scrubHedges(text) {
  let out = text;
  for (const re of HEDGE_SCRUB_PATTERNS) out = out.replace(re, '');
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

const BANNED_PATTERNS = [
  /great job,?\s*but\b/i, /strong start,?\s*but\b/i,
  /however,?\s+the strengths include/i, /while this works well/i,
  /\bthis is a strong start\b/i, /\bwith some polish\b/i,
  /\bthe author shows promise\b/i, /\bcompelling start\b/i, /\bto be fair\b/i,
];
function validateAntiSycophancy(text) {
  const matched = [];
  for (const re of BANNED_PATTERNS) { const m = text.match(re); if (m) matched.push(m[0]); }
  return { passed: matched.length === 0, matched };
}

const STYLE_RULES = `
HOUSE STYLE:
- Never use em dashes (—). Use periods, commas, colons, or short sentences.
- Write in third-person observational voice. No "I think", "I believe", "in my opinion", "I feel".
- State problems and strengths directly. Do not cushion criticism with praise.
- Banned compensatory structures: "great job, but", "with some polish", "shows promise", "compelling start", "to be fair".
`.trim();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400 }; }
  const { review_id: reviewId, chapter_slot: slot } = body;
  if (!reviewId || typeof slot !== 'number') return { statusCode: 400 };

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    console.error('[hr-chapter] server not configured'); return { statusCode: 500 };
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    await runChapter(reviewId, slot, supabase, ANTHROPIC_KEY, event);
  } catch (err) {
    console.error(`[hr-chapter] ${reviewId}/${slot} uncaught`, err);
    // Mark this chapter slot as failed (but don't fail the whole review yet;
    // synthesis can decide what to do with partial chapter results)
    await markChapterStatus(supabase, reviewId, slot, 'failed', err.message || String(err));
  }
  return { statusCode: 202 };
};

async function runChapter(reviewId, slot, supabase, anthropicKey, event, opts = {}) {
  const startTime = Date.now();
  const { data: rev, error } = await supabase
    .from('honest_reviews').select('*').eq('id', reviewId).single();
  if (error || !rev) throw new Error('Could not load review');

  const evals = Array.isArray(rev.chapter_evaluations) ? rev.chapter_evaluations : [];
  const entry = evals[slot];
  if (!entry) throw new Error(`No chapter eval entry at slot ${slot}`);
  if (entry.status === 'complete') {
    console.log(`[hr-chapter] ${reviewId}/${slot} already complete, skipping`);
    return;
  }

  // Reload the chapter text from parsed_text. We need it because parsed_text
  // gets cleared post-completion for privacy, but during the eval phase it's
  // still on the row.
  const text = rev.parsed_text;
  if (!text) throw new Error('parsed_text missing; cannot evaluate chapter');
  const chapter = extractChapterByIndex(text, entry.chapter_index, entry.chapter_title);

  await markChapterStatus(supabase, reviewId, slot, 'running', null);
  console.log(`[hr-chapter] ${reviewId}/${slot} starting: "${entry.chapter_title}" (${entry.position})`);

  const client = new Anthropic({ apiKey: anthropicKey, timeout: 240000, maxRetries: 1 });

  const passes = [];
  let validatorRegens = 0;

  for (let p = 0; p < PASSES_PER_CHAPTER; p++) {
    let result = null;
    let lastViolation = null;
    for (let attempt = 0; attempt <= REGEN_BUDGET; attempt++) {
      const t0 = Date.now();
      console.log(`[hr-chapter] ${reviewId}/${slot} pass ${p+1}/${PASSES_PER_CHAPTER} attempt ${attempt+1} starting`);
      const evalRes = await runEvalPass({
        client, chapter, brief: rev.full_book_brief, review: rev,
        passNum: p, totalPasses: PASSES_PER_CHAPTER, attempt, lastViolation,
      });
      console.log(`[hr-chapter] ${reviewId}/${slot} pass ${p+1} attempt ${attempt+1} done in ${Date.now()-t0}ms, parsed=${!!evalRes.parsed}`);
      const v = validateAntiSycophancy(evalRes.rawText);
      if (v.passed && evalRes.parsed) { result = evalRes.parsed; break; }
      validatorRegens++;
      lastViolation = v.matched;
    }
    if (!result) throw new Error('Anti-sycophancy validator hard-failed on chapter ' + entry.chapter_title);
    passes.push(result);
  }

  // Resolve median per Test for this chapter
  const medianBands = {};
  for (const t of TESTS) {
    const ranks = passes.map((r) => r.bands?.[t])
      .filter(Boolean)
      .map((b) => BAND_ORDER.indexOf(b.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    medianBands[t] = ranks.length ? BAND_ORDER[ranks[Math.floor(ranks.length / 2)]] : 'developmental';
  }

  const elapsedMs = Date.now() - startTime;
  console.log(`[hr-chapter] ${reviewId}/${slot} complete in ${elapsedMs}ms, regens=${validatorRegens}`);

  // Write back: read-modify-write the chapter_evaluations array
  await updateChapterEval(supabase, reviewId, slot, {
    chapter_index: entry.chapter_index,
    chapter_title: entry.chapter_title,
    position: entry.position,
    status: 'complete',
    passes,
    median_bands: medianBands,
    validator_regens: validatorRegens,
    elapsed_ms: elapsedMs,
  });

  // ── Fan-in: if all 5 chapters are done, trigger synthesis ──────────────────
  const { data: refreshed } = await supabase
    .from('honest_reviews').select('chapter_evaluations, status').eq('id', reviewId).single();
  const all = (refreshed?.chapter_evaluations || []);
  const completedCount = all.filter((e) => e?.status === 'complete').length;
  console.log(`[hr-chapter] ${reviewId}/${slot}: ${completedCount}/${all.length} chapters complete`);

  if (completedCount === all.length && refreshed?.status === 'evaluating') {
    // Atomic-ish status flip; synthesis BG also re-checks
    const { data: lockRow } = await supabase
      .from('honest_reviews')
      .update({ status: 'synthesizing' })
      .eq('id', reviewId)
      .eq('status', 'evaluating')
      .select('id')
      .single();
    if (lockRow) {
      if (opts.skipSynthesisTrigger) {
        // Caller (eval-bg Demo path) will run synthesis inline — don't double-fire.
        console.log(`[hr-chapter] ${reviewId}/${slot}: synthesis trigger skipped (inline caller)`);
      } else {
        console.log(`[hr-chapter] ${reviewId}/${slot}: triggering synthesis BG`);
        const host  = event.headers.host || event.headers.Host;
        const proto = event.headers['x-forwarded-proto'] || 'https';
        const url = `${proto}://${host}/.netlify/functions/honest-review-synthesis-background`;
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ review_id: reviewId }),
          });
        } catch (err) { console.error('[hr-chapter] synthesis BG trigger failed:', err); }
      }
    }
  }
}

async function markChapterStatus(supabase, reviewId, slot, status, errMsg) {
  const { data: rev } = await supabase
    .from('honest_reviews').select('chapter_evaluations').eq('id', reviewId).single();
  const evals = Array.isArray(rev?.chapter_evaluations) ? [...rev.chapter_evaluations] : [];
  if (!evals[slot]) return;
  evals[slot] = { ...evals[slot], status, ...(errMsg ? { error_message: errMsg } : {}) };
  await supabase.from('honest_reviews').update({ chapter_evaluations: evals }).eq('id', reviewId);
}

async function updateChapterEval(supabase, reviewId, slot, payload) {
  const { data: rev } = await supabase
    .from('honest_reviews').select('chapter_evaluations').eq('id', reviewId).single();
  const evals = Array.isArray(rev?.chapter_evaluations) ? [...rev.chapter_evaluations] : [];
  evals[slot] = { ...(evals[slot] || {}), ...payload };
  await supabase.from('honest_reviews').update({ chapter_evaluations: evals }).eq('id', reviewId);
}

// Extract a chapter's text by index. The brief identified the indices; this
// reuses the same chapter-splitting heuristic to recover the slice.
function extractChapterByIndex(text, idx, expectedTitle) {
  const re = /^[\t ]*(?:CHAPTER|Chapter|chapter)\s+(?:[0-9]+|[IVXLCDM]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|TWENTY)[^\n]*\n/gm;
  const indices = [];
  let m;
  while ((m = re.exec(text)) !== null) indices.push({ start: m.index, title: m[0].trim().replace(/\s+/g, ' ') });

  if (indices.length === 0) {
    // Quintile slicing (matches splitChapters fallback in the brief BG)
    const n = text.length;
    const chunkSize = Math.floor(n / 5);
    const start = idx * chunkSize;
    const end = idx === 4 ? n : start + chunkSize;
    return { index: idx, title: expectedTitle || 'Sample', text: text.slice(start, end).trim() };
  }
  const safeIdx = Math.max(0, Math.min(indices.length - 1, idx));
  const start = indices[safeIdx].start;
  const end = safeIdx + 1 < indices.length ? indices[safeIdx + 1].start : text.length;
  return { index: safeIdx, title: indices[safeIdx].title, text: text.slice(start, end).trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Eval pass — single chapter against the 5 Tests, brief as context
// ─────────────────────────────────────────────────────────────────────────────
async function runEvalPass({ client, chapter, brief, review, passNum, totalPasses, attempt, lastViolation }) {
  const regenSteer = attempt > 0
    ? `\n\nYour previous output contained these compensatory-praise structures: ${JSON.stringify(lastViolation || [])}. Rewrite without any cushioning. State problems and strengths directly.`
    : '';

  const system = `You are the Greylander Press Honest Review engine, evaluating a PUBLISHED novel against the standard of currently publishable fiction in its genre. The standard is fixed. Reputation does not soften the grading.

You are evaluating a single sample chapter at depth. The full book has been read by an earlier brief pass; that brief is provided as context so your judgment is grounded in the whole work.

You are strictly prohibited from being polite, encouraging, or compensatory. State craft assessments directly.

${STYLE_RULES}

Evaluate across five Tests:
  1. SENSORY DEPTH       — concrete sensory rendering vs. abstract summary
  2. DIALOGUE VITALITY   — distinct voices, subtext, vs. on-the-nose / exposition
  3. PACING AND TENSION  — rhythm; stalling, compression, sprawl
  4. STRUCTURAL INTEGRITY — beats, escalation, scene-level accomplishment (use the brief to judge structural choices in the larger work)
  5. CHARACTER AGENCY    — characters drive vs. are dragged by plot

Each Test receives ONE band:
  - PROFESSIONAL    — meets the standard of currently publishable fiction
  - COMPETENT       — working command, identified weaknesses
  - DEVELOPMENTAL   — substantive problems
  - FOUNDATIONAL    — fundamental problems

OUTPUT FORMAT — single JSON object, no preamble, no markdown fences:
{
  "bands": {
    "sensory_depth":         "professional|competent|developmental|foundational",
    "dialogue_vitality":     "professional|competent|developmental|foundational",
    "pacing_tension":        "professional|competent|developmental|foundational",
    "structural_integrity":  "professional|competent|developmental|foundational",
    "character_agency":      "professional|competent|developmental|foundational"
  },
  "findings_per_test": {
    "sensory_depth":         { "summary": "...", "holes": [{"ref": "near opening", "finding": "..."}] },
    "dialogue_vitality":     { "summary": "...", "holes": [...] },
    "pacing_tension":        { "summary": "...", "holes": [...] },
    "structural_integrity":  { "summary": "...", "holes": [...] },
    "character_agency":      { "summary": "...", "holes": [...] }
  },
  "pull_quote_candidate": "One sharp sentence that captures the verdict, suitable for a published review."
}

PASS: ${passNum + 1} of ${totalPasses} on this chapter. Independent evaluation; bands will be combined via median.${regenSteer}`;

  const user = `BOOK METADATA:
Title:     ${review.book_title}
Author:    ${review.book_author}
${review.book_publisher ? `Publisher: ${review.book_publisher}\n` : ''}${review.book_year ? `Year:      ${review.book_year}\n` : ''}
${brief ? `\nFULL-BOOK BRIEF (produced by an earlier read of the entire work):\n${JSON.stringify(brief, null, 2)}\n` : ''}
SAMPLE CHAPTER under evaluation: ${chapter.title}
---
${chapter.text}
---

Return the JSON object now.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0.6,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: user, cache_control: { type: 'ephemeral' } }] }],
  });

  const rawText = scrubHedges((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  let parsed = null;
  try {
    const m = rawText.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { /* parsed stays null */ }
  return { rawText, parsed };
}

// Exposed so honest-review-eval-background can run a chapter inline (Demo tier),
// avoiding the flaky BG-trigger fan-out hop that bit a Demo run on 2026-05-02.
module.exports.runChapter = runChapter;
