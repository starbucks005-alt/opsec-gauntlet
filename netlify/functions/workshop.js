/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Mid-Draft Workshop (front door)

   Three modes via the same endpoint:
     mode = 'parse'   Parse a manuscript PDF and return text + wordCount.
                      No credit cost. Auth token validated but no deduction.
     mode = 'assist'  Kick off an async assist run. Creates a workshop_jobs row,
                      fires workshop-assist-background, returns { job_id }.
                      Credits deducted by the BG job on completion.
     mode = 'status'  Poll an in-flight job. Returns { status, result?, error? }.
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

const ASSIST_COST = 3;
const TEXT_CAP = 500000;
const SECTION_CAP = 15000;

const ASSIST_MODES = ['enrich', 'dialogue', 'continue', 'diagnose', 'rebuild'];

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { mode } = body;
  if (mode !== 'parse' && mode !== 'assist' && mode !== 'status') {
    return json(400, { error: "mode must be 'parse', 'assist', or 'status'" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  if (mode === 'parse')  return await handleParse(body);
  if (mode === 'assist') return await handleAssistKickoff(body, supabase, userId, event);
  if (mode === 'status') return await handleStatus(body, supabase, userId);
};

// ─── Parse PDF ────────────────────────────────────────────────────────────────
async function handleParse(body) {
  const { pdfBase64 } = body;
  if (!pdfBase64) return json(400, { error: 'Missing pdfBase64' });

  let text;
  try {
    const buf = Buffer.from(pdfBase64, 'base64');
    const parsed = await pdfParse(buf);
    text = (parsed.text || '').trim();
  } catch (e) {
    return json(400, { error: 'PDF parse failed: ' + (e.message || String(e)) });
  }
  if (!text) return json(400, { error: 'PDF contained no extractable text' });

  const truncated = text.length > TEXT_CAP;
  const outText = truncated ? text.slice(0, TEXT_CAP) : text;
  const wordCount = outText.split(/\s+/).filter(Boolean).length;

  return json(200, { text: outText, wordCount, truncated });
}

// ─── Assist kickoff (async) ───────────────────────────────────────────────────
async function handleAssistKickoff(body, supabase, userId, event) {
  const { manuscriptText, workingSection, assistMode } = body;

  if (!manuscriptText || !workingSection || !assistMode) {
    return json(400, { error: 'Missing manuscriptText, workingSection, or assistMode' });
  }
  if (!ASSIST_MODES.includes(assistMode)) {
    return json(400, { error: `Unknown assistMode. Must be one of: ${ASSIST_MODES.join(', ')}` });
  }

  // Credit balance check (charge happens in BG on completion)
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < ASSIST_COST) {
    return json(402, { error: 'Insufficient credits', needed: ASSIST_COST, have: balance });
  }

  // Cap inputs at write-time so we don't store oversize blobs
  const ctxText = manuscriptText.length > TEXT_CAP
    ? manuscriptText.slice(0, TEXT_CAP)
    : manuscriptText;
  const sectionText = workingSection.length > SECTION_CAP
    ? workingSection.slice(0, SECTION_CAP)
    : workingSection;

  const { data: jobRow, error: jobErr } = await supabase
    .from('workshop_jobs')
    .insert({
      user_id: userId,
      assist_mode: assistMode,
      manuscript_text: ctxText,
      working_section: sectionText,
      status: 'queued',
    })
    .select('id')
    .single();
  if (jobErr) return json(500, { error: 'Could not create job: ' + jobErr.message });

  const jobId = jobRow.id;

  // Fire-and-forget BG trigger
  const host = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const bgUrl = `${proto}://${host}/.netlify/functions/workshop-assist-background`;

  try {
    await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
  } catch (err) {
    console.error('[workshop] BG trigger failed:', err);
    await supabase.from('workshop_jobs')
      .update({ status: 'failed', error_message: 'Could not trigger background processor', manuscript_text: null, working_section: null })
      .eq('id', jobId);
    return json(500, { error: 'Could not start background processor' });
  }

  return json(202, { job_id: jobId });
}

// ─── Status poll ──────────────────────────────────────────────────────────────
async function handleStatus(body, supabase, userId) {
  const { job_id } = body;
  if (!job_id) return json(400, { error: 'Missing job_id' });

  const { data: job, error } = await supabase
    .from('workshop_jobs')
    .select('id, user_id, status, assist_mode, result, error_message, credits_remaining, created_at, completed_at, stop_reason')
    .eq('id', job_id)
    .single();

  if (error || !job) return json(404, { error: 'Job not found' });
  if (job.user_id !== userId) return json(403, { error: 'Forbidden' });

  return json(200, {
    job_id: job.id,
    status: job.status,
    assist_mode: job.assist_mode,
    result: job.result,
    error: job.error_message,
    credits_remaining: job.credits_remaining,
    created_at: job.created_at,
    completed_at: job.completed_at,
    stop_reason: job.stop_reason,
  });
}
