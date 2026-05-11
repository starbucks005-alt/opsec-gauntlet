const { createClient } = require('@supabase/supabase-js');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('is_admin')
    .eq('id', userId)
    .single();
  if (profErr || !profile?.is_admin) return json(403, { error: 'Admin access required' });

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('submissions')
      .select('*')
      .order('submitted_at', { ascending: false });
    if (error) return json(500, { error: error.message });
    return json(200, { submissions: data || [] });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Invalid JSON' }); }

    const { action } = body;

    if (action === 'update_status') {
      const { id, status } = body;
      const allowed = ['submitted', 'under_review', 'published', 'rejected'];
      if (!id || !allowed.includes(status)) return json(400, { error: 'Bad request' });
      const { error } = await supabase
        .from('submissions')
        .update({ status })
        .eq('id', id);
      if (error) return json(500, { error: error.message });
      return json(200, { ok: true });
    }

    if (action === 'gift_access') {
      const { email, credits } = body;
      const grant = parseInt(credits) || 0;
      if (!email) return json(400, { error: 'Email required' });

      const { data: existing } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();

      let targetId = existing?.id || null;
      let createdNew = false;

      if (!targetId) {
        const { data: invited, error: inviteErr } =
          await supabase.auth.admin.inviteUserByEmail(email);
        if (inviteErr) return json(500, { error: inviteErr.message });
        targetId = invited?.user?.id;
        createdNew = true;
      }
      if (!targetId) return json(500, { error: 'Could not resolve user' });

      const { data: row } = await supabase
        .from('gp_credits')
        .select('balance')
        .eq('user_id', targetId)
        .maybeSingle();

      if (row) {
        await supabase
          .from('gp_credits')
          .update({ balance: (row.balance || 0) + grant })
          .eq('user_id', targetId);
      } else {
        await supabase
          .from('gp_credits')
          .insert({ user_id: targetId, balance: grant });
      }

      const message = createdNew
        ? `Invited ${email} and granted ${grant} credits`
        : `Granted ${grant} credits to ${email}`;
      return json(200, { message });
    }

    return json(400, { error: 'Unknown action' });
  }

  return json(405, { error: 'Method not allowed' });
};
