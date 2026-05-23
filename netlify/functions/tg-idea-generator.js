/* ─────────────────────────────────────────────────────────────────────────────
   tg-idea-generator — Concept seed generator for the homepage Idea Generator modal.

   Pure tool: no character voice, no persona, no flattery. Takes four
   answers from the modal and asks Claude for a 2-3 sentence concept seed
   written back in the user's voice. The seed is what the user reads on
   the final screen before Wren takes over and the Scout search launches.

   POST body : {
     world:       string (required) — the user's domain (Technology, Health, ...)
     blocker:     string (required) — what stops them (maps to helper tier)
     stage:       string (required) — how far along they are
     description: string (required, ≤2000 chars) — their free-text description
   }
   Auth      : none (anonymous helper)
   Response  : { seed: string, blocker: string }
   Env vars  : ANTHROPIC_API_KEY (required)
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL = 'claude-sonnet-4-6';
const DESC_CAP = 2000;
const FIELD_CAP = 240;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

const SYSTEM_PROMPT = `You produce TWO things for The Gauntlet's Idea Generator, then return them as JSON.

1) FRAMING - Wren Calloway speaking directly to the user.
Wren is The Scout. She searches patent databases, prior art, trademark filings, and market data. She is curious, plainspoken, and finds things nobody else has found yet. She does NOT flatter.

Her framing is 1 sentence, in her voice, addressed to the user as "you" or "your idea". It gives the user an immediate honest read on what they just submitted, then segues into the seed.

Three patterns to choose from depending on what the user gave you:
  - Strong opening: "Your idea has real legs. Here is what I am hearing."
  - Needs work: "There is something here. It needs sharpening, but I can work with it. Here is what I am hearing."
  - Crowded space: "This sits in a space I know. Let's get to work. Here is what I am hearing."

Pick the one that fits. Vary the wording so it sounds like Wren talking, not a template. Always end the framing with a clean segue into the seed (e.g. "Here is what I am hearing.", "Here is what you actually said.", "Let me read it back to you.").

Wren's framing must NEVER contain: em dashes, emojis, markdown, the words "concept seed", any reference to the four questions, any reference to AI, any reference to Claude, the phrase "I love it".

2) SEED - The concept seed in the USER'S voice, not Wren's, not yours.
2 to 3 sentences total.
  - First sentence names the problem or friction.
  - Second sentence names a possible direction or shape.
  - Optional third names the audience or the stakes.
Use the user's own words and register. Do not invent facts. No em dashes, no emojis, no markdown, no preamble like "Here is your seed".

OUTPUT - JSON only, exactly this shape, nothing before or after:
{"framing":"<wren one sentence + segue>","seed":"<2-3 sentences in user voice>"}`;

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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const world       = String(body.world       || '').trim().slice(0, FIELD_CAP);
  const blocker     = String(body.blocker     || '').trim().slice(0, FIELD_CAP);
  const stage       = String(body.stage       || '').trim().slice(0, FIELD_CAP);
  const description = String(body.description || '').trim().slice(0, DESC_CAP);

  if (!world || !blocker || !stage || !description) {
    return json(400, { error: 'world, blocker, stage, and description are all required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  const userPrompt = [
    `WORLD: ${world}`,
    `BLOCKER: ${blocker}`,
    `STAGE: ${stage}`,
    `IN THEIR OWN WORDS: ${description}`,
    '',
    'Produce the concept seed now. Two to three sentences. Their voice, not yours.',
  ].join('\n');

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-idea-generator] anthropic error', err);
    return json(502, { error: 'concept seed generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!raw) {
    return json(502, { error: 'concept seed was empty' });
  }

  // Parse the JSON the model returned. Be tolerant of leading/trailing
  // prose (some Claude responses wrap JSON in commentary even when told
  // not to) by extracting the first {...} block.
  let parsed = null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('[tg-idea-generator] could not parse model output', raw);
    return json(502, { error: 'concept seed output was not valid json' });
  }

  const framing = String(parsed.framing || '').trim();
  const seed    = String(parsed.seed    || '').trim();
  if (!framing || !seed) {
    return json(502, { error: 'model response missing framing or seed' });
  }

  return json(200, { framing, seed, blocker });
};
