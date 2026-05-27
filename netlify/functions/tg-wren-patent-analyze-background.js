/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-patent-analyze-background

   Netlify Background Function (15-minute timeout) version of the Wren
   phase-2 patent analyzer. Same job as tg-wren-patent-analyze, but
   instead of returning the result synchronously (which exceeds Netlify's
   26-second sync cap), it writes the completed analysis to
   tg_wren_patent_jobs keyed on a client-supplied job_id. Clients poll
   tg-wren-patent-status with that job_id until status is done or error.

   Because the timeout is no longer a constraint, the output schema is
   restored to the richer shape we originally wanted: 6 prior_art
   entries and 5 CPC codes (vs. 4 and 3 in the sync version).

   POST body : {
     job_id:            string (uuid, REQUIRED) - client-generated
     brief, name,
     queries:           [string],
     technical_summary: string,
     prior_art:         [ { ... raw patent results from queries phase } ]
   }
   Response  : 202 immediately. The actual result lands in Supabase
   on the row keyed on job_id.

   Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2500;
const BRIEF_MAX = 6000;
const NAME_MAX  = 60;
const BRIEF_MIN = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX)
    .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}
function dashClean(s) {
  return String(s == null ? '' : s).replace(/—/g, '-').replace(/–/g, '-').trim();
}
function cleanString(s, max = 600) {
  return dashClean(s).slice(0, max);
}

const VALID_OVERLAP = new Set(['direct overlap', 'adjacent', 'background art', 'expired - free territory']);
const VALID_FIT     = new Set(['good fit', 'marginal fit', 'not recommended']);

function buildAnalyzePrompt(name) {
  const w = (voiceScripts.scripts && voiceScripts.scripts.wren_calloway) || {};
  const nameRef = name || 'the founder';
  return `You are Wren Calloway, The Scout. You just ran prior-art searches for ${nameRef}'s brief and pulled the relevant patents. Now produce the patent assessment.

CHARACTER (write IN this voice for the rationale; never quote the bio):
  Bio:  ${w.bio || ''}
  Role: ${w.role || ''}

YOUR JOB
  Read the brief and the prior-art results. Give ${nameRef} a real read on (a) what is already claimed, (b) what space remains, (c) which CPC classes apply, and (d) which of three next-step paths fits.

OUTPUT REQUIREMENTS

  1. PRIOR_ART - array of up to 6 of the MOST relevant patents from the results. Drop the rest. Each entry:
       - title, publication_number, assignee (from results)
       - filed_year, publication_year (4-digit years if extractable, else "")
       - abstract: ONE sentence summary of the patent's claim
       - link (from results)
       - relevance: ONE sentence on why this patent matters to the brief
       - claim_overlap: one of "direct overlap" | "adjacent" | "background art" | "expired - free territory"

  2. PATENTABILITY:
       - summary: 2-3 sentences. Honest read on whether the idea is patentable as-is.
       - strong_claims: 2-3 claim concepts the brief could defend (each a short phrase)
       - weak_claims: 1-2 claim concepts likely DOA against prior art (short phrase with reason)
       - gaps: 1-3 white-space angles in the prior art

  3. CPC_CODES - 3 to 5 entries:
       - code, label, why (one sentence each)

  4. NEXT_STEPS - exactly 3 entries in this order:
       - "Provisional self-file (USPTO TEAS Plus)" - fit, action, cost_estimate
       - "Engage a patent attorney" - fit, action, cost_estimate
       - "USPTO Pro Bono Program" - fit, action, cost_estimate
     fit is one of "good fit" | "marginal fit" | "not recommended"
     cost_estimate examples: "$70-$300" / "$5,000-$15,000" / "free if qualifying"

  5. RATIONALE - two sentences in Wren's voice. First: the most important finding. Second: Wren's pick for next step and why.

DRAFTING RULES
  - Only cite patents from the provided results. Do not invent.
  - This is NOT legal advice. Phrase as informed scout reads, not legal conclusions.
  - No em dashes, no markdown. Pure JSON output only.

OUTPUT JSON:
{
  "prior_art": [
    {"title":"...","publication_number":"...","assignee":"...","filed_year":"...","publication_year":"...","abstract":"...","link":"...","relevance":"...","claim_overlap":"adjacent"}
  ],
  "patentability": {"summary":"...","strong_claims":["..."],"weak_claims":["..."],"gaps":["..."]},
  "cpc_codes": [{"code":"...","label":"...","why":"..."}],
  "next_steps": [
    {"option":"Provisional self-file (USPTO TEAS Plus)","fit":"...","action":"...","cost_estimate":"..."},
    {"option":"Engage a patent attorney","fit":"...","action":"...","cost_estimate":"..."},
    {"option":"USPTO Pro Bono Program","fit":"...","action":"...","cost_estimate":"..."}
  ],
  "rationale": "<two sentences>"
}`;
}

