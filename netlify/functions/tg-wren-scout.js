/* ─────────────────────────────────────────────────────────────────────────────
   tg-wren-scout — Landscape Scout Report generator (Wren's tool).

   Reads the visitor's brief and returns a full landscape map:
     - Where it can work (market segments / geographies / use-case slices)
     - Focus recommendation (the single best beachhead)
     - OTHER USES (same mechanic applied to different problem domains -
       Terry's SLR Studio insight; founders' tools serve domains they
       were not built for, often more profitably)
     - Adjacent moves (small pivots to nearby markets)
     - White space map (where prior art / competition is genuinely thin)
     - Search hooks (specific search terms the visitor should run)
     - One thing Wren would NOT do based on this map
     - Rationale

   POST body : { brief, name }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1800;
const BRIEF_MAX  = 6000;
const NAME_MAX   = 60;
const BRIEF_MIN  = 30;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, NAME_MAX)
    .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '').trim();
}

function buildSystemPrompt(name) {
  const w = (voiceScripts.scripts && voiceScripts.scripts.wren_calloway) || {};
  const nameRef = name || 'the founder';
  return `You are Wren Calloway, The Scout at The Gauntlet. You build landscape maps for founders who are about to face a panel and do not yet know what landscape they are walking into.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${w.bio || ''}
  Role: ${w.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Return a full landscape map: where the idea can work, where to focus first, OTHER USES the same mechanic could serve in different problem domains, adjacent pivot moves, where the white space genuinely is, and the specific search terms ${nameRef} should run themselves to verify.

CRITICAL DISTINCTION
  "Where it can work" = more CUSTOMERS for the same use case. (SLR Studio for manuscripts -> academic medicine, regulatory writing, clinical reviews. Same product, more buyers.)
  "Other Uses"        = same MECHANIC applied to fundamentally different problems. (SLR Studio's underlying tech -> pharmacovigilance signal aggregation, patent landscape monitoring, M&A due diligence document review. Different product line; same engine.)
  "Adjacent moves"    = small PRODUCT PIVOTS to neighboring markets. (Slight feature changes to serve a related but distinct customer.)
  Treat these as three separate sections. The distinction matters.

OUTPUT REQUIREMENTS

  1. WHERE IT CAN WORK - 3 to 5 market segments / geographies / use-case slices where the CORE use case has the best fit. Each item:
     - "segment": plain language (e.g., "independent pharmacies in the US Midwest", "regulatory writers in mid-size pharma")
     - "why_fit": one sentence on why this segment fits
     - "density": one of "crowded" / "medium" / "thin" - how crowded the competitive landscape looks for this segment
     - "first_signal": one specific signal ${nameRef} could measure in 30 days to validate this segment

  2. FOCUS RECOMMENDATION - the SINGLE best beachhead from the segments above. Object with:
     - "segment": copy of the segment name
     - "reasoning": 2-3 sentences on why this one first - density, signal speed, founder-market fit, whatever drove the pick

  3. OTHER USES - 3 to 5 problem domains the same MECHANIC could serve. This is the SLR-Studio-for-pharmacovigilance pattern. Each item:
     - "domain": plain-language problem domain (e.g., "pharmacovigilance signal aggregation in pharma safety teams", "M&A due diligence document review at investment banks")
     - "mechanic_fit": one sentence on which part of the core mechanic serves this domain
     - "evidence_or_signal": one sentence on what would tell ${nameRef} whether this domain is real (a search to run, a person to ask, a forum to read)
   - Use ${nameRef}'s brief to identify the underlying mechanic, then look for domains where that mechanic solves a different problem. Concrete domains, not "lots of industries."

  4. ADJACENT MOVES - 2 to 3 small product pivots to nearby markets. Each item:
     - "move": one sentence describing the pivot
     - "what_changes": one sentence on what changes about the product
     - "what_stays": one sentence on what stays the same (this is what makes it adjacent, not a full pivot)

  5. WHITE SPACE MAP - 2 to 4 specific gaps in the current landscape where the visitor could move. Each item:
     - "gap": plain language description of the gap
     - "why_empty": one sentence on why the gap is empty - opportunity, regulatory dead zone, or "graveyard" of failed attempts
     - "verdict": one of "opportunity" / "caution" / "graveyard"
   - Be honest about graveyards. Empty space is sometimes empty for good reason.

  6. SEARCH HOOKS - 5 to 8 specific search terms ${nameRef} should run themselves to verify this landscape. Each item:
     - "query": the actual search string
     - "where": which database / source ("Google Patents", "USPTO PatFT", "EPO Espacenet", "Google Scholar", "Crunchbase", "Lens.org")
     - "looking_for": one sentence on what a hit would mean

  7. ONE THING NOT TO DO - based on this map, the single move Wren would specifically warn against. One sentence.

  8. RATIONALE - Two sentences:
     - First sentence: what about THIS brief drove the focus recommendation
     - Second sentence: the one Other Use ${nameRef} should investigate first (even before they investigate Where It Can Work segments), if any stood out

DRAFTING RULES
  - No specific company names in any section. Patterns and shapes only. Same logic as Carol and Arjun - companies go stale; the landscape shape is durable.
  - Use [SQUARE BRACKET PLACEHOLDERS] for facts the brief lacks. Never invent.
  - Specific over abstract. "Regulatory writers in mid-size pharma" beats "professionals in pharma."
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "where_it_can_work": [
    {"segment": "<plain language>", "why_fit": "<one sentence>", "density": "crowded|medium|thin", "first_signal": "<one sentence>"}
  ],
  "focus_recommendation": {"segment": "<segment name>", "reasoning": "<2-3 sentences>"},
  "other_uses": [
    {"domain": "<problem domain>", "mechanic_fit": "<one sentence>", "evidence_or_signal": "<one sentence>"}
  ],
  "adjacent_moves": [
    {"move": "<one sentence>", "what_changes": "<one sentence>", "what_stays": "<one sentence>"}
  ],
  "white_space_map": [
    {"gap": "<plain language>", "why_empty": "<one sentence>", "verdict": "opportunity|caution|graveyard"}
  ],
  "search_hooks": [
    {"query": "<search string>", "where": "<database/source>", "looking_for": "<one sentence>"}
  ],
  "one_thing_not_to_do": "<one sentence>",
  "rationale": "<two sentences as described>"
}`;
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `THE FOUNDER'S BRIEF (this is the landscape you are mapping - use only what's here, placeholder anything missing):`,
    '"""', brief, '"""', '',
    'Draft the landscape scout report now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-wren-scout] anthropic error', err && err.message);
    return json(502, { error: 'scout report generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-wren-scout] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const stripDashes = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  const where_it_can_work = Array.isArray(parsed.where_it_can_work)
    ? parsed.where_it_can_work.filter(s => s && s.segment).slice(0, 6).map(s => ({
        segment:      stripDashes(s.segment),
        why_fit:      stripDashes(s.why_fit),
        density:      ['crowded','medium','thin'].includes(s.density) ? s.density : 'medium',
        first_signal: stripDashes(s.first_signal),
      }))
    : [];

  const focusRaw = parsed.focus_recommendation && typeof parsed.focus_recommendation === 'object' ? parsed.focus_recommendation : null;
  const focus_recommendation = focusRaw ? {
    segment:   stripDashes(focusRaw.segment),
    reasoning: stripDashes(focusRaw.reasoning),
  } : null;

  const other_uses = Array.isArray(parsed.other_uses)
    ? parsed.other_uses.filter(o => o && o.domain).slice(0, 6).map(o => ({
        domain:             stripDashes(o.domain),
        mechanic_fit:       stripDashes(o.mechanic_fit),
        evidence_or_signal: stripDashes(o.evidence_or_signal),
      }))
    : [];

  const adjacent_moves = Array.isArray(parsed.adjacent_moves)
    ? parsed.adjacent_moves.filter(a => a && a.move).slice(0, 4).map(a => ({
        move:         stripDashes(a.move),
        what_changes: stripDashes(a.what_changes),
        what_stays:   stripDashes(a.what_stays),
      }))
    : [];

  const white_space_map = Array.isArray(parsed.white_space_map)
    ? parsed.white_space_map.filter(g => g && g.gap).slice(0, 5).map(g => ({
        gap:       stripDashes(g.gap),
        why_empty: stripDashes(g.why_empty),
        verdict:   ['opportunity','caution','graveyard'].includes(g.verdict) ? g.verdict : 'caution',
      }))
    : [];

  const search_hooks = Array.isArray(parsed.search_hooks)
    ? parsed.search_hooks.filter(s => s && s.query).slice(0, 10).map(s => ({
        query:        stripDashes(s.query),
        where:        stripDashes(s.where),
        looking_for:  stripDashes(s.looking_for),
      }))
    : [];

  const one_thing_not_to_do = stripDashes(parsed.one_thing_not_to_do);
  const rationale = stripDashes(parsed.rationale);

  if (!where_it_can_work.length || !focus_recommendation) {
    return json(502, { error: 'incomplete response' });
  }

  return json(200, {
    where_it_can_work,
    focus_recommendation,
    other_uses,
    adjacent_moves,
    white_space_map,
    search_hooks,
    one_thing_not_to_do,
    rationale,
  });
};
