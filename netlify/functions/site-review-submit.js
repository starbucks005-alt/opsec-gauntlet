/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Site Review submission

   Receives the public submission form, writes a pending row, sends Terry an
   email with signed approve/reject links via Resend.

   Env required:
     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
     RESEND_API_KEY                 (already set; reused from honest-review-email)
     SITE_REVIEW_APPROVAL_SECRET    (new — any 32+ char random string for HMAC)
   Optional:
     SITE_REVIEW_NOTIFY_TO          (default: starbucks005@gmail.com — Resend sandbox owner;
                                     once greylanderpress.com is verified in Resend, set this
                                     env var to greylanderpress@gmail.com)
     RESEND_FROM                    (default: onboarding@resend.dev sandbox)
   ───────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const VALID_TOOLS = new Set([
  'General Usability',
  'Tool Accuracy',
  'Author Playground',
  'Onboarding',
]);

const FROM_ADDRESS = process.env.RESEND_FROM || 'Greylander Press <onboarding@resend.dev>';
const NOTIFY_TO = process.env.SITE_REVIEW_NOTIFY_TO || 'starbucks005@gmail.com';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  // Honeypot — bots fill hidden fields. Real users don't.
  if (body.website && body.website.length > 0) {
    return json(200, { ok: true });  // pretend it succeeded
  }

  const reviewer_name = (body.reviewer_name || '').trim();
  const rating = parseInt(body.rating, 10);
  const title = (body.title || '').trim();
  const tool = (body.tool || '').trim();
  const comment = (body.comment || '').trim();

  if (!reviewer_name || reviewer_name.length > 80)   return json(400, { error: 'Name is required (max 80 chars).' });
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return json(400, { error: 'Rating must be 1–5.' });
  if (!title || title.length > 120)                  return json(400, { error: 'Title is required (max 120 chars).' });
  if (!tool || !VALID_TOOLS.has(tool))               return json(400, { error: 'Pick a valid Tool/Experience.' });
  if (!comment || comment.length > 4000)             return json(400, { error: 'Comment is required (max 4000 chars).' });

  const SUPABASE_URL  = process.env.SUPABASE_URL;
  const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY    = process.env.RESEND_API_KEY;
  const APPROVAL_SECRET = process.env.SITE_REVIEW_APPROVAL_SECRET;
  if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_KEY || !APPROVAL_SECRET) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Light abuse signal: hash the IP. We don't store the raw IP.
  const ipRaw = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || event.headers['client-ip'] || '';
  const ip_hash = ipRaw ? crypto.createHash('sha256').update(ipRaw).digest('hex').slice(0, 16) : null;

  const { data: row, error: insErr } = await supabase
    .from('site_reviews')
    .insert({ reviewer_name, rating, title, tool, comment, ip_hash, status: 'pending' })
    .select('id, created_at')
    .single();
  if (insErr) {
    console.error('[site-review-submit] insert failed:', insErr);
    return json(500, { error: 'Could not save review' });
  }

  // Build signed approve/reject links
  const host = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${host}/.netlify/functions/site-review-action`;

  const approveUrl = `${base}?id=${row.id}&action=approve&token=${signToken(row.id, 'approve', APPROVAL_SECRET)}`;
  const rejectUrl  = `${base}?id=${row.id}&action=reject&token=${signToken(row.id, 'reject', APPROVAL_SECRET)}`;

  const subject = `New site review (${rating}★) from ${reviewer_name}`;
  const html = `
<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
  <h2 style="font-family:Georgia,serif;color:#13100c;border-bottom:1px solid #b8922a;padding-bottom:0.4em;">New Site Review · pending</h2>
  <p style="color:#555;">Submitted ${new Date(row.created_at).toUTCString()}</p>
  <table style="border-collapse:collapse;width:100%;margin:1em 0;">
    <tr><td style="padding:0.4em 0;color:#777;width:30%;">Name</td><td style="padding:0.4em 0;">${escapeHtml(reviewer_name)}</td></tr>
    <tr><td style="padding:0.4em 0;color:#777;">Rating</td><td style="padding:0.4em 0;">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)</td></tr>
    <tr><td style="padding:0.4em 0;color:#777;">Title</td><td style="padding:0.4em 0;"><strong>${escapeHtml(title)}</strong></td></tr>
    <tr><td style="padding:0.4em 0;color:#777;">Tool / Experience</td><td style="padding:0.4em 0;">${escapeHtml(tool)}</td></tr>
  </table>
  <div style="border-left:3px solid #b8922a;background:#faf6ec;padding:1em 1.2em;font-style:italic;color:#333;white-space:pre-wrap;">${escapeHtml(comment)}</div>
  <div style="margin:2em 0;padding:1em 0;border-top:1px solid #ddd;border-bottom:1px solid #ddd;text-align:center;">
    <a href="${approveUrl}" style="display:inline-block;background:#5a8c3a;color:#fff;padding:0.7em 1.5em;text-decoration:none;font-weight:bold;margin-right:0.5em;">✓ Approve &amp; Publish</a>
    <a href="${rejectUrl}" style="display:inline-block;background:#c0392b;color:#fff;padding:0.7em 1.5em;text-decoration:none;font-weight:bold;">✕ Reject</a>
  </div>
  <p style="color:#888;font-size:0.85em;">These links expire only when used. If you do nothing, the review stays pending.</p>
</div>
  `.trim();

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [NOTIFY_TO],
        reply_to: 'greylanderpress@gmail.com',
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[site-review-submit] Resend error:', r.status, t);
      // Submission is saved; surfacing email failure to the user isn't useful.
    }
  } catch (e) {
    console.error('[site-review-submit] Resend fetch failed:', e);
  }

  return json(200, { ok: true });
};

function signToken(reviewId, action, secret) {
  const payload = `${reviewId}.${action}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}
