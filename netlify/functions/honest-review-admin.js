/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Honest Review ADMIN

   Owner-only moderation for published reviews. Two destructive actions:
     - unpublish: sets is_published=false, keeps the row (reversible)
     - republish: sets is_published=true (toggle back)
     - delete:    removes the row permanently
     - check:     returns { is_admin } so the UI can decide whether to render
                  the toolbar

   Admin status is gated by the ADMIN_USER_IDS env var (comma-separated UUIDs).
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ADMIN_IDS    = (process.env.ADMIN_USER_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;
  const isAdmin = ADMIN_IDS.includes(userId);

  const action = body.action;
  if (action === 'check') return json(200, { is_admin: isAdmin });

  const reviewId = body.review_id;
  if (!reviewId) return json(400, { error: 'Missing review_id' });

  // Resolve authorization: admin always allowed; owner allowed for their own review.
  let isOwner = false;
  if (!isAdmin) {
    const { data: rev } = await supabase
      .from('honest_reviews').select('user_id').eq('id', reviewId).single();
    if (!rev) return json(404, { error: 'Review not found' });
    isOwner = userId === rev.user_id;
    if (!isOwner) return json(403, { error: 'Not authorized' });
  }

  if (action === 'unpublish') {
    const { error } = await supabase
      .from('honest_reviews')
      .update({ is_published: false })
      .eq('id', reviewId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, action: 'unpublish' });
  }

  if (action === 'republish') {
    const { error } = await supabase
      .from('honest_reviews')
      .update({ is_published: true })
      .eq('id', reviewId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, action: 'republish' });
  }

  if (action === 'delete') {
    const { error } = await supabase
      .from('honest_reviews')
      .delete()
      .eq('id', reviewId);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, action: 'delete' });
  }

  return json(400, { error: 'Unknown action. Use check | unpublish | republish | delete.' });
};

function json(status, payload) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}
