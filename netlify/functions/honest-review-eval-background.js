/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review · STAGE 1: Brief + Structural Identification

   Replaces the older single-BG-function design. Runtime for a Scan tier review
   exceeds Netlify's 15-min Background Function cap, so the eval is split into
   four chained stages:

     1. Brief BG (this file, kept under the legacy filename for routing)
        → reads the full book once, captures book-wide patterns AND identifies
          the 5 structurally-significant chapter indices (opening, Act 1
          midpoint, central pivot, Act 3 midpoint, closing). Then spawns 5
          parallel Chapter BG invocations.

     2. Chapter BG (honest-review-chapter-background)
        → runs 3 independent diagnostic passes on its assigned chapter. On
          completion, checks if all 5 chapters are done; if so, triggers
          Synthesis BG.

     3. Synthesis BG (honest-review-synthesis-background)
        → combines brief patterns + 5 chapters × 3 passes = 15 sample pass
          results. Resolves bands by per-chapter median, then aggregates across
          chapters. Writes final review. Triggers email if requested.

     4. Email BG (honest-review-email)
        → sends permalink to author via Resend (RESEND_API_KEY).

   This stage handles both kinds of inputs:
     - Scan tier: full book → produces brief + structural chapter list →
       fans out to chapter BGs
     - Demo tier: chapter 1 only → runs 3 passes inline, then synthesis →
       single chained call (demo doesn't need parallelism)

   Status flow on honest_reviews row:
     queued → briefing → evaluating → synthesizing → complete | failed
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const REGEN_BUDGET = 2;

// Hedge scrubbing + sycophancy patterns (same as Gauntlet)
const HEDGE_SCRUB_PATTERNS = [
  /\bI think\b\s*,?\s*/gi,
  /\bI believe\b\s*,?\s*/gi,
  /\bin my opinion\b\s*,?\s*/gi,
  /\bI feel(?:\s+that)?\b\s*/gi,
];

function scrubHedges(text) {
  let out = text;
  for (const re of HEDGE_SCRUB_PATTERNS) out = out.replace(re, '');
  return out.replace(/(^|[.!?]\s+)([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400 }; }
  const { review_id: reviewId } = body;
  if (!reviewId) return { statusCode: 400 };

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    console.error('[hr-brief] server not configured'); return { statusCode: 500 };
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    await runBrief(reviewId, supabase, ANTHROPIC_KEY, event);
  } catch (err) {
    console.error('[hr-brief] uncaught', err);
    await supabase.from('honest_reviews').update({
      status: 'failed', error_message: err.message || String(err), parsed_text: null,
    }).eq('id', reviewId).then(() => {}, () => {});
  }
  return { statusCode: 202 };
};

async function runBrief(reviewId, supabase, anthropicKey, event) {
  const startTime = Date.now();
  const { data: rev, error } = await supabase
    .from('honest_reviews').select('*').eq('id', reviewId).single();
  if (error || !rev) throw new Error('Could not load review');
  if (rev.status !== 'queued') {
    console.warn(`[hr-brief] ${reviewId} not in queued state (${rev.status}); aborting`);
    return;
  }
  const text = rev.parsed_text;
  if (!text) throw new Error('Review row missing parsed_text');

  await supabase.from('honest_reviews').update({ status: 'briefing' }).eq('id', reviewId);
  console.log(`[hr-brief] ${reviewId}: starting, tier=${rev.tier}, words=${text.split(/\s+/).length}`);

  const client = new Anthropic({ apiKey: anthropicKey, timeout: 240000, maxRetries: 1 });

  const chapters = splitChapters(text);
  console.log(`[hr-brief] ${reviewId}: detected ${chapters.length} chapters`);

  // ── Demo tier: 3 passes on the single chapter + synthesis, all inline ──────
  // Demo runs serially (one chapter, no parallelism needed) and fits comfortably
  // under Netlify's 15-min BG cap. Inlining avoids two flaky BG-trigger fetches
  // (chapter + synthesis) that would otherwise leave the row stuck at 'pending'
  // if Netlify's BG queue dropped the request.
  if (rev.tier === 'demo') {
    const ch = chapters[0] || { index: 0, title: 'Opening', text: text.slice(0, 12000) };
    await supabase.from('honest_reviews').update({
      sampled_chapter_indices: [{ index: ch.index, title: ch.title, position: 'demo' }],
      chapter_evaluations: [{ chapter_index: ch.index, chapter_title: ch.title, status: 'pending', passes: [] }],
      status: 'evaluating',
    }).eq('id', reviewId);
    const { runChapter } = require('./honest-review-chapter-background.js');
    await runChapter(reviewId, 0, supabase, anthropicKey, event, { skipSynthesisTrigger: true });
    // runChapter flipped the row to 'synthesizing'; run synthesis inline.
    const { runSynthesis } = require('./honest-review-synthesis-background.js');
    await runSynthesis(reviewId, supabase, anthropicKey, event);
    return;
  }

  // ── Scan tier: full-book brief + structural identification ──────────────────
  const brief = await runFullBookBriefPass({ client, text, review: rev, chapterCount: chapters.length });
  console.log(`[hr-brief] ${reviewId}: brief done in ${Date.now()-startTime}ms`);

  // Resolve the 5 structural chapter positions to actual chapter indices
  const sampled = resolveStructuralSamples(brief, chapters);
  console.log(`[hr-brief] ${reviewId}: sampled chapters: ${JSON.stringify(sampled.map((s) => ({ idx: s.index, title: s.title, position: s.position })))}`);

  // Persist brief + sample plan; init chapter_evaluations stubs
  const chapterEvalStubs = sampled.map((s) => ({
    chapter_index: s.index, chapter_title: s.title, position: s.position,
    status: 'pending', passes: [], median_bands: null,
  }));
  await supabase.from('honest_reviews').update({
    full_book_brief: brief,
    sampled_chapter_indices: sampled.map((s) => ({ index: s.index, title: s.title, position: s.position })),
    chapter_evaluations: chapterEvalStubs,
    status: 'evaluating',
  }).eq('id', reviewId);

  // ── Fan out: spawn 5 parallel Chapter BG invocations ────────────────────────
  for (let i = 0; i < sampled.length; i++) {
    triggerChapterBg(event, reviewId, i);
  }
  console.log(`[hr-brief] ${reviewId}: fanned out ${sampled.length} chapter BG invocations`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-book brief pass — descriptive + book-wide patterns + structural ID
// ─────────────────────────────────────────────────────────────────────────────
async function runFullBookBriefPass({ client, text, review, chapterCount }) {
  const system = `You are reading a published novel and producing a structured brief that downstream evaluators will use as context. You are NOT yet evaluating the Five Tests; the structural-sample passes will do that. Your job is twofold:

1. CAPTURE THE BOOK'S SHAPE: premise, structure, principal cast, central conflict, themes, tonal register, arc movement.

2. IDENTIFY THE 5 STRUCTURAL SAMPLE POSITIONS: from the chapter list, name the chapter index for each of these 5 positions. Use the BOOK'S STRUCTURE to identify them, not chapter count divided by N:

   - opening: chapter 1 (index 0).
   - act_one_midpoint: the chapter that sits at the structural center of Act 1. The author's first-act setup peaks here, before the inciting incident's full consequences land.
   - central_pivot: the chapter containing the midpoint reversal, act-two pivot, or whatever the book's structural turn is. The point where the protagonist's situation, understanding, or stakes change in a way the back half is built on.
   - act_three_midpoint: the chapter at the structural center of Act 3, between the second-act climax and the resolution. The chapter where the consequences of the central pivot are crystallizing.
   - closing: the final chapter (index ${chapterCount - 1}).

3. CAPTURE BOOK-WIDE PATTERNS that depth-evaluation of single chapters cannot catch: repetitive vocabulary across chapters, subplot drift, character consistency over the full arc, tonal inconsistency between sections, structural promises set up but not paid off. These feed the executive summary and the Red Ink List, NOT the Five Tests bands.

The book has ${chapterCount} chapters (indices 0 through ${chapterCount - 1}). If the book has fewer than 5 chapters, return as many of the 5 positions as you can map; if 5 positions cannot be mapped meaningfully (e.g., the book has 3 chapters), return what you can. The downstream pipeline will sample whatever positions you return.

${STYLE_RULES}

OUTPUT FORMAT — single JSON object, no preamble, no markdown fences:
{
  "premise":            "One-sentence what-this-book-is-about.",
  "structure":          "How the book is organized (chapters, POVs, timelines).",
  "principal_cast":     [{"name": "...", "role": "protagonist|antagonist|major_supporting", "arc_summary": "..."}],
  "central_conflict":   "What the book is actually about beneath the surface.",
  "thematic_concerns":  "What questions the book is interrogating.",
  "tonal_register":     "How the prose feels.",
  "arc_movement":       "Brief beat map: opening situation → midpoint shift → climax → ending.",
  "structural_samples": {
    "opening":            { "chapter_index": 0,                   "title": "...", "rationale": "..." },
    "act_one_midpoint":   { "chapter_index": null_or_int,         "title": "...", "rationale": "..." },
    "central_pivot":      { "chapter_index": null_or_int,         "title": "...", "rationale": "..." },
    "act_three_midpoint": { "chapter_index": null_or_int,         "title": "...", "rationale": "..." },
    "closing":            { "chapter_index": ${chapterCount - 1}, "title": "...", "rationale": "..." }
  },
  "book_wide_patterns": {
    "summary":               "Two to three sentences naming the cross-chapter patterns (positive AND negative) the depth passes would not catch.",
    "vocabulary_notes":      "...",
    "subplot_consistency":   "...",
    "character_consistency": "...",
    "tonal_consistency":     "...",
    "promise_payoff_notes":  "..."
  }
}

Do NOT produce verdicts on the Five Tests in this output. The Five Tests bands are produced by the depth passes on the sampled chapters.`;

  const user = `BOOK METADATA:
Title:     ${review.book_title}
Author:    ${review.book_author}
${review.book_publisher ? `Publisher: ${review.book_publisher}\n` : ''}${review.book_year ? `Year:      ${review.book_year}\n` : ''}
FULL BOOK (${chapterCount} chapters):
---
${text}
---

Return the JSON brief now.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 3000,
    temperature: 0.3,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: user, cache_control: { type: 'ephemeral' } }] }],
  });

  const rawText = scrubHedges((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const cleaned = rawText.replace(/^(?:```|""")(?:json)?\s*/i, '').replace(/(?:```|""")\s*$/i, '');
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch (e) {
    console.error('[hr-brief] JSON parse failed:', e.message);
  }
  return { premise: cleaned.slice(0, 600), structural_samples: {} };
}

// ─────────────────────────────────────────────────────────────────────────────
// Chapter splitting + structural sample resolution
// ─────────────────────────────────────────────────────────────────────────────
function splitChapters(text) {
  const re = /^[\t ]*(?:CHAPTER|Chapter|chapter)\s+(?:[0-9]+|[IVXLCDM]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|TWENTY)[^\n]*\n/gm;
  const indices = [];
  let m;
  while ((m = re.exec(text)) !== null) indices.push({ start: m.index, title: m[0].trim().replace(/\s+/g, ' ') });

  if (indices.length === 0) {
    // No chapter markers: split into 5 roughly equal slices so the brief still has positions to map
    const n = text.length;
    const chunkSize = Math.floor(n / 5);
    const chunks = [];
    for (let i = 0; i < 5; i++) {
      const start = i * chunkSize;
      const end = i === 4 ? n : start + chunkSize;
      chunks.push({ index: i, title: ['Opening Quintile','Second Quintile','Middle Quintile','Fourth Quintile','Closing Quintile'][i], text: text.slice(start, end).trim() });
    }
    return chunks;
  }

  return indices.map((entry, i) => {
    const start = entry.start;
    const end = i + 1 < indices.length ? indices[i + 1].start : text.length;
    return { index: i, title: entry.title, text: text.slice(start, end).trim() };
  });
}

function resolveStructuralSamples(brief, chapters) {
  const positions = ['opening', 'act_one_midpoint', 'central_pivot', 'act_three_midpoint', 'closing'];
  const samples = brief?.structural_samples || {};
  const out = [];
  const used = new Set();

  for (const pos of positions) {
    const entry = samples[pos];
    if (!entry || typeof entry.chapter_index !== 'number') continue;
    let idx = entry.chapter_index;
    if (idx < 0 || idx >= chapters.length) continue;

    // De-dup: if this index is already taken (e.g., short book), nudge to a free neighbour
    while (used.has(idx) && idx + 1 < chapters.length) idx++;
    while (used.has(idx) && idx > 0) idx--;
    if (used.has(idx)) continue;

    used.add(idx);
    const ch = chapters[idx];
    out.push({ index: idx, title: ch.title, position: pos, text: ch.text });
  }

  // Graceful degradation: if brief failed to identify positions, fall back to
  // structurally-spaced fixed positions across whatever chapters exist
  if (out.length < Math.min(5, chapters.length)) {
    const fallbackPositions = chapters.length >= 5
      ? [0, Math.floor(chapters.length / 4), Math.floor(chapters.length / 2), Math.floor((3 * chapters.length) / 4), chapters.length - 1]
      : Array.from({ length: chapters.length }, (_, i) => i);
    for (let i = 0; i < fallbackPositions.length; i++) {
      const idx = fallbackPositions[i];
      if (used.has(idx)) continue;
      const ch = chapters[idx];
      const pos = ['opening', 'act_one_midpoint', 'central_pivot', 'act_three_midpoint', 'closing'][i] || 'sample';
      out.push({ index: idx, title: ch.title, position: pos, text: ch.text });
      used.add(idx);
    }
  }

  // Sort by chapter index for natural ordering
  out.sort((a, b) => a.index - b.index);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Chapter BG (fire-and-forget, awaited so Netlify doesn't drop)
// ─────────────────────────────────────────────────────────────────────────────
async function triggerChapterBg(event, reviewId, chapterSlot) {
  const host  = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${host}/.netlify/functions/honest-review-chapter-background`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_id: reviewId, chapter_slot: chapterSlot }),
    });
  } catch (err) {
    console.error('[hr-brief] chapter BG trigger failed:', err);
  }
}

module.exports.scrubHedges = scrubHedges;
module.exports.validateAntiSycophancy = validateAntiSycophancy;
module.exports.STYLE_RULES = STYLE_RULES;
