/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review · STAGE 4: Email Notification

   Triggered by Stage 3 (synthesis) when notify_choice='email'. Sends a single
   transactional email via Resend with a permalink to the review.

   Setup required: set RESEND_API_KEY in Netlify env vars. Resend free tier is
   3K emails/month, sufficient for this use case.

   Idempotent: checks notify_sent_at before sending. If a duplicate trigger
   fires (e.g., synthesis BG retry), the second call is a no-op.
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

// Sender. Default to Resend's sandbox (works without domain verification).
// Override by setting RESEND_FROM in Netlify env once greylanderpress.com is
// verified in Resend, e.g. "Greylander Press <reviews@greylanderpress.com>".
const FROM_ADDRESS = process.env.RESEND_FROM || 'Greylander Press <onboarding@resend.dev>';
// Replies route to Terry's Gmail regardless of from-address.
const REPLY_TO = 'greylanderpress@gmail.com';
const SUBJECT_PREFIX = 'Your Honest Review is ready';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400 }; }
  const { review_id: reviewId } = body;
  if (!reviewId) return { statusCode: 400 };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_KEY   = process.env.RESEND_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[hr-email] supabase not configured'); return { statusCode: 500 };
  }
  if (!RESEND_KEY) {
    console.error('[hr-email] RESEND_API_KEY not set, skipping email');
    return { statusCode: 200, body: 'email skipped (no key)' };
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    await sendEmail(reviewId, supabase, RESEND_KEY, event);
  } catch (err) {
    console.error('[hr-email] uncaught', err);
  }
  return { statusCode: 202 };
};

async function sendEmail(reviewId, supabase, resendKey, event) {
  const { data: rev, error } = await supabase
    .from('honest_reviews').select('*').eq('id', reviewId).single();
  if (error || !rev) throw new Error('Could not load review');
  if (rev.notify_sent_at) {
    console.log(`[hr-email] ${reviewId}: already sent at ${rev.notify_sent_at}, skipping`);
    return;
  }
  if (!rev.notify_email) {
    console.warn(`[hr-email] ${reviewId}: no notify_email on row, skipping`);
    return;
  }

  const host  = event.headers.host || event.headers.Host;
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const permalink = `${proto}://${host}/honest-review.html?id=${reviewId}`;

  const honesty = (rev.honesty_score || 'developmental').toUpperCase();
  const subject = `${SUBJECT_PREFIX}: ${rev.book_title}`;

  const html = `<!DOCTYPE html>
<html><body style="font-family:Georgia,serif;max-width:600px;margin:2rem auto;color:#1a1a1a;line-height:1.6;">
<div style="border-bottom:2px solid #b8922a;padding-bottom:0.6rem;margin-bottom:1.4rem;">
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:18px;color:#b8922a;font-weight:bold;">Greylander Press · Honest Reviews</div>
</div>
<h1 style="font-family:'Playfair Display',Georgia,serif;font-size:24px;color:#1a1a1a;margin:0 0 0.5rem;">Your review is ready</h1>
<p style="color:#555;margin:0 0 1.5rem;font-size:14px;">${escapeHtml(rev.book_title)} — ${escapeHtml(rev.book_author)}</p>

<div style="border:2px solid #b8922a;padding:1.5rem;text-align:center;margin:1.5rem 0;">
  <div style="font-family:monospace;font-size:11px;letter-spacing:0.2em;color:#666;text-transform:uppercase;margin-bottom:0.6rem;">Honesty Score</div>
  <div style="font-family:'Playfair Display',Georgia,serif;font-size:32px;color:${bandColor(rev.honesty_score)};font-weight:bold;letter-spacing:0.05em;">${escapeHtml(honesty)}</div>
</div>

${rev.pull_quote ? `<blockquote style="font-style:italic;font-size:18px;color:#8a6e1f;border-left:3px solid #b8922a;padding:0.8rem 1.2rem;margin:1.5rem 0;">"${escapeHtml(rev.pull_quote)}"</blockquote>` : ''}

<p style="margin:1.5rem 0;">The full review, banded scores for all five Tests, executive summary, and methodology disclosure are available at the permalink below.</p>

<p style="text-align:center;margin:2rem 0;">
  <a href="${permalink}" style="display:inline-block;background:#b8922a;color:#fff;padding:0.85rem 1.6rem;text-decoration:none;font-weight:bold;letter-spacing:0.04em;">View Your Review</a>
</p>

${rev.tier === 'scan' ? `<div style="background:#f8f5ee;border:1px solid #ddd;padding:1rem 1.4rem;margin:1.5rem 0;font-size:14px;color:#444;">
  <strong style="color:#8a6e1f;">Publishing decision:</strong> If you want this review listed publicly on greylanderpress.com/reviews, open the permalink and click "Publish to Reviews". Once published, the review cannot be retracted. The honesty of these reviews is the brand's commitment to readers.
</div>` : ''}

<hr style="border:none;border-top:1px solid #ddd;margin:2rem 0;">
<p style="font-size:12px;color:#888;">Greylander Press · Honest Reviews are evaluated against the standard of currently publishable fiction. <a href="${permalink}" style="color:#8a6e1f;">${permalink}</a></p>
</body></html>`;

  const textFallback = `Your Honest Review of "${rev.book_title}" by ${rev.book_author} is ready.

Honesty Score: ${honesty}
${rev.pull_quote ? `\n"${rev.pull_quote}"\n` : ''}
View your review: ${permalink}

${rev.tier === 'scan' ? 'If you want this listed publicly on greylanderpress.com/reviews, open the permalink and click "Publish to Reviews". Once published, reviews cannot be retracted.\n' : ''}
Greylander Press · Honest Reviews`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [rev.notify_email],
      reply_to: REPLY_TO,
      subject,
      html,
      text: textFallback,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${errText.slice(0, 300)}`);
  }

  await supabase.from('honest_reviews').update({
    notify_sent_at: new Date().toISOString(),
  }).eq('id', reviewId);

  console.log(`[hr-email] ${reviewId}: sent to ${rev.notify_email}`);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

function bandColor(band) {
  switch ((band || '').toLowerCase()) {
    case 'professional':   return '#5a8c3a';
    case 'competent':      return '#8a6e1f';
    case 'developmental':  return '#b85a1f';
    case 'foundational':   return '#c0392b';
    default:               return '#8a6e1f';
  }
}
