/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-patent-queries — Phase 1 of Wren's patent assessment.
   Extracts 3-4 patent-search queries from the brief, then runs them live
   against Google Patents via SerpAPI. Returns the prior-art set
   un-analyzed. The client takes this payload and posts it to
   tg-wren-patent-analyze for the LLM read.

   This is split from a unified function because the full pipeline (extract
   queries + search + analyze) exceeds Netlify's 26-second function cap.
   Two sync calls + client orchestration keeps each step under cap and
   gives the visitor a visible progression: queries running -> patents
   found -> analyzing -> done.

   POST body : { brief, name }
   Response  : {
     queries: [string],
     technical_summary: string,
     prior_art: [{
       title, publication_number, assignee, inventor,
       filing_date, publication_date, snippet, link
     }]
   }
   Env: ANTHROPIC_API_KEY, SERPAPI_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 500;
const BRIEF_MAX = 6000;
const NAME_MAX  = 60;
const BRIEF_MIN = 30;
const SERPAPI_ENDPOINT = 'https://serpapi.com/search';
const PATENTS_PER_QUERY = 15;
const MAX_QUERIES = 4;

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

function buildQueryPrompt(name) {
  const w = (voiceScripts.scripts && voiceScripts.scripts.wren_calloway) || {};
  const nameRef = name || 'the founder';
  return `You are Wren Calloway, The Scout. ${nameRef} wants to know if their idea is patentable. First move: identify 3-${MAX_QUERIES} DISTINCT patent-search queries that would surface the relevant prior art on Google Patents.

CHARACTER (write IN this voice for the technical_summary; never quote the bio):
  Bio:  ${w.bio || ''}
  Role: ${w.role || ''}

QUERY DESIGN RULES
  - Each query is 4-12 words.
  - Patent-style vocabulary: "method for", "apparatus", "system", "composition" combined with the core mechanic.
  - No brand names, no marketing language.
  - Each query targets a DIFFERENT angle (apparatus, method, combination, use-case).
  - Plain hyphens only. No em dashes. No quotation marks.

OUTPUT: pure JSON only, no prose.

{
  "queries": ["query 1", "query 2", "query 3", "query 4"],
  "technical_summary": "<two sentences in Wren's voice summarizing the technical idea in patent vocabulary - what she searched for>"
}`;
}

async function searchPatents(query, apiKey) {
  const params = new URLSearchParams({
    engine:  'google_patents',
    q:       query,
    num:     String(PATENTS_PER_QUERY),
    api_key: apiKey,
  });
  let response;
  try {
    response = await fetch(`${SERPAPI_ENDPOINT}?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error('[tg-wren-patent-queries] serpapi network error', err.message);
    return [];
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[tg-wren-patent-queries] serpapi non-2xx', response.status, detail.slice(0, 300));
    return [];
  }
  let payload;
  try { payload = await response.json(); }
  catch (err) {
    console.error('[tg-wren-patent-queries] serpapi response not json', err.message);
    return [];
  }
  if (payload && payload.error) {
    console.error('[tg-wren-patent-queries] serpapi error in body', payload.error);
    return [];
  }
  const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];
  return organic.map(r => ({
    title:              String(r.title || '').trim(),
    publication_number: String(r.publication_number || r.patent_id || '').trim(),
    assignee:           String(r.assignee || '').trim(),
    inventor:           String(r.inventor || '').trim(),
    filing_date:        String(r.filing_date || '').trim(),
    publication_date:   String(r.publication_date || '').trim(),
    snippet:            String(r.snippet || r.abstract || '').trim(),
    link:               String(r.link || r.patent_link || '').trim(),
  })).filter(r => r.title && r.publication_number);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }
  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serpKey      = process.env.SERPAPI_KEY;
  if (!anthropicKey) return json(500, { error: 'anthropic env missing' });
  if (!serpKey)      return json(500, { error: 'serpapi env missing' });

  const client = new Anthropic({ apiKey: anthropicKey });

  // 1. LLM extracts queries.
  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildQueryPrompt(name),
      messages: [{ role: 'user', content: `THE BRIEF:\n"""\n${brief}\n"""\n\nGenerate 3-${MAX_QUERIES} patent-search queries. JSON only.` }],
    });
  } catch (err) {
    console.error('[tg-wren-patent-queries] anthropic error', err && err.message);
    return json(502, { error: 'query extraction failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty query response' });
  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-wren-patent-queries] query parse fail', raw.slice(0, 300));
    return json(502, { error: 'query response was not valid json' });
  }

  const queries = Array.isArray(parsed.queries)
    ? parsed.queries.map(q => dashClean(q)).filter(Boolean).slice(0, MAX_QUERIES)
    : [];
  if (queries.length < 1) return json(502, { error: 'no usable queries' });

  // 2. SerpAPI searches in parallel.
  const batches = await Promise.all(queries.map(q => searchPatents(q, serpKey)));
  const seen = new Set();
  const prior_art = [];
  for (const batch of batches) {
    for (const r of batch) {
      if (seen.has(r.publication_number)) continue;
      seen.add(r.publication_number);
      prior_art.push(r);
    }
  }

  return json(200, {
    queries,
    technical_summary: dashClean(parsed.technical_summary || ''),
    prior_art,
  });
};
