/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Site Review approve/reject action

   GET ?id=<uuid>&action=approve|reject&token=<hmac>

   Verifies HMAC, flips status, returns a small HTML confirmation page.
   ───────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return html(405, page('Method not allowed.', 'error'));

  const { id, action, token } = event.queryStringParameters || {};
  if (!id || !action || !token) return html(400, page('Missing parameters.', 'error'));
  if (action !== 'approve' && action !== 'reject') return html(400, page('Invalid action.', 'error'));

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const APPROVAL_SECRET = process.env.SITE_REVIEW_APPROVAL_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !APPROVAL_SECRET) {
    return html(500, page('Server not configured.', 'error'));
  }

  const expected = crypto.createHmac('sha256', APPROVAL_SECRET).update(`${id}.${action}`).digest('hex');
  if (!timingSafeEqualHex(token, expected)) {
    return html(403, page('Invalid or expired link.', 'error'));
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: row, error: fetchErr } = await supabase
    .from('site_reviews')
    .select('id, status, reviewer_name, title')
    .eq('id', id)
    .single();
  if (fetchErr || !row) return html(404, page('Review not found.', 'error'));

  if (row.status === 'approved' || row.status === 'rejected') {
    return html(200, page(`Already ${row.status}. No change.`, 'info', row));
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const update = { status: newStatus };
  if (newStatus === 'approved') update.approved_at = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('site_reviews')
    .update(update)
    .eq('id', id);
  if (updErr) return html(500, page('Could not update review.', 'error'));

  const verb = newStatus === 'approved' ? 'Approved &amp; published' : 'Rejected';
  return html(200, page(`${verb}.`, newStatus === 'approved' ? 'success' : 'info', row));
};

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch { return false; }
}

function html(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body,
  };
}

function page(message, kind, row) {
  const color = kind === 'success' ? '#5a8c3a' : kind === 'error' ? '#c0392b' : '#b8922a';
  const sub = row ? `<p style="color:#888;font-size:0.9em;margin-top:0.5em;">${escapeHtml(row.title || '')} — ${escapeHtml(row.reviewer_name || '')}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Site Review · ${kind}</title>
<style>
  body{font-family:Georgia,serif;background:#0e0b08;color:#e8dece;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:2rem;}
  .card{max-width:520px;border:1px solid rgba(184,146,42,0.3);background:rgba(184,146,42,0.04);padding:2.5rem 2rem;text-align:center;}
  .badge{display:inline-block;border:1px solid ${color};color:${color};padding:0.4em 1em;font-family:'DM Mono',monospace,monospace;font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;margin-bottom:1.5em;}
  h1{font-family:Georgia,serif;color:#f4ede0;font-size:1.6rem;margin:0 0 0.5em;}
  a{color:#d4aa4a;}
</style></head>
<body><div class="card">
  <div class="badge">${kind}</div>
  <h1>${message}</h1>
  ${sub}
  <p style="margin-top:2em;"><a href="/site-reviews.html">Back to Site Reviews →</a></p>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
