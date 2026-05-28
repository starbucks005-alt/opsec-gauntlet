/* ─────────────────────────────────────────────────────────────────────────────
   tg-consult-request - Intake for Standalone Consult requests.

   Cold buyers land on an EP consult page (e.g., /wren.html), fill out
   the short intake form, and submit. This function validates the
   payload and writes a row to tg_consult_requests. Terry reviews the
   table and responds manually until Stripe is wired.

   POST body : {
     ep:           string (required) - which EP, e.g. "wren"
     name:         string (required, <=120 chars)
     email:        string (required, <=200 chars, validated)
     organization: string (optional, <=160 chars)
     phone:        string (optional, <=40 chars)
     summary:      string (required, 30..3000 chars)
   }
   Response : { id: string, status: "new" }
   Env vars : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_EPS = new Set([
  'wren', 'reid', 'arjun', 'matthew', 'carol', 'ivy', 'grant', 'zara', 'jules',
]);

const NAME_CAP    = 120;
const EMAIL_CAP   = 200;
const ORG_CAP     = 160;
const PHONE_CAP   = 40;
const SUMMARY_CAP = 3000;
const SUMMARY_MIN = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

  const ep           = String(body.ep || '').trim().toLowerCase();
  const name         = String(body.name || '').trim().slice(0, NAME_CAP);
  const email        = String(body.email || '').trim().slice(0, EMAIL_CAP);
  const organization = body.organization ? String(body.organization).trim().slice(0, ORG_CAP) : null;
  const phone        = body.phone        ? String(body.phone).trim().slice(0, PHONE_CAP)      : null;
  const summary      = String(body.summary || '').trim().slice(0, SUMMARY_CAP);

  if (!ALLOWED_EPS.has(ep)) return json(400, { error: 'unknown ep' });
  if (!name)                return json(400, { error: 'name required' });
  if (!email)               return json(400, { error: 'email required' });
  if (!EMAIL_RE.test(email))return json(400, { error: 'email invalid' });
  if (summary.length < SUMMARY_MIN) {
    return json(400, { error: 'summary too short, please add a few more details' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json(500, { error: 'server not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Capture light context for triage. No IP or tracking beyond what
  // the browser sent in standard headers.
  const metadata = {
    referer:    event.headers && (event.headers.referer || event.headers.referrer) || null,
    user_agent: event.headers && event.headers['user-agent'] || null,
  };

  const row = {
    ep,
    name,
    email,
    summary,
    status: 'new',
    source: 'landing-page-form',
    metadata,
    ...(organization ? { organization } : {}),
    ...(phone        ? { phone }        : {}),
  };

  const { data, error } = await supabase
    .from('tg_consult_requests')
    .insert(row)
    .select('id, status')
    .single();

  if (error) {
    console.error('[tg-consult-request] insert failed', error);
    return json(500, { error: 'submission failed', detail: error.message });
  }

  return json(200, { id: data.id, status: data.status });
};
