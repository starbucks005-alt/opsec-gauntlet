/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Claim Pending Gifts

   Called on every sign-in (and immediately after sign-up). Finds any
   pending_credit_balances rows matching the authenticated user's email,
   credits their gp_credits balance, marks the pending row 'claimed', and
   flips the originating gift_transactions row to 'credited'.

   POST /.netlify/functions/claim-pending-gifts-gp
   Authorization: Bearer <supabase-access-token>

   Returns:
     { claimed: [ { gift_id, credits_amount, sender_email, message } ],
       total_credits_added: number,
       new_balance: number }

   Idempotent — already-claimed gifts are skipped via status filter.
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: authErr } = await sb.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });

  const user  = userData.user;
  const email = (user.email || '').toLowerCase().trim();
  if (!email) return json(400, { error: 'User has no email' });

  // Find pending gifts for this email
  const { data: pending, error: pendErr } = await sb
    .from('pending_credit_balances')
    .select('id, credit_amount, gift_transaction_id, status, created_at')
    .eq('recipient_email', email)
    .eq('status', 'pending');

  if (pendErr) {
    console.error('[claim] pending_credit_balances select failed:', pendErr.message);
    return json(500, { error: 'Could not check for pending gifts' });
  }

  if (!pending || pending.length === 0) {
    // No pending — return current balance for the caller's convenience
    const { data: balRow } = await sb.from('gp_credits').select('balance').eq('user_id', user.id).maybeSingle();
    return json(200, { claimed: [], total_credits_added: 0, new_balance: balRow?.balance || 0 });
  }

  const totalToAdd = pending.reduce((s, p) => s + (p.credit_amount || 0), 0);

  // Increment gp_credits (insert if missing). Service-role bypasses RLS.
  const { data: balRow } = await sb.from('gp_credits').select('balance').eq('user_id', user.id).maybeSingle();
  const newBalance = (balRow?.balance || 0) + totalToAdd;
  if (balRow) {
    const { error: updErr } = await sb.from('gp_credits').update({ balance: newBalance }).eq('user_id', user.id);
    if (updErr) {
      console.error('[claim] gp_credits update failed:', updErr.message);
      return json(500, { error: 'Could not apply credits' });
    }
  } else {
    const { error: insErr } = await sb.from('gp_credits').insert({ user_id: user.id, balance: newBalance });
    if (insErr) {
      console.error('[claim] gp_credits insert failed:', insErr.message);
      return json(500, { error: 'Could not apply credits' });
    }
  }

  // Mark pending rows claimed
  const pendingIds = pending.map(p => p.id);
  const claimedAt  = new Date().toISOString();
  await sb
    .from('pending_credit_balances')
    .update({ status: 'claimed', claimed_at: claimedAt })
    .in('id', pendingIds);

  // Flip originating gift_transactions rows to 'credited'
  const giftIds = pending.map(p => p.gift_transaction_id).filter(Boolean);
  let claimedDetail = [];
  if (giftIds.length) {
    await sb
      .from('gift_transactions')
      .update({ status: 'credited', claimed_at: claimedAt })
      .in('id', giftIds);

    // Pull sender info for the response (best-effort, non-fatal)
    const { data: gifts } = await sb
      .from('gift_transactions')
      .select('id, credits_amount, message, giver_id')
      .in('id', giftIds);
    claimedDetail = (gifts || []).map(g => ({
      gift_id: g.id,
      credits_amount: g.credits_amount,
      message: g.message || '',
    }));
  }

  console.log(`[claim] ${user.email} claimed ${totalToAdd} credits across ${pending.length} gifts`);
  return json(200, {
    claimed: claimedDetail,
    total_credits_added: totalToAdd,
    new_balance: newBalance,
  });
};
