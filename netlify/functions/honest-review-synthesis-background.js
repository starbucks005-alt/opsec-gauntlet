/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review · STAGE 3: Synthesis

   Triggered when the last Chapter BG finishes and successfully flips the row
   status to 'synthesizing'. Inputs:
     - full_book_brief (descriptive + book-wide patterns from Stage 1)
     - chapter_evaluations[] (5 chapters × 3 passes each, with median bands)

   This stage:
     1. Aggregates per-Test bands across the 5 chapter medians (median of medians).
     2. Computes the Honesty Score from those aggregate bands.
     3. Generates the published-review prose: executive summary that draws on
        BOTH book-wide brief patterns AND per-chapter findings, plus a pull
        quote, plus per-Test summary text.
     4. Writes everything to the review row, marks status='complete', deducts
        credits, clears parsed_text.
     5. If notify_choice='email', triggers Stage 4 (email BG).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
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
  const { review_id: reviewId } = body;
  if (!reviewId) return { statusCode: 400 };

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    console.error('[hr-synth] server not configured'); return { statusCode: 500 };
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    await runSynthesis(reviewId, supabase, ANTHROPIC_KEY, event);
  } catch (err) {
    console.error('[hr-synth] uncaught', err);
    await supabase.from('honest_reviews').update({
      status: 'failed', error_message: err.message || String(err), parsed_text: null,
    }).eq('id', reviewId).then(() => {}, () => {});
  }
  return { statusCode: 202 };
};

