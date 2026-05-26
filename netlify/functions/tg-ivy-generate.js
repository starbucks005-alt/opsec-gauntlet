/* ─────────────────────────────────────────────────────────────────────────────
   tg-ivy-generate — Idea Generator (Ms. Ivy's tool A).

   For visitors who do NOT yet have an idea. Takes three intake fields
   (world, frustration, capability), runs Ivy's method - map the space,
   find the gaps, propose three candidate ideas grounded in adjacent
   research - and returns three concrete candidates the visitor can pick
   one of and walk into The Gauntlet with.

   Each candidate names the gap it fills, adjacent literature / thinkers
   that ground it, the first validation step, and which other EP the
   visitor should walk to next once they choose. The choosing IS the
   visitor's job; Ivy hands them options, not a verdict.

   POST body : { world, frustration, capability, name }
   Response  : {
     candidates: [
       { name, what_it_is, the_gap, adjacent_research, first_validation,
         which_ep_next: { ep, ep_label, reason } }
     ],
     rationale: string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
const FIELD_MAX  = 1500;
const NAME_MAX   = 60;
const FIELD_MIN  = 8;

const VALID_EPS = {
  reid_callum:   'Reid (positioning, monetization, marketing/PR)',
  zara_cole:     'Zara (social media content)',
  jules:         'Jules (founder voice in the brief)',
  grant_ellis:   'Grant (Chamber prep)',
  arjun_mehta:   'Arjun (manufacturing, build path)',
  matthew_vance: 'Matthew (buyer psychology)',
  wren_calloway: 'Wren (patent and market landscape)',
  carol_haynes:  'Carol (screening / pattern read)',
};

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
  const i = (voiceScripts.scripts && voiceScripts.scripts.ms_ivy) || {};
  const nameRef = name || 'the visitor';
  const epList = Object.entries(VALID_EPS).map(([id, label]) => `  - ${id}: ${label}`).join('\n');
  return `You are Ms. Ivy, The Librarian at The Gauntlet. The visitor does not have an idea yet. They have given you three things - their world, what frustrates them in it, and what they would bring to the table. You run your method: map the space around their topic, find where the real gaps are, propose three concrete idea candidates each grounded in adjacent research or evidence.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read ${nameRef}'s three intake fields. Map the space. Find the gaps. Hand back THREE distinct idea candidates - not three flavors of the same idea, three genuinely different angles on the gap. Each one must be grounded in something real (a named framework, a thinker, a known research thread, an existing adjacent product category that the visitor's idea would extend or counter).

OUTPUT REQUIREMENTS

  Three CANDIDATES. Each one:
    - "name": short working name for the idea (NOT a brand name - just a label). 2-6 words. Specific, not abstract. ("Streak-Loss Recovery Coach", "Pharmacy Inventory Slack-Bot", "Caregiver Decision Diary").
    - "what_it_is": 2-3 sentences describing the idea. Concrete enough that someone could imagine the v1. Names the customer AND the mechanic.
    - "the_gap": one sentence naming the specific gap in the field (research, market, or both) that this candidate would fill. Tie it to the literature or the adjacent product landscape.
    - "adjacent_research": one sentence naming 1-2 real frameworks, thinkers, or named research threads that ground the candidate. Use REAL names (Nir Eyal, BJ Fogg, Kahneman, Christensen, etc.) only when genuinely relevant. Do NOT invent citations.
    - "first_validation": one sentence on the first concrete step ${nameRef} could take in the next 30 days to validate this candidate. Not "do market research." Specific (e.g., "interview 5 pharmacists who have lost a controlled-substance audit in the past year").
    - "which_ep_next": object with ep + ep_label + reason, naming the FIRST EP ${nameRef} should walk to next IF they pick this candidate.
        Valid EP ids (use exactly these strings):
${epList}
        Pick the EP whose work this candidate most needs first:
          - Carol if the candidate needs a screening read against patterns first
          - Wren if the candidate's defensibility hinges on a landscape scan
          - Matthew if the candidate's success depends on a specific emotional buy-driver
          - Reid if the candidate's monetization or positioning is the open question
          - Arjun if the candidate is physical / hardware / regulated
          - Jules if the candidate needs voice work before the panel reads it
          - Grant if the candidate is ready and just needs Chamber prep
          - Zara if the candidate's success hinges on owned audience / content marketing

  RATIONALE - two sentences:
    - First sentence: what about the three intake fields drove the THREE distinct angles you chose. Name the underlying gap you saw.
    - Second sentence: which of the three you would push ${nameRef} to look at first, and why.

DRAFTING RULES
  - Distinct angles, not three variations. If two candidates are the same idea in different clothes, collapse them and propose a genuinely different third.
  - Real frameworks, real thinkers. If you cannot name a real one for adjacent_research, leave a [PLACEHOLDER FOR REAL CITATION] and let the visitor fill it in. Never invent.
  - Specific over abstract. "Pharmacists running independent rural practices" beats "healthcare professionals."
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "candidates": [
    {
      "name": "<2-6 word working name>",
      "what_it_is": "<2-3 sentences>",
      "the_gap": "<one sentence on the gap this fills>",
      "adjacent_research": "<one sentence naming real frameworks or thinkers>",
      "first_validation": "<one sentence, concrete first step>",
      "which_ep_next": {"ep": "<valid EP id>", "ep_label": "<short name>", "reason": "<one sentence>"}
    }
  ],
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

  const world       = String(body.world       || '').trim().slice(0, FIELD_MAX);
  const frustration = String(body.frustration || '').trim().slice(0, FIELD_MAX);
  const capability  = String(body.capability  || '').trim().slice(0, FIELD_MAX);
  const name        = sanitizeName(body.name);

  if (world.length       < FIELD_MIN) return json(400, { error: 'tell Ivy about your world' });
  if (frustration.length < FIELD_MIN) return json(400, { error: 'tell Ivy what frustrates you' });
  if (capability.length  < FIELD_MIN) return json(400, { error: 'tell Ivy what you would bring' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });
  const client = new Anthropic({ apiKey });

  const userPrompt = [
    `WORLD (where ${name || 'the visitor'} lives, works, sees the problem from):`,
    world,
    '',
    'FRUSTRATION (what does not work in that world):',
    frustration,
    '',
    'WHAT THEY BRING (skill, network, lived experience, unfair advantage):',
    capability,
    '',
    'Run your method now. Hand back three candidates. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-ivy-generate] anthropic error', err && err.message);
    return json(502, { error: 'idea generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-ivy-generate] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  const candidates = Array.isArray(parsed.candidates)
    ? parsed.candidates
        .filter(c => c && c.name && c.what_it_is)
        .slice(0, 4)
        .map(c => {
          const refRaw = c.which_ep_next && typeof c.which_ep_next === 'object' ? c.which_ep_next : {};
          const epId   = String(refRaw.ep || '').trim();
          return {
            name:              strip(c.name),
            what_it_is:        strip(c.what_it_is),
            the_gap:           strip(c.the_gap),
            adjacent_research: strip(c.adjacent_research),
            first_validation:  strip(c.first_validation),
            which_ep_next:     VALID_EPS[epId] ? {
              ep:       epId,
              ep_label: String(refRaw.ep_label || '').trim().slice(0, 40) || (VALID_EPS[epId] || '').split(' ')[0],
              reason:   strip(refRaw.reason),
            } : null,
          };
        })
    : [];

  const rationale = strip(parsed.rationale);

  if (candidates.length < 2) return json(502, { error: 'incomplete - need at least 2 candidates' });

  return json(200, { candidates, rationale });
};
