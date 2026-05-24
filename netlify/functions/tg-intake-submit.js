/* ─────────────────────────────────────────────────────────────────────────────
   tg-intake-submit — Submit an idea to The Gauntlet.

   Slice 1: anonymous submissions. The user_id is a client-generated anon
   uuid stored in the browser's localStorage; same browser = same anon user
   across submissions, and a future signup can claim/migrate them. Writes
   bypass RLS using the service role key.

   On submit we ALSO derive an 8-dimension requirement vector from the
   submission text (one Anthropic call). The vector is stored in
   self_assessment.requirement_vector on the row and returned in the
   response so the Chamber can feed it straight to the cosine-sim engine
   for real (not placeholder) judge recommendations. If the vector call
   fails the submission still succeeds; the chamber falls back to its
   default requirement vector.

   POST body : {
     user_id:     string (uuid, required)        - anon id from client localStorage
     title:       string (required, <=180 chars)
     description: string (required, <=12000 chars)
     goal_audience?: string (optional, <=500 chars)
     constraints?:   string (optional, <=2000 chars)
   }
   Response : {
     id: string,
     requirement_vector: { structure, viability, risk, narrative,
                           evidence, cultural, psych, compliance } | null
   }
   Env vars : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
              ANTHROPIC_API_KEY (optional - submit still works without)
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const VECTOR_MODEL = 'claude-sonnet-4-6';
const DIMENSIONS = ['structure','viability','risk','narrative','evidence','cultural','psych','compliance'];

const VECTOR_SYSTEM_PROMPT = `You score an idea submission against 8 evaluation dimensions used by The Gauntlet panel of judges. For each dimension return a number 0.0-1.0 representing how MUCH this idea needs evaluation in that area. High means the dimension is critical to evaluate for this idea; low means less relevant.

Dimensions:
- structure   : clarity of problem, solution, audience
- viability   : market size, business model, unit economics, exit
- risk        : operational, regulatory, security, defense exposure
- narrative   : storytelling, media, audience resonance
- evidence    : scientific rigor, data quality, research methodology
- cultural    : cross-cultural fit, audience demographics, language sensitivity
- psych       : human behavior, decision psychology, user intent vs. behavior
- compliance  : legal exposure, IP protection, regulatory pathway

Rules:
- Every dimension gets a number from 0.0 to 1.0.
- Be honest: a pure-software idea may score 0.1 on compliance and 0.0 on cultural.
- A medical idea will score high on risk and evidence.
- A consumer media idea will score high on narrative and cultural.
- Do not give every dimension the same score; differentiate.

OUTPUT JSON only, exactly this shape, no preamble:
{"structure":0.0,"viability":0.0,"risk":0.0,"narrative":0.0,"evidence":0.0,"cultural":0.0,"psych":0.0,"compliance":0.0}`;

async function deriveRequirementVector({ title, description, goal_audience, constraints }){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const userPrompt = [
    `TITLE: ${title}`,
    '',
    'DESCRIPTION:',
    description,
    goal_audience ? `\nAUDIENCE: ${goal_audience}` : '',
    constraints   ? `\nCONSTRAINTS: ${constraints}` : '',
    '',
    'Score all 8 dimensions now. JSON only.',
  ].filter(Boolean).join('\n');
  const client = new Anthropic({ apiKey });
  let resp;
  try {
    resp = await client.messages.create({
      model: VECTOR_MODEL,
      max_tokens: 300,
      system: VECTOR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.warn('[tg-intake-submit] vector derive failed', err.message);
    return null;
  }
  const raw = (resp.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return null;
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.warn('[tg-intake-submit] vector parse failed', raw);
    return null;
  }
  // Coerce to a clean 8-dimension shape, clamp 0-1, default 0 for missing.
  const vector = {};
  for (const dim of DIMENSIONS){
    const v = parseFloat(parsed[dim]);
    vector[dim] = isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }
  return vector;
}

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

  // Derive the requirement vector BEFORE the insert so the row stores it
  // immediately. If Anthropic is unavailable or the call fails, the
  // submission still goes through with vector=null and the chamber falls
  // back to its default vector.
  const requirementVector = await deriveRequirementVector({ title, description, goal_audience, constraints });

  const row = {
    user_id,
    type: 'idea',
    title,
    description,
    status: 'submitted',
    ...(goal_audience ? { goal_audience } : {}),
    ...(constraints   ? { constraints }   : {}),
    ...(requirementVector ? { self_assessment: { requirement_vector: requirementVector } } : {}),
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

  return json(200, {
    id: data.id,
    requirement_vector: requirementVector,
  });
};
