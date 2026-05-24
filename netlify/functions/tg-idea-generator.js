/* ─────────────────────────────────────────────────────────────────────────────
   tg-idea-generator — IDEA generator for the homepage 'Help me find an idea'
   modal.

   Pure tool: no character voice, no persona, no flattery. The user does NOT
   bring an idea. They tell us about themselves and the world they care
   about. Claude returns 3 distinct candidate ideas the user can pick from
   and bring to the Chamber.

   POST body : {
     world:       string (required) — domain they care about (Technology, Health...)
     frustration: string (required) — the kind of problem they want to solve
     bring:       string (required) — what they would bring to building it
   }
   Auth      : none (anonymous tool)
   Response  : {
     ideas: [
       { title: string, description: string }, // 3 of these, distinct shapes
       ...
     ]
   }
   Env vars  : ANTHROPIC_API_KEY (required)
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;

const MODEL = 'claude-sonnet-4-6';
const FIELD_CAP = 500;

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

const SYSTEM_PROMPT = `You generate idea candidates for someone who does NOT yet have an idea.

They told you three things:
  - WORLD: the domain they care about
  - FRUSTRATION: the kind of problem they want to solve
  - BRING: what they would bring to building it (skill, network, money, time, curiosity)

Your job: produce THREE distinct idea candidates they could build on.

Rules for each idea:
  - title: 4-8 words, concrete, no marketing fluff, no exclamation marks
  - description: 2 to 3 sentences. Plain English. Name the user/customer, name the problem, sketch the shape of the solution. No insider jargon.
  - The three ideas must be DIFFERENT SHAPES, not three variations of the same product. Pick from: (a) a software tool, (b) a service or marketplace, (c) a physical product or device, (d) a content/media play, (e) a community or curriculum. Use three different shapes across the three ideas.
  - All three ideas should fit the user's stated WORLD and respond to their stated FRUSTRATION.
  - Use what the user brings. If they said 'a skill from my work,' lean on domain expertise. If they said 'just curiosity,' lean on ideas that do not need credentials to start.

Hard constraints:
  - No em dashes. No emojis. No markdown.
  - No flattery. No 'great question.' No 'your interest in X is fascinating.'
  - Do not invent facts about the user that they did not provide.
  - Each idea stands on its own. Do not reference the other two.

OUTPUT - JSON only, exactly this shape, nothing before or after:
{"ideas":[{"title":"<title>","description":"<2-3 sentences>"},{"title":"<title>","description":"<2-3 sentences>"},{"title":"<title>","description":"<2-3 sentences>"}]}`;

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
  const frustration = String(body.frustration || '').trim().slice(0, FIELD_CAP);
  const bring       = String(body.bring       || '').trim().slice(0, FIELD_CAP);

  if (!world || !frustration || !bring) {
    return json(400, { error: 'world, frustration, and bring are all required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  const userPrompt = [
    `WORLD: ${world}`,
    `FRUSTRATION: ${frustration}`,
    `WHAT THEY BRING: ${bring}`,
    '',
    'Produce three distinct idea candidates now, as JSON.',
  ].join('\n');

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-idea-generator] anthropic error', err);
    return json(502, { error: 'idea generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!raw) {
    return json(502, { error: 'ideas were empty' });
  }

  // Tolerant JSON parse: extract first {...} block in case the model wraps
  // its output in commentary.
  let parsed = null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch (err) {
    console.error('[tg-idea-generator] could not parse model output', raw);
    return json(502, { error: 'idea output was not valid json' });
  }

  const ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  const clean = ideas
    .map(it => ({
      title:       String((it && it.title)       || '').trim(),
      description: String((it && it.description) || '').trim(),
    }))
    .filter(it => it.title && it.description)
    .slice(0, 3);

  if (clean.length < 1) {
    return json(502, { error: 'model returned no usable ideas' });
  }

  return json(200, { ideas: clean });
};
