/* ─────────────────────────────────────────────────────────────────────────────
   tg-ivy-search — SerpAPI wrapper for Ms. Ivy's SLR engine.

   Thin connector. ONE search per call. Knows nothing about subgroups, SLR
   architecture, or quota budgeting - those decisions live in the
   orchestrator that calls this. By keeping this layer dumb we can also
   call it from anywhere else later (Wren's prior-art sweep, for example)
   without re-implementing the wrapper.

   POST body : {
     query: string (required, 1-300 chars) - the search string
     num:   number (optional, default 10, max 20) - results to return
     site:  string (optional) - domain filter, e.g. "reddit.com" -> appended
                                 as "site:<domain>" to the query
   }
   Auth      : none for slice 1 (anonymous). The orchestrator that calls this
               is itself behind the paid-tier gate, so direct calls from
               outside the orchestrator just burn the same quota without
               benefit - not a security issue, an operational one we'll
               address when we add per-user accounting.
   Response  : 200 { results: [ { title, snippet, url, source }, ... ] }
               400 { error: "..." } - bad input
               500 { error: "..." } - SERPAPI_KEY missing
               502 { error: "..." } - SerpAPI returned an error or unparseable response

   Env vars  : SERPAPI_KEY (required)
   Cost      : 1 SerpAPI search per successful call. Counts against the
               account's monthly quota (250/mo on free tier).
   ───────────────────────────────────────────────────────────────────────────── */

const SERPAPI_ENDPOINT = 'https://serpapi.com/search';
const QUERY_MAX = 300;
const NUM_DEFAULT = 10;
const NUM_MAX = 20;

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
    return json(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return json(500, { error: 'SERPAPI_KEY not configured' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const queryRaw = String(body.query || '').trim();
  if (!queryRaw) {
    return json(400, { error: 'query is required' });
  }
  if (queryRaw.length > QUERY_MAX) {
    return json(400, { error: `query exceeds ${QUERY_MAX} chars` });
  }

  const num = Math.min(
    Math.max(parseInt(body.num, 10) || NUM_DEFAULT, 1),
    NUM_MAX
  );

  const siteRaw = String(body.site || '').trim().toLowerCase();
  // Only allow a-z 0-9 dot dash in the site filter so a malicious caller
  // can't smuggle extra Google operators through the site parameter.
  const siteSafe = /^[a-z0-9.\-]+$/.test(siteRaw) ? siteRaw : '';
  const query = siteSafe ? `${queryRaw} site:${siteSafe}` : queryRaw;

  const params = new URLSearchParams({
    engine:  'google',
    q:       query,
    num:     String(num),
    api_key: apiKey,
  });

  let response;
  try {
    response = await fetch(`${SERPAPI_ENDPOINT}?${params}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });
  } catch (err) {
    console.error('[tg-ivy-search] network error', err.message);
    return json(502, { error: 'search service unreachable' });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('[tg-ivy-search] serpapi non-2xx', response.status, detail.slice(0, 300));
    return json(502, { error: `search service error ${response.status}` });
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    console.error('[tg-ivy-search] serpapi response not json', err.message);
    return json(502, { error: 'search response was not json' });
  }

  // SerpAPI returns an error key inside a 200 body in some cases
  // (quota exhausted, invalid key, etc). Surface that as 502.
  if (payload && payload.error) {
    console.error('[tg-ivy-search] serpapi error in body', payload.error);
    return json(502, { error: String(payload.error).slice(0, 200) });
  }

  const organic = Array.isArray(payload.organic_results) ? payload.organic_results : [];
  const results = organic.slice(0, num).map(r => ({
    title:   String(r.title    || '').trim(),
    snippet: String(r.snippet  || '').trim(),
    url:     String(r.link     || '').trim(),
    source:  String(r.source   || r.displayed_link || hostname(r.link)).trim(),
  })).filter(r => r.title && r.url);

  return json(200, {
    query,
    count: results.length,
    results,
  });
};

// Extract just the host out of a URL for the source label fallback.
// Tolerates anything - returns empty string if the input isn't a URL.
function hostname(url) {
  try { return new URL(url).hostname; }
  catch { return ''; }
}
