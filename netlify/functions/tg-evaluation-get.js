/* ─────────────────────────────────────────────────────────────────────────────
   tg-evaluation-get — Read one full evaluation for the routing report page.

   Fetches the evaluation row + the submission's title + all judge outputs
   + the triangulation, joined into one response shape the /report.html
   page can render directly.

   GET ?id=<evaluation_uuid>
   Auth      : none for slice 1 (submissions are anonymous; future slices
               will require either the anon user_id from localStorage or
               a real Supabase JWT).
   Response  : {
     evaluation: {
       id, submission_id, status, stage, triad, created_at, completed_at
     },
     submission: { id, title },
     judge_outputs: [
       { judge_id, dimension_scores, stage_critique, confidence, created_at }
     ],
     triangulation: {
       matrix, agreement_dimensions, conflict_dimensions, coverage_gaps,
       composite_score
     } | null
   }
   Env vars  : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const { createClient } = require('@supabase/supabase-js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'private, max-age=10',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }
  if (event.httpMethod !== 'GET') return json(405, { error: 'method not allowed' });

  const qs = event.queryStringParameters || {};
  const evaluationId = String(qs.id || '').trim();
  if (!UUID_RE.test(evaluationId)) return json(400, { error: 'invalid evaluation id' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1. Evaluation row.
  const { data: evalRow, error: evalErr } = await supabase
    .from('tg_evaluations')
    .select('id, submission_id, status, stage, triad, created_at, completed_at')
    .eq('id', evaluationId)
    .maybeSingle();
  if (evalErr)   return json(500, { error: 'evaluation lookup failed', detail: evalErr.message });
  if (!evalRow)  return json(404, { error: 'evaluation not found' });

  // 2. Submission title (only the title is exposed - description stays
  //    private; the report shows what the judges saw, not the raw text).
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, title')
    .eq('id', evalRow.submission_id)
    .maybeSingle();
  if (subErr) return json(500, { error: 'submission lookup failed', detail: subErr.message });

  // 3. Judge outputs.
  const { data: outRows, error: outErr } = await supabase
    .from('tg_judge_outputs')
    .select('judge_id, dimension_scores, stage_critique, confidence, created_at')
    .eq('evaluation_id', evaluationId)
    .order('created_at', { ascending: true });
  if (outErr) return json(500, { error: 'judge outputs lookup failed', detail: outErr.message });

  // 4. Triangulation (most recent if there are multiple).
  const { data: triRows, error: triErr } = await supabase
    .from('tg_triangulations')
    .select('matrix, agreement_dimensions, conflict_dimensions, coverage_gaps, composite_score, created_at')
    .eq('evaluation_id', evaluationId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (triErr) return json(500, { error: 'triangulation lookup failed', detail: triErr.message });

  return json(200, {
    evaluation:    evalRow,
    submission:    subRow || null,
    judge_outputs: outRows || [],
    triangulation: (triRows && triRows[0]) || null,
  });
};
