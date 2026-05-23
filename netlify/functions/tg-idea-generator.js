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

const SYSTEM_PROMPT = `You are a concept seeder for The Gauntlet, a serious idea evaluation platform. A user has answered four questions to help articulate an idea they cannot yet name on their own.

Your job: produce a single concept seed.

Rules:
- 2 to 3 sentences. No more.
- Written in plain declarative prose, in the USER'S voice — not yours. No "Here is your seed", no "What you have is...", no preamble, no commentary, no flattery.
- First sentence names the problem or friction the user is responding to.
- Second sentence names a possible direction or shape the idea could take.
- Optional third sentence names the audience or the stakes.
- Use the user's own words and register where you can. Do not lecture.
- Do not invent facts about the user that they did not provide.
- No emojis. No em dashes. No markdown.

Output the seed text only. Nothing else.`;

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

  const seed = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!seed) {
    return json(502, { error: 'concept seed was empty' });
  }

  return json(200, { seed, blocker });
};
