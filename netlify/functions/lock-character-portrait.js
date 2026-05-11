// netlify/functions/lock-character-portrait.js
// Toggle the `locked` flag on a portrait. Only one locked portrait per character
// (enforced by partial unique index in the migration). When user locks portrait B,
// portrait A on the same character is auto-unlocked first.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Authentication required' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json(401, { error: 'Invalid session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { portrait_id, locked } = body;
  if (!portrait_id) return json(400, { error: 'portrait_id is required' });
  const wantLocked = !!locked;

  // Fetch portrait + verify ownership (RLS would also block but explicit check gives a cleaner error)
  const { data: portrait, error: pErr } = await supabase
    .from('character_portraits')
    .select('id, character_id, user_id, locked')
    .eq('id', portrait_id)
    .eq('user_id', user.id)
    .single();
  if (pErr || !portrait) return json(404, { error: 'Portrait not found' });

  if (wantLocked) {
    // Unlock any other locked portrait on this character first
    await supabase
      .from('character_portraits')
      .update({ locked: false })
      .eq('character_id', portrait.character_id)
      .eq('locked', true)
      .neq('id', portrait.id);
  }

  const { data: updated, error: updErr } = await supabase
    .from('character_portraits')
    .update({ locked: wantLocked })
    .eq('id', portrait.id)
    .select()
    .single();
  if (updErr) return json(500, { error: 'Could not update portrait: ' + updErr.message });

  return json(200, { portrait: updated });
};
