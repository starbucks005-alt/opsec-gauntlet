/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review INIT (sync front door)

   Two tiers:
     - demo (25 cr): chapter-1 only, private to author. Quick taste of the engine.
     - scan (100 cr): full book. Public on greylanderpress.com/reviews/{slug}
       once the author opts to publish (irrevocable).

   Architecture (scan tier, cost-controlled):
     1. Full book read once → structured brief (plot, characters, themes, arc)
        passed to the eval passes as context.
     2. 3 evaluation passes, each on a DIFFERENT sample chapter (1 / middle /
        final). Anti-sycophancy validator on each output. Median band wins.
     3. Synthesis pass produces verdict, executive summary, pull quote.

   Demo tier skips full-book brief and runs a single eval pass on chapter 1.

   This file: sync auth, PDF parse, metadata validation, chapter sampling,
   credit check, row create, BG trigger. Heavy work in the BG function.
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const TIERS = {
  demo: { cost: 25,  word_cap: 35000,  needs_full_book: false },
  scan: { cost: 100, word_cap: 110000, needs_full_book: true  },
};
const MODEL = 'claude-sonnet-4-6';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { pdfBase64, filename, tier, metadata, notify_choice, notify_email } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });
  if (!tier || !TIERS[tier]) return json(400, { error: 'Invalid tier. Use "demo" or "scan".' });

  // Metadata validation — required for both tiers (the review is about a *book*)
  const meta = metadata || {};
  if (!meta.book_title?.trim() || !meta.book_author?.trim()) {
    return json(400, { error: 'Book title and author are required.' });
  }

  // Notification choice
  const notifyChoice = notify_choice === 'email' ? 'email' : 'wait';
  let notifyEmail = null;
  if (notifyChoice === 'email') {
    if (!notify_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notify_email)) {
      return json(400, { error: 'Valid notify_email required when notify_choice=email' });
    }
    notifyEmail = notify_email.trim().slice(0, 200);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Auth ───────────────────────────────────────────────────────────────────
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  // ── Parse PDF ──────────────────────────────────────────────────────────────
  let text, pageCount;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text = (parsed.text || '').trim();
    pageCount = parsed.numpages || 0;
  } catch (e) {
    return json(400, { error: 'PDF parse failed: ' + (e.message || String(e)) });
  }
  if (!text) return json(400, { error: 'PDF contained no extractable text' });

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const cfg = TIERS[tier];
  if (wordCount > cfg.word_cap) {
    return json(413, {
      error: 'Manuscript too large for this tier',
      word_count: wordCount,
      cap: cfg.word_cap,
      tier,
      message: `${tier === 'demo' ? 'Demo' : 'Scan'} tier supports up to ${cfg.word_cap.toLocaleString()} words. Yours is ${wordCount.toLocaleString()}.`,
    });
  }

  // ── Credit check ───────────────────────────────────────────────────────────
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits').select('balance').eq('user_id', userId).single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < cfg.cost) {
    return json(402, { error: 'Insufficient credits', needed: cfg.cost, have: balance });
  }

  // ── Insert row ─────────────────────────────────────────────────────────────
  const { data: runRow, error: runErr } = await supabase
    .from('honest_reviews')
    .insert({
      user_id: userId,
      tier,
      book_title:     meta.book_title.trim().slice(0, 300),
      book_author:    meta.book_author.trim().slice(0, 200),
      book_publisher: meta.book_publisher?.trim().slice(0, 200) || null,
      book_year:      Number.isFinite(parseInt(meta.book_year, 10)) ? parseInt(meta.book_year, 10) : null,
      book_isbn:      meta.book_isbn?.trim().slice(0, 32) || null,
      cover_image_url: meta.cover_image_url?.trim().slice(0, 500) || null,
      manuscript_filename: filename || 'book.pdf',
      manuscript_word_count: wordCount,
      manuscript_page_count: pageCount,
      model: MODEL,
      pass_count: tier === 'scan' ? 15 : 3,  // 5 chapters × 3 passes for scan, 3 passes for demo
      status: 'queued',
      parsed_text: text,
      notify_choice: notifyChoice,
      notify_email: notifyEmail,
    })
    .select('id')
    .single();
  if (runErr) return json(500, { error: 'Could not create review: ' + runErr.message });

  const runId = runRow.id;

  // ── Trigger background processor ───────────────────────────────────────────
  const host  = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const bgUrl = `${proto}://${host}/.netlify/functions/honest-review-eval-background`;

  try {
    await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ review_id: runId }),
    });
  } catch (err) {
    console.error('[honest-review-init] failed to trigger BG:', err);
    await supabase.from('honest_reviews').update({
      status: 'failed',
      error_message: 'Could not trigger background processor: ' + (err.message || String(err)),
      parsed_text: null,
    }).eq('id', runId);
    return json(500, { error: 'Could not start background processor' });
  }

  return json(202, { review_id: runId, tier, cost: cfg.cost, word_count: wordCount });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
