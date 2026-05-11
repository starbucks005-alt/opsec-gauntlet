const { createClient } = require('@supabase/supabase-js');

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

  const {
    title,
    author_name,
    genre,
    project_type,
    blurb,
    trim_size,
    word_count,
    isbn_requested,
    listing_type,
  } = body;

  if (!title || !listing_type) return json(400, { error: 'Missing required fields' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'Server not configured' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const { data, error } = await supabase
    .from('submissions')
    .insert({
      user_id: userId,
      title,
      author_name: author_name || null,
      genre: genre || null,
      project_type: project_type || null,
      blurb: blurb || null,
      trim_size: trim_size || null,
      word_count: word_count || null,
      isbn_requested: !!isbn_requested,
      listing_type,
      status: 'submitted',
      submitted_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) return json(500, { error: error.message });

  return json(200, { catalog_id: data.id });
};
