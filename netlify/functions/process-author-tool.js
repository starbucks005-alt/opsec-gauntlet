/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Unified Author Tool processor

   Single Netlify function that routes between three formerly-Coming-Soon tools:
     - structural_rebuild  (4 credits)  Rebuild a chapter/act structure
     - scene_builder       (3 credits)  Construct a scene from a premise
     - descriptor_library  (2 credits)  Replace repetitive/generic descriptions

   All three: Supabase JWT auth, credit check + deduction, Claude Sonnet 4.6,
   8,000-character input cap (per spec checklist), anti-em-dash + anti-hedging
   instruction (matches Grey/Gauntlet output style).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const INPUT_CAP = 8000;
const COSTS = {
  structural_rebuild: 4,
  scene_builder: 3,
  descriptor_library: 2,
};

const STYLE_RULES = `
HOUSE STYLE RULES (apply to every response):
- Never use em dashes (—). Use periods, commas, colons, or short sentences instead.
- Do not hedge ("I think", "in my opinion", "to be fair").
- Do not cushion criticism with compensatory praise.
- State problems directly. State strengths directly when they are genuinely strong.
- Return only the requested content. No preamble, no commentary, no meta-discussion.
`.trim();

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { tool_type, payload } = body;
  if (!tool_type || !payload) return json(400, { error: 'Missing tool_type or payload' });

  const cost = COSTS[tool_type];
  if (cost === undefined) return json(400, { error: 'Invalid tool_type' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  // Auth
  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  // Credit check
  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < cost) return json(402, { error: 'Insufficient credits', needed: cost, have: balance });

  // Validate primary input + cap
  let primary;
  try { primary = primaryFor(tool_type, payload); }
  catch (e) { return json(400, { error: e.message }); }
  if (primary.length > INPUT_CAP) {
    return json(413, { error: `Input too long. Max ${INPUT_CAP} characters; received ${primary.length}.` });
  }

  // Process
  let text;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    if (tool_type === 'structural_rebuild') {
      text = await processStructuralRebuild(client, payload.text_block, payload.intent, payload.pacing_profile);
    } else if (tool_type === 'scene_builder') {
      text = await processSceneBuilder(client, payload.premise, payload.characters_present, payload.pacing_tempo);
    } else if (tool_type === 'descriptor_library') {
      text = await processDescriptorLibrary(client, payload.text_segment, payload.focus_area, payload.tone_profile);
    }
  } catch (err) {
    console.error('[process-author-tool] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  // Deduct credits
  const newBalance = balance - cost;
  const { error: updErr } = await supabase
    .from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, { result: text, credits_remaining: newBalance });
};

// ─── Validators ──────────────────────────────────────────────────────────────
function primaryFor(toolType, payload) {
  if (toolType === 'structural_rebuild') {
    if (!payload.text_block) throw new Error('Missing text_block payload');
    return payload.text_block;
  }
  if (toolType === 'scene_builder') {
    if (!payload.premise) throw new Error('Missing premise payload');
    return payload.premise;
  }
  if (toolType === 'descriptor_library') {
    if (!payload.text_segment) throw new Error('Missing text_segment payload');
    return payload.text_segment;
  }
  return '';
}

// ─── Processors ──────────────────────────────────────────────────────────────
async function processStructuralRebuild(client, textBlock, intent, pacingProfile) {
  const intentLine    = intent ? `\nAUTHOR INTENT: ${intent}` : '';
  const pacingLine    = pacingProfile ? `\nPACING PROFILE: ${pacingProfile}` : '';

  const system = `You are Grey, restructuring a chapter or act of fiction for an author at Greylander Press. The author has identified that the current structure needs more than polish. Beats are missing, escalation is misordered, or scenes are not earning their place.

Your job:
1. Read the existing prose.
2. Identify the structural problems (which beats are missing, where escalation breaks, what scenes do not pull weight).
3. Return a rebuild proposal with two parts:
   PART A — DIAGNOSIS: a numbered list of 3 to 5 specific structural problems you found in the prose. Each item names the problem and the location in the prose.
   PART B — REBUILT OUTLINE: a scene-by-scene outline for the rebuilt chapter or act. Each scene gets one or two sentences describing what happens, what changes, and how it earns its place.

${STYLE_RULES}`;

  const user = `TEXT TO RESTRUCTURE${intentLine}${pacingLine}

---
${textBlock}
---

Return PART A and PART B in that order. Use plain text headers ("PART A — DIAGNOSIS" and "PART B — REBUILT OUTLINE"). No markdown fences.`;

  return await callClaude(client, system, user, 2200);
}

async function processSceneBuilder(client, premise, charactersPresent, pacingTempo) {
  const charsLine    = charactersPresent ? `\nCHARACTERS PRESENT: ${charactersPresent}` : '';
  const tempoLine    = pacingTempo ? `\nPACING TEMPO: ${pacingTempo}` : '';

  const system = `You are Grey, constructing a single fiction scene from a premise. The author has given you the situation, who is in the room, and the pacing tempo. Your job is to deliver a scene that earns its beats.

Structure each scene in five movements:
1. OPENING HOOK — a concrete sensory entry into the scene.
2. ESTABLISHMENT — what each character wants, and what is at stake right now.
3. ESCALATION — pressure increases, choices narrow.
4. COMPLICATION — something turns. Information surfaces, a character acts unexpectedly, or the situation breaks.
5. EXIT — resolution, cliffhanger, or decision that hands off into the next scene.

Write the scene as polished prose, not as an outline. Stay in third-person past tense unless the premise dictates otherwise. Render concrete sensory detail. Give each character distinct dialogue voice. Earn the emotional weight; do not summarize it.

${STYLE_RULES}`;

  const user = `PREMISE: ${premise}${charsLine}${tempoLine}

Return the complete scene as prose. No preamble, no commentary, no markdown.`;

  return await callClaude(client, system, user, 2400);
}

async function processDescriptorLibrary(client, textSegment, focusArea, toneProfile) {
  const focusLine    = focusArea ? `\nFOCUS AREA: ${focusArea}` : '';
  const toneLine     = toneProfile ? `\nTONE PROFILE: ${toneProfile}` : '';

  const system = `You are Grey, replacing repetitive vocabulary and generic description in fiction prose with sharper alternatives.

Rules:
1. Preserve every plot beat exactly. No new events, no new characters, no new dialogue lines.
2. Preserve every line of dialogue exactly as written. Dialogue tags may be improved, the lines themselves may not.
3. Replace overused verbs, generic adjectives, and lazy descriptors (e.g., "looked", "smiled", "nice", "the man") with specific, particular alternatives that fit the FOCUS AREA and TONE PROFILE.
4. If a passage already uses sharp specific language, leave it alone. Do not change for the sake of change.
5. Return the rewritten passage. Then on a new line, return a short list of the most significant swaps you made (e.g., "looked → studied", "the door → the warped pine door"). Header the list "KEY SWAPS:".

${STYLE_RULES}`;

  const user = `PASSAGE TO SHARPEN${focusLine}${toneLine}

---
${textSegment}
---

Return the rewritten passage, then a blank line, then KEY SWAPS list.`;

  return await callClaude(client, system, user, 2400);
}

// ─── Claude wrapper ──────────────────────────────────────────────────────────
async function callClaude(client, system, user, maxTokens) {
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.6,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
