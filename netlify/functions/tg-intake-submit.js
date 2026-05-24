/* ─────────────────────────────────────────────────────────────────────────────
   tg-intake-submit — Submit an idea to The Gauntlet.

   Slice 1: anonymous submissions. The user_id is a client-generated anon
   uuid stored in the browser's localStorage; same browser = same anon user
   across submissions, and a future signup can claim/migrate them. Writes
   bypass RLS using the service role key.

   POST body : {
     user_id:     string (uuid, required)        - anon id from client localStorage
     title:       string (required, <=180 chars)
     description: string (required, <=12000 chars)
     goal_audience?: string (optional, <=500 chars)
     constraints?:   string (optional, <=2000 chars)
   }
   Response : { id: string }   - the new submission's uuid
   Env vars : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

const TITLE_CAP       = 180;
const DESCRIPTION_CAP = 12000;
const AUDIENCE_CAP    = 500;
const CONSTRAINTS_CAP = 2000;
const UUID_RE         = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const user_id     = String(body.user_id     || '').trim();
  const title       = String(body.title       || '').trim().slice(0, TITLE_CAP);
  const description = String(body.description || '').trim().slice(0, DESCRIPTION_CAP);
  const goal_audience = body.goal_audience ? String(body.goal_audience).trim().slice(0, AUDIENCE_CAP)    : null;
  const constraints   = body.constraints   ? String(body.constraints).trim().slice(0, CONSTRAINTS_CAP)   : null;

  if (!UUID_RE.test(user_id)) {
    return json(400, { error: 'user_id must be a valid uuid (client-generated)' });
  }
  if (!title)       return json(400, { error: 'title required' });
  if (!description) return json(400, { error: 'description required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'server not configured (supabase env vars missing)' });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const row = {
    user_id,
    type: 'idea',
    title,
    description,
    status: 'submitted',
    ...(goal_audience ? { goal_audience } : {}),
    ...(constraints   ? { constraints }   : {}),
  };

  const { data, error } = await supabase
    .from('tg_submissions')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error('[tg-intake-submit] insert failed', error);
    return json(500, { error: 'submission failed', detail: error.message });
  }

  return json(200, { id: data.id });
};