async function runSynthesis(reviewId, supabase, anthropicKey, event) {
  const startTime = Date.now();
  const { data: rev, error } = await supabase
    .from('honest_reviews').select('*').eq('id', reviewId).single();
  if (error || !rev) throw new Error('Could not load review');
  if (rev.status === 'complete') {
    console.log(`[hr-synth] ${reviewId} already complete; idempotent exit`);
    return;
  }
  if (rev.status !== 'synthesizing') {
    console.warn(`[hr-synth] ${reviewId} status=${rev.status}, expected 'synthesizing'; aborting`);
    return;
  }

  const brief = rev.full_book_brief || {};
  const evals = Array.isArray(rev.chapter_evaluations) ? rev.chapter_evaluations : [];
  const completed = evals.filter((e) => e?.status === 'complete' && e?.median_bands);
  if (completed.length === 0) throw new Error('No completed chapter evaluations');

  console.log(`[hr-synth] ${reviewId}: synthesizing from ${completed.length} chapters + brief`);

  // ── Aggregate bands across chapters: median of per-chapter medians ──────────
  const aggregateBands = {};
  for (const t of TESTS) {
    const ranks = completed
      .map((c) => c.median_bands?.[t])
      .filter(Boolean)
      .map((b) => BAND_ORDER.indexOf(b.toLowerCase()))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b);
    aggregateBands[t] = ranks.length ? BAND_ORDER[ranks[Math.floor(ranks.length / 2)]] : 'developmental';
  }
  const honestyScore = computeHonestyScore(aggregateBands);

  // ── Synthesis pass: build the published review ─────────────────────────────
  const client = new Anthropic({ apiKey: anthropicKey, timeout: 240000, maxRetries: 1 });

  const synthesis = await runSynthesisPass({
    client, review: rev, brief, completed, aggregateBands, honestyScore,
  });
  console.log(`[hr-synth] ${reviewId}: synthesis pass done in ${Date.now()-startTime}ms`);

  const elapsedMs = (Number(rev.elapsed_runtime_ms) || 0) + (Date.now() - startTime);
  const cost = rev.tier === 'scan' ? 100 : 25;

  await supabase.from('honest_reviews').update({
    status: 'complete',
    honesty_score: honestyScore,
    test_bands: aggregateBands,
    test_findings: synthesis.test_findings || {},
    executive_summary: synthesis.executive_summary || '',
    pull_quote: synthesis.pull_quote || '',
    headline: synthesis.headline || null,
    credits_charged: cost,
    elapsed_runtime_ms: elapsedMs,
    parsed_text: null,  // privacy: clear after eval
  }).eq('id', reviewId);

  // Deduct credits
  const { data: balRow } = await supabase
    .from('gp_credits').select('balance').eq('user_id', rev.user_id).single();
  const currentBalance = balRow?.balance ?? 0;
  await supabase.from('gp_credits').update({
    balance: Math.max(0, currentBalance - cost),
  }).eq('user_id', rev.user_id);

  // ── Trigger email if requested ─────────────────────────────────────────────
  if (rev.notify_choice === 'email' && rev.notify_email) {
    const host  = event.headers.host || event.headers.Host;
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const url = `${proto}://${host}/.netlify/functions/honest-review-email`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_id: reviewId }),
      });
    } catch (err) { console.error('[hr-synth] email BG trigger failed:', err); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Synthesis prompt — combines book-wide brief patterns + per-chapter findings
// ─────────────────────────────────────────────────────────────────────────────
async function runSynthesisPass({ client, review, brief, completed, aggregateBands, honestyScore }) {
  const system = `You are writing the published review. The 5 Tests have been resolved across 15 independent diagnostic passes (5 sampled chapters × 3 passes each). The aggregate bands are below. Your job is the prose: an executive summary readers will trust, per-Test findings, and one pull-quote-worthy sentence.

This review will be PUBLISHED on greylanderpress.com/reviews. It is the public face of the engine. The credibility of GP rides on every line. Do not soften the verdict. Do not flatter. Do not apologize.

THE EVIDENCE BASE you are writing from:
  - book-wide patterns from a full-book brief read (cross-chapter vocabulary, subplot drift, character consistency, tonal consistency, promise/payoff)
  - per-chapter depth findings from 3 diagnostic passes on each of 5 structurally-sampled chapters (opening, Act 1 midpoint, central pivot, Act 3 midpoint, closing)

Use both. Book-wide patterns ground claims about the work as a whole; per-chapter findings ground claims about specific craft execution. Be explicit about which kind of claim you are making.

${STYLE_RULES}

OUTPUT FORMAT — single JSON object, no preamble, no markdown fences:
{
  "headline": "A creative editorial review title in the voice of a working book critic. 5 to 12 words. Captures the book's core argument, conceit, or tension. NOT 'A Review of X' (that's the subhead). Examples: 'Unpacking the Algorithmic Future', 'The Last Honest Detective Novel of the Decade', 'A Slow Burn That Never Ignites'. The headline should be honest to the bands — if the verdict is foundational/developmental, the headline can be skeptical or critical; if professional, it can be admiring without being sycophantic. No colon-subtitles, no clichés ('A Tour de Force', 'A Must-Read', etc.), no questions.",
  "executive_summary": "A published book review, 280-400 words. Written in the voice of a working book critic who has read the manuscript and writes for a serious literary publication. NOT a diagnostic readout. NOT a checklist. Pure prose, 4-6 paragraphs, no bullets, no section headers, no labeled parts. The review must move through this arc invisibly:\n\n1. OPENING (1 short paragraph). Place the book. Premise, voice, central situation, what kind of reader this announces itself to. Not a plot synopsis. A critical placement that tells the reader what they are picking up.\n\n2. STRENGTHS (1-2 paragraphs). Where the book lands. Specific, named. Reference actual characters, actual scenes, the prose register itself. Quote a brief phrase or line if it earns the reference. Strengths must be observed, not bestowed; if there are few, say so without padding.\n\n3. WHAT THE BOOK COULD PUSH FURTHER (1-2 paragraphs). Use editorial framings: 'would benefit from', 'could push further', 'underdelivers in', 'leaves on the table', 'stops short of'. These are soft framings paired with hard observations. Soft framing does not mean soft critique. Each must point at a specific element (a character whose interiority we never enter, a midpoint that arrives without weight, dialogue that turns subtext into spoken text).\n\n4. WHERE THE BOOK FALTERS (1-2 paragraphs). Use editorial framings: 'falters at', 'fails to land', 'collapses under', 'struggles to', 'never recovers from'. AVOID the blunt verb 'fails' standing alone — but do not soften the substance. Be specific. Name what doesn't work and why.\n\n5. CLOSING (1 short paragraph). What kind of reader this is for, or what the book ultimately is. One landing line that earns the verdict the bands carry. Not a recap.\n\nVOICE: a real critic with taste and a point of view. Sentences vary in length. The critic has read the book; she is not running a checklist. There can be wit, there can be a turn of phrase, there can be a metaphor — as long as the metaphor lands and earns its space. Personality without performance. Honest without robotic.\n\nDO NOT label these sections in the output. The arc must read as continuous prose. The reader should not see seams.",
  "test_findings": {
    "sensory_depth":         { "summary": "...", "holes": [...] },
    "dialogue_vitality":     { "summary": "...", "holes": [...] },
    "pacing_tension":        { "summary": "...", "holes": [...] },
    "structural_integrity":  { "summary": "...", "holes": [...] },
    "character_agency":      { "summary": "...", "holes": [...] }
  },
  "pull_quote": "One sentence that could anchor a blurb. Specific, cold, true to the bands. Not sycophantic. Could be drawn from the executive summary or composed fresh."
}`;

  // Compact the per-chapter pass findings into a structure the synthesis can ingest
  const chapterDigests = completed.map((c) => ({
    chapter_index: c.chapter_index,
    chapter_title: c.chapter_title,
    position: c.position,
    median_bands: c.median_bands,
    pass_findings: (c.passes || []).map((p) => ({
      bands: p.bands,
      findings_per_test: p.findings_per_test,
      pull_quote_candidate: p.pull_quote_candidate,
    })),
  }));

  const user = `BOOK:
Title:     ${review.book_title}
Author:    ${review.book_author}
${review.book_publisher ? `Publisher: ${review.book_publisher}\n` : ''}${review.book_year ? `Year:      ${review.book_year}\n` : ''}
AGGREGATE BANDS (median of 5 chapter medians, each from 3 passes):
${JSON.stringify(aggregateBands, null, 2)}

HONESTY SCORE: ${honestyScore}

FULL-BOOK BRIEF (descriptive + book-wide patterns):
${JSON.stringify(brief, null, 2)}

PER-CHAPTER DEPTH FINDINGS (5 chapters × 3 passes):
${JSON.stringify(chapterDigests, null, 2)}

Return the JSON object now.`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 5000,
    temperature: 0.4,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
  });

  const rawText = scrubHedges((resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
  const cleaned = rawText.replace(/^(?:```|""")(?:json)?\s*/i, '').replace(/(?:```|""")\s*$/i, '');
  let parsed = { headline: '', executive_summary: cleaned.slice(0, 600), test_findings: {}, pull_quote: '' };
  try {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (e) {
    console.error('[hr-synth] JSON parse failed:', e.message);
  }
  return parsed;
}

function computeHonestyScore(bands) {
  const ranks = TESTS.map((t) => BAND_ORDER.indexOf((bands[t] || 'developmental').toLowerCase()))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  return BAND_ORDER[ranks[Math.floor(ranks.length / 2)]];
}

// Exposed so honest-review-eval-background can run synthesis inline (Demo tier).
module.exports.runSynthesis = runSynthesis;
