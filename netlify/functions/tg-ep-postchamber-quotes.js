/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-postchamber-quotes — Generate live per-EP post-Chamber quotes that
   reference the actual judge critiques, not just the composite score.

   FLOW
   ====
   1. Client (index.html post-Chamber activation) renders templated EP
      lines immediately so the corridor never shows a loading state.
   2. In parallel, client POSTs the evaluation_id to this function.
   3. We look up the brief, judge outputs, and triangulation from
      Supabase.
   4. Single Anthropic call: given the brief and the panel's findings,
      write a one-line follow-up for each of the 9 EPs in their voice,
      referencing what the judges specifically said.
   5. Client replaces the templated quotes with the LLM-generated ones.

   ONE Anthropic call produces 9 quotes - cheaper, faster, and lets the
   model coordinate across EPs so they do not all reference the same
   weakness. Output budget: 1500 tokens (each quote ~120 tokens, plus
   JSON overhead). Input budget: brief + 24 judge critiques + matrix,
   capped at ~4000 tokens.

   POST body : { evaluation_id, name? }
   Response  : {
     evaluation_id,
     quotes: {
       ms_ivy: "...",
       wren_calloway: "...",
       carol_haynes: "...",
       matthew_vance: "...",
       arjun_mehta: "...",
       zara_cole: "...",
       reid_callum: "...",
       jules: "...",
       grant_ellis: "..."
     }
   }
   Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic       = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const voiceScripts    = require('../../config/voice_scripts.json');

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const NAME_MAX  = 60;
const CRITIQUE_TRUNC = 320;
const BRIEF_TRUNC = 1800;

// Canonical EP roster + role labels for the prompt + output validation.
const EP_ORDER = [
  { id: 'ms_ivy',        name: 'Ms. Ivy',        role: 'The Librarian',           focus: 'research, frameworks, prior literature, evidence gaps' },
  { id: 'wren_calloway', name: 'Wren Calloway',  role: 'The Scout',               focus: 'patent / prior-art landscape, market scout, where else the mechanic could live' },
  { id: 'carol_haynes',  name: 'Carol Haynes',   role: 'The Screener',            focus: 'pattern screening, audience narrowing, has-legs assessment' },
  { id: 'matthew_vance', name: 'Matthew Vance',  role: 'The Behaviorist',         focus: 'buyer psychology, emotional drivers, trigger moments, silent objections' },
  { id: 'arjun_mehta',   name: 'Arjun Mehta',    role: 'The Make-It-Real Expert', focus: 'manufacturing, regulatory route, operations, sourcing' },
  { id: 'zara_cole',     name: 'Zara Cole',      role: 'The Influencer',          focus: 'founder-POV content, social channels, cultural fit, voice' },
  { id: 'reid_callum',   name: 'Reid Callum',    role: 'The Marketing Expert',    focus: 'press release, brand direction, monetization, launch positioning' },
  { id: 'jules',         name: 'Jules',          role: 'The Rewrite Partner',     focus: 'founder-voice rewrite, narrative spine, copy editing' },
  { id: 'grant_ellis',   name: 'Grant Ellis',    role: 'The Coach',               focus: 'elevator speech for real-world rooms, panel rehearsal' },
];

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

function buildSystemPrompt(name) {
  const nameRef = name || 'the founder';
  const epList = EP_ORDER.map(ep => `  - ${ep.id}: ${ep.name} (${ep.role}) - ${ep.focus}`).join('\n');

  return `You write post-Chamber follow-up lines for The Gauntlet's nine Executive Producers. ${nameRef} just walked through the panel of judges and the panel scored their idea across 8 dimensions. Now they have returned to the corridor where the EPs flank the hall, and each EP has one chance to say ONE line that pulls them in.

EACH LINE MUST
  - Read in that EP's voice (use the EP's focus area below to anchor what they would say).
  - Reference SOMETHING SPECIFIC the judges said or scored. Not the composite generic - a specific dimension, a specific critique, a specific number.
  - Make a concrete offer: what the EP can do next for ${nameRef}.
  - Be 1-2 short sentences. No em dashes, plain hyphens. No markdown.
  - Coordinate ACROSS EPs - each EP should claim a DIFFERENT angle so the corridor reads as a panel of distinct offers, not nine variations of the same offer.

THE NINE EPS
${epList}

NAME RULE
${name
  ? `Address ${nameRef} by name once at the start of at most 2 of the 9 lines (overuse feels forced). The rest use "you" directly.`
  : `No name was provided. Use "you" directly in every line.`}

OUTPUT: pure JSON only, no prose around it. Keys must be the exact EP ids from the list. Every EP must have a quote.

{
  "ms_ivy":        "<one to two sentences>",
  "wren_calloway": "<one to two sentences>",
  "carol_haynes":  "<one to two sentences>",
  "matthew_vance": "<one to two sentences>",
  "arjun_mehta":   "<one to two sentences>",
  "zara_cole":     "<one to two sentences>",
  "reid_callum":   "<one to two sentences>",
  "jules":         "<one to two sentences>",
  "grant_ellis":   "<one to two sentences>"
}`;
}