function cleanPriorArt(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(p => p && (p.title || p.publication_number))
    .slice(0, 6)
    .map(p => ({
      title:              cleanString(p.title, 240),
      publication_number: cleanString(p.publication_number, 60),
      assignee:           cleanString(p.assignee, 200),
      filed_year:         cleanString(p.filed_year, 4),
      publication_year:   cleanString(p.publication_year, 4),
      abstract:           cleanString(p.abstract, 600),
      link:               cleanString(p.link, 400),
      relevance:          cleanString(p.relevance, 500),
      claim_overlap:      VALID_OVERLAP.has(String(p.claim_overlap || '').toLowerCase()) ? String(p.claim_overlap).toLowerCase() : 'adjacent',
    }));
}
function cleanPatentability(obj) {
  const p = obj && typeof obj === 'object' ? obj : {};
  return {
    summary:       cleanString(p.summary, 1000),
    strong_claims: Array.isArray(p.strong_claims) ? p.strong_claims.map(s => cleanString(s, 200)).filter(Boolean).slice(0, 3) : [],
    weak_claims:   Array.isArray(p.weak_claims)   ? p.weak_claims.map(s   => cleanString(s, 280)).filter(Boolean).slice(0, 2) : [],
    gaps:          Array.isArray(p.gaps)          ? p.gaps.map(s          => cleanString(s, 280)).filter(Boolean).slice(0, 3) : [],
  };
}
function cleanCpcCodes(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(c => c && c.code)
    .slice(0, 5)
    .map(c => ({
      code:  cleanString(c.code, 40),
      label: cleanString(c.label, 200),
      why:   cleanString(c.why, 280),
    }));
}
function cleanNextSteps(arr) {
  const valid = (Array.isArray(arr) ? arr : []).filter(s => s && s.option);
  const byOption = {};
  for (const s of valid) byOption[String(s.option || '').trim()] = s;
  const canon = [
    'Provisional self-file (USPTO TEAS Plus)',
    'Engage a patent attorney',
    'USPTO Pro Bono Program',
  ];
  return canon.map(opt => {
    const s = byOption[opt] || {};
    return {
      option:        opt,
      fit:           VALID_FIT.has(String(s.fit || '').toLowerCase()) ? String(s.fit).toLowerCase() : 'marginal fit',
      action:        cleanString(s.action, 280),
      cost_estimate: cleanString(s.cost_estimate, 60),
    };
  });
}

async function runAnalysis({ brief, name, queries, technical_summary, prior_art }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('anthropic env missing');
  const client = new Anthropic({ apiKey });

  const priorArtPayload = prior_art.length
    ? prior_art.slice(0, 15).map((p, i) => `[${i+1}] ${p.title || 'Untitled'}
  publication_number: ${p.publication_number || ''}
  assignee: ${p.assignee || ''}
  filed: ${p.filing_date || ''} | published: ${p.publication_date || ''}
  abstract/snippet: ${(p.snippet || '').slice(0, 400)}
  link: ${p.link || ''}`).join('\n\n')
    : '(No prior-art results. The search came up empty or the field is too new for indexed patents to surface. Treat as wide-open white space but flag the empty result honestly.)';

  const userPrompt = [
    `THE BRIEF:`,
    '"""', brief, '"""', '',
    `TECHNICAL SUMMARY:`,
    technical_summary || '(none)',
    '',
    `QUERIES YOU RAN:`,
    queries.map((q, i) => `  ${i+1}. ${q}`).join('\n'),
    '',
    `PRIOR-ART RESULTS:`,
    priorArtPayload,
    '',
    `Produce the patent assessment now. JSON only.`,
  ].join('\n');

  const response = await client.messages.create({
    model: MODEL, max_tokens: MAX_TOKENS,
    system: buildAnalyzePrompt(name),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) throw new Error('empty analysis response');
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('[tg-wren-patent-analyze-background] parse fail', raw.slice(0, 400));
    throw new Error('analysis response was not valid json');
  }

  const out = {
    queries_used:      queries,
    technical_summary,
    prior_art:         cleanPriorArt(parsed.prior_art),
    patentability:     cleanPatentability(parsed.patentability),
    cpc_codes:         cleanCpcCodes(parsed.cpc_codes),
    next_steps:        cleanNextSteps(parsed.next_steps),
    rationale:         cleanString(parsed.rationale, 800),
  };
  if (!out.patentability.summary || !out.next_steps[0].action) {
    throw new Error('incomplete analysis');
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const job_id           = String(body.job_id || '').trim().toLowerCase();
  const brief            = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name             = sanitizeName(body.name);
  const queries          = Array.isArray(body.queries) ? body.queries.map(q => dashClean(q)).filter(Boolean).slice(0, 8) : [];
  const technical_summary= dashClean(body.technical_summary || '');
  const prior_art        = Array.isArray(body.prior_art) ? body.prior_art : [];

  if (!UUID_RE.test(job_id))   return json(400, { error: 'job_id must be a valid uuid' });
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });
  if (queries.length < 1)       return json(400, { error: 'queries required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Mark job pending. If row already exists for this job_id we
  //    treat that as a duplicate submission and bail early.
  const { error: insertErr } = await supabase
    .from('tg_wren_patent_jobs')
    .insert({ job_id, status: 'pending' });
  if (insertErr && insertErr.code !== '23505') {
    console.error('[tg-wren-patent-analyze-background] insert failed', insertErr);
    return json(500, { error: 'job insert failed', detail: insertErr.message });
  }

  // 2) Run the analysis. On success, update row to done. On error,
  //    update row to error. Either way the row reflects the final
  //    state so polling clients land on a non-pending status.
  try {
    const result = await runAnalysis({ brief, name, queries, technical_summary, prior_art });
    await supabase
      .from('tg_wren_patent_jobs')
      .update({
        status: 'done',
        result,
        completed_at: new Date().toISOString(),
      })
      .eq('job_id', job_id);
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    console.error('[tg-wren-patent-analyze-background] analysis failed', msg);
    await supabase
      .from('tg_wren_patent_jobs')
      .update({
        status: 'error',
        error: msg.slice(0, 600),
        completed_at: new Date().toISOString(),
      })
      .eq('job_id', job_id);
  }

  return { statusCode: 200, body: 'done' };
};
