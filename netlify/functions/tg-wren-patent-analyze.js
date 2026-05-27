/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-patent-analyze — Phase 2 of Wren's patent assessment.
   Takes the brief plus the prior-art results from
   tg-wren-patent-queries and returns the structured analysis:
   prior-art landscape with relevance labels, patentability read, CPC
   classifications, three next-step paths, and Wren's two-sentence
   rationale.

   POST body : {
     brief, name,
     queries: [string],
     technical_summary: string,
     prior_art: [ { ... raw patent results from queries phase } ]
   }
   Response  : {
     queries_used, technical_summary,
     prior_art: [ ... with relevance + claim_overlap ],
     patentability, cpc_codes, next_steps, rationale
   }
   Env: ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 2500;
const BRIEF_MAX = 6000;
const NAME_MAX  = 60;
const BRIEF_MIN = 30;

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

  1. PRIOR_ART - array of exactly 4 of the MOST relevant patents from the results. Drop the rest. Each entry:
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

  3. CPC_CODES - exactly 3 entries:
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
    .slice(0, 4)
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
    .slice(0, 3)
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const brief             = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name              = sanitizeName(body.name);
  const queries           = Array.isArray(body.queries) ? body.queries.map(q => dashClean(q)).filter(Boolean).slice(0, 8) : [];
  const technical_summary = dashClean(body.technical_summary || '');
  const priorArtRaw       = Array.isArray(body.prior_art) ? body.prior_art : [];

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });
  if (queries.length < 1)        return json(400, { error: 'queries required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const priorArtPayload = priorArtRaw.length
    ? priorArtRaw.slice(0, 15).map((p, i) => `[${i+1}] ${p.title || 'Untitled'}
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

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildAnalyzePrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-wren-patent-analyze] anthropic error', err && err.message);
    return json(502, { error: 'analysis failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty analysis response' });
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-wren-patent-analyze] analysis parse fail', raw.slice(0, 400));
    return json(502, { error: 'analysis response was not valid json' });
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
    return json(502, { error: 'incomplete analysis' });
  }

  return json(200, out);
};
