/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Gauntlet INIT (sync front door for the diagnostic engine)

   This function exists because Netlify Background Functions are fire-and-forget
   (return 202 immediately, dropping the function's return value). The client
   needs a real run_id and synchronous auth/credit feedback.

   Flow:
     1. Authenticate (Supabase JWT)
     2. Parse PDF (server-side authoritative scope detection)
     3. Detect scope; reject oversize manuscripts (413 with chapter count)
     4. Check excerpt context for excerpts
     5. Credit balance check
     6. Create gauntlet_runs row with status='queued', store parsed_text
     7. Fire-and-forget POST to gauntlet-eval-background with run_id
     8. Return { run_id } to client

   The heavy work (multi-pass eval, validator, stagnation, synthesis) lives in
   gauntlet-eval-background.js and runs asynchronously up to 15 minutes.
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const SCOPE_CAP_WORDS = 110000;
// User-picked scope tiers. Each maps to a backend evaluation scope and a price.
//   - chapter:      single chapter, asks excerpt context, evaluated as full_chapter
//   - novella_20k:  short manuscript ≤ 20K words, evaluated as full_manuscript
//   - novella_50k:  medium manuscript ≤ 50K words, evaluated as full_manuscript
//   - manuscript:   full novel ≤ 110K words, evaluated as full_manuscript
const SCOPE_CONFIG = {
  chapter:     { cost: 25,  word_cap: 35000,  backend_scope: 'full_chapter',     needs_context: true  },
  novella_20k: { cost: 50,  word_cap: 22000,  backend_scope: 'full_manuscript', needs_context: false },
  novella_50k: { cost: 75,  word_cap: 55000,  backend_scope: 'full_manuscript', needs_context: false },
  manuscript:  { cost: 100, word_cap: 110000, backend_scope: 'full_manuscript', needs_context: false },
};
const MODEL = 'claude-sonnet-4-6';
const PASSES = 3;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { pdfBase64, filename, excerptContext, userScope } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });
  if (!userScope || !SCOPE_CONFIG[userScope]) {
    return json(400, { error: 'Missing or invalid scope. Choose: chapter, novella_20k, novella_50k, manuscript.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── Auth ───────────────────────────────────────────────────────────────────
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  // ── Parse PDF (authoritative) ──────────────────────────────────────────────
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
  const chapterCount = countChapters(text);

  // ── Validate user-picked scope against actual word count ──────────────────
  const cfg = SCOPE_CONFIG[userScope];
  if (wordCount > cfg.word_cap) {
    return json(413, {
      error: 'Selection mismatch',
      word_count: wordCount,
      selected_scope: userScope,
      selected_cap: cfg.word_cap,
      suggested_scope: suggestScope(wordCount),
      message: `You selected "${userScope}" (cap ${cfg.word_cap.toLocaleString()} words) but uploaded ${wordCount.toLocaleString()} words. Pick a larger tier.`,
    });
  }
  if (wordCount > SCOPE_CAP_WORDS) {
    return json(413, {
      error: 'Manuscript exceeds single-run scope',
      word_count: wordCount,
      cap: SCOPE_CAP_WORDS,
      chapters_detected: chapterCount,
      message: 'Maximum supported is 110,000 words. Run longer works as separate chapter diagnostics.',
    });
  }

  if (cfg.needs_context) {
    if (!excerptContext || !excerptContext.position) {
      return json(400, { error: 'Context required for chapter scope (position, protagonist, prior_scene)' });
    }
  }

  const scope = cfg.backend_scope;  // full_chapter | full_manuscript
  const cost = cfg.cost;

  // ── Credit check ───────────────────────────────────────────────────────────
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < cost) {
    return json(402, { error: 'Insufficient credits', needed: cost, have: balance });
  }

  // ── Create run row ─────────────────────────────────────────────────────────
  const { data: runRow, error: runErr } = await supabase
    .from('gauntlet_runs')
    .insert({
      user_id: userId,
      manuscript_filename: filename || 'manuscript.pdf',
      manuscript_word_count: wordCount,
      manuscript_page_count: pageCount,
      scope,
      user_scope: userScope,
      excerpt_context: cfg.needs_context ? excerptContext : null,
      model: MODEL,
      pass_count: PASSES,
      status: 'queued',
      parsed_text: text,
    })
    .select('id')
    .single();
  if (runErr) return json(500, { error: 'Could not create run: ' + runErr.message });

  const runId = runRow.id;

  // ── Trigger background processor (fire-and-forget) ────────────────────────
  // Construct the function URL from the request host, so this works on every
  // preview deploy + on prod automatically.
  const host = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const bgUrl = `${proto}://${host}/.netlify/functions/gauntlet-eval-background`;

  // Await the trigger fetch. The BG endpoint returns 202 in milliseconds (Netlify
  // intercepts and queues the work), so awaiting is fast. Without await, the
  // promise dies when the serverless handler returns and the BG never fires.
  try {
    await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId }),
    });
  } catch (err) {
    console.error('[gauntlet-init] failed to trigger BG:', err);
    await supabase.from('gauntlet_runs').update({
      status: 'failed',
      error_message: 'Could not trigger background processor: ' + (err.message || String(err)),
      parsed_text: null,
    }).eq('id', runId);
    return json(500, { error: 'Could not start background processor' });
  }

  return json(202, { run_id: runId, scope, cost, word_count: wordCount });
};

function detectScope(chapterCount, wordCount) {
  if (chapterCount >= 5 || wordCount >= 35000) return 'full_manuscript';
  if (chapterCount >= 1 && wordCount >= 1500) return 'full_chapter';
  return 'excerpt';
}

// Recommend a tier for a given word count. Used in 413 responses.
function suggestScope(wordCount) {
  if (wordCount <= 22000) return 'novella_20k';
  if (wordCount <= 55000) return 'novella_50k';
  if (wordCount <= 110000) return 'manuscript';
  return null;
}

function countChapters(text) {
  const matches = text.match(/^\s*(?:CHAPTER|Chapter)\s+(?:[0-9]+|[IVXLCDM]+|ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|FIFTEEN|TWENTY)/gm);
  return matches ? matches.length : 0;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