function buildUserPrompt(brief, title, judgeOutputs, triangulation) {
  const composite10 = Math.round((triangulation.composite_score || 0) * 100) / 10;
  const verdict     = triangulation.verdict || 'middle';

  // Per-dimension average + the 3 judges' lines, formatted compactly.
  const matrix = triangulation.matrix || {};
  const dims   = Object.keys(matrix);

  const byDim = {};
  for (const o of judgeOutputs) {
    const dim = String(o.stage || '').toLowerCase();
    if (!dim) continue;
    if (!byDim[dim]) byDim[dim] = [];
    byDim[dim].push(o);
  }

  const dimBlocks = dims.map(dim => {
    const scores = Object.values(matrix[dim] || {}).filter(s => typeof s === 'number');
    const avg = scores.length ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : '?';
    const lines = (byDim[dim] || []).slice(0, 3).map(o => {
      const score = (o.dimension_scores && (o.dimension_scores[dim] ?? Object.values(o.dimension_scores)[0])) ?? '?';
      const crit = String(o.stage_critique || '').slice(0, CRITIQUE_TRUNC).replace(/\s+/g, ' ').trim();
      return `      [${o.judge_id} ${score}/10] ${crit}`;
    }).join('\n');
    return `  ${dim.toUpperCase()} (avg ${avg}/10)\n${lines}`;
  }).join('\n\n');

  return [
    `SUBMISSION TITLE: ${title || '(untitled)'}`,
    '',
    `THE BRIEF (truncated):`,
    String(brief || '').slice(0, BRIEF_TRUNC),
    '',
    `PANEL VERDICT: ${verdict}    COMPOSITE: ${composite10} / 10`,
    '',
    `PANEL FINDINGS BY DIMENSION:`,
    dimBlocks,
    '',
    `Write the nine EP post-Chamber lines now. Coordinate across EPs - each claims a different angle. JSON only.`,
  ].join('\n');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'invalid json' }); }

  const evaluation_id = String(body.evaluation_id || '').trim();
  const name = sanitizeName(body.name);
  if (!evaluation_id) return json(400, { error: 'evaluation_id required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(500, { error: 'supabase env missing' });
  if (!ANTHROPIC_KEY) return json(500, { error: 'anthropic env missing' });
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const client   = new Anthropic({ apiKey: ANTHROPIC_KEY });

  // 1. Look up the evaluation row -> submission_id.
  const { data: evalRow, error: evalErr } = await supabase
    .from('tg_evaluations')
    .select('id, submission_id')
    .eq('id', evaluation_id)
    .maybeSingle();
  if (evalErr || !evalRow) {
    console.error('[tg-ep-postchamber-quotes] eval lookup failed', evalErr);
    return json(404, { error: 'evaluation not found' });
  }

  // 2. Submission (brief + title).
  const { data: subRow, error: subErr } = await supabase
    .from('tg_submissions')
    .select('id, title, description')
    .eq('id', evalRow.submission_id)
    .maybeSingle();
  if (subErr || !subRow) {
    console.error('[tg-ep-postchamber-quotes] submission lookup failed', subErr);
    return json(404, { error: 'submission not found' });
  }

  // 3. Judge outputs for this evaluation.
  const { data: outRows, error: outErr } = await supabase
    .from('tg_judge_outputs')
    .select('judge_id, stage, dimension_scores, stage_critique')
    .eq('evaluation_id', evaluation_id)
    .order('created_at', { ascending: true });
  if (outErr) {
    console.error('[tg-ep-postchamber-quotes] outputs lookup failed', outErr);
    return json(500, { error: 'outputs lookup failed' });
  }

  // 4. Triangulation (most recent).
  const { data: triRows, error: triErr } = await supabase
    .from('tg_triangulations')
    .select('matrix, composite_score, verdict, created_at')
    .eq('evaluation_id', evaluation_id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (triErr) {
    console.error('[tg-ep-postchamber-quotes] triangulation lookup failed', triErr);
    return json(500, { error: 'triangulation lookup failed' });
  }
  const triangulation = (triRows && triRows[0]) || { matrix: {}, composite_score: 0, verdict: 'middle' };

  // 5. Single Anthropic call.
  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: buildUserPrompt(subRow.description, subRow.title, outRows || [], triangulation) }],
    });
  } catch (err) {
    console.error('[tg-ep-postchamber-quotes] anthropic error', err && err.message);
    return json(502, { error: 'generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-ep-postchamber-quotes] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  // 6. Clean + validate. Every EP must have a non-empty quote; if any
  //    are missing, return what we have and let the client fall back
  //    to its template lines for the missing EPs.
  const quotes = {};
  let validCount = 0;
  for (const ep of EP_ORDER) {
    const line = dashClean(parsed[ep.id]);
    if (line && line.length >= 8) {
      quotes[ep.id] = line.slice(0, 600);
      validCount++;
    }
  }
  if (validCount < 5) {
    console.error('[tg-ep-postchamber-quotes] too few valid quotes', validCount);
    return json(502, { error: 'incomplete response' });
  }

  return json(200, { evaluation_id, quotes });
};
