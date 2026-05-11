// netlify/functions/story-world-cast-remove.js
// Removes a cast member from a Story World and cleans up its storage objects.
// POST body: { cast_id }
// Returns: { ok: true }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'story-worlds';

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

  const castId = body.cast_id;
  if (!castId) return json(400, { error: 'cast_id is required' });

  const { data: cast, error: getErr } = await supabase
    .from('story_world_cast')
    .select('id, source_storage_path, reference_storage_path')
    .eq('id', castId)
    .eq('user_id', user.id)
    .single();
  if (getErr || !cast) return json(404, { error: 'Cast member not found' });

  // Best-effort storage cleanup
  const paths = [cast.source_storage_path, cast.reference_storage_path].filter(Boolean);
  // De-dupe (in case fallback set both to the same path)
  const uniquePaths = Array.from(new Set(paths));
  if (uniquePaths.length) {
    try { await supabase.storage.from(BUCKET).remove(uniquePaths); } catch (_) {}
  }

  const { error: delErr } = await supabase
    .from('story_world_cast')
    .delete()
    .eq('id', castId);
  if (delErr) return json(500, { error: 'Could not remove cast member: ' + delErr.message });

  return json(200, { ok: true });
};
