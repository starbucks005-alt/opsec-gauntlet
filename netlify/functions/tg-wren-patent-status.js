/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-patent-status

   Polling endpoint for the Wren patent-analyze background function.
   Clients submit a job to tg-wren-patent-analyze-background with a
   uuid job_id and then poll this endpoint until status is no longer
   'pending'.

   POST body : { job_id: string (uuid) }
   GET query : ?job_id=<uuid>   (also supported for convenience)
   Response  : { job_id, status, result?, error?, created_at, completed_at }
   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }

  let job_id = '';
  if (event.httpMethod === 'GET') {
    job_id = String((event.queryStringParameters || {}).job_id || '').trim().toLowerCase();
  } else if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }
    job_id = String(body.job_id || '').trim().toLowerCase();
  } else {
    return json(405, { error: 'method not allowed' });
  }

  if (!UUID_RE.test(job_id)) return json(400, { error: 'job_id must be a valid uuid' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase
    .from('tg_wren_patent_jobs')
    .select('job_id, status, result, error, created_at, completed_at')
    .eq('job_id', job_id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return json(404, { error: 'job not found', job_id });
    console.error('[tg-wren-patent-status] select failed', error);
    return json(500, { error: 'lookup failed', detail: error.message });
  }
  return json(200, data);
};
