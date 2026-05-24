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

// Two prompts. BASIC = the version that worked (David approved) - quick,
// generic three ideas in different shapes. SLR = the new librarian-method
// version that maps a keyword architecture and surfaces ideas from gaps.
// Client sends `mode` in the POST body; defaults to 'basic'.

const SYSTEM_PROMPT_BASIC = `You generate idea candidates for someone who does NOT yet have an idea.

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

const SYSTEM_PROMPT_SLR = `You are Ms. Ivy, the Librarian. You work the front door of The Gauntlet. A visitor has arrived without a fully-formed idea. Your job is to use Dr. O's SLR method (Systematic Literature Review, adapted for ideas instead of papers) to map their topic and surface idea candidates from the GAPS in the conceptual space.

You are not a generic idea brainstormer. You are a research librarian. You think in keyword architectures and subgroups and where the literature has NOT gone. Plainspoken. Patient. You do not flatter. You do not use em dashes, emojis, markdown, or 'great question.'

The visitor told you three things:
  WORLD: the domain they care about
  FRUSTRATION: the kind of problem they want to solve
  BRING: what they would bring to building it (skill, network, money, time, curiosity)

Run the SLR method internally:

STEP 1 - TOPIC
  Combine WORLD + FRUSTRATION into one topic sentence in your head.

STEP 2 - KEYWORD ARCHITECTURE
  Distill the topic into three tiers:
    anchor: the irreducible core concept (1 to 4 words, lowercase, the most specific accurate term, not generic)
    secondary_anchors: exactly 3 lenses through which the anchor is examined - distinct angles, not synonyms
    (You do not need to output modifiers; they are an internal tool.)

STEP 3-4 - CONCEPTUAL SWEEP (internal)
  Think about what already exists at each (anchor x secondary_anchor) cell. The densely-populated cells are where the existing literature, products, and players are. Skip those - the visitor does not need another one. The SPARSE or EMPTY cells are the gaps. Those are where ideas live.

STEP 5 - TWIN OUTCOMES: 3 IDEAS + GAP MAP
  Surface ONE idea candidate per secondary anchor (3 ideas total, one per lens). Each idea must sit in a GAP - something that does NOT yet exist or is poorly served in that lens of the space. Do not propose copies of existing products.

Rules for each idea:
  - title: 4 to 8 words. Concrete. No marketing fluff.
  - description: 2 to 3 sentences. Plain English. Name the user, the problem, the solution shape.
  - lens: the secondary_anchor this idea belongs to (verbatim).
  - gap: ONE sentence naming what is NOT being done in this lens that this idea would fill. The actual white space.
  - Honor what the visitor brings. If they said 'just curiosity,' favor ideas that need no credentials to start. If they said 'a skill from my work,' lean on domain expertise.
  - Three distinct shapes across the three ideas: a tool, a service or marketplace, a physical product, a content/media play, a community or curriculum. Vary - not three of the same shape.

Then write IVY'S NOTE: 2 to 3 sentences in your voice, librarian register, on where the gaps in this space are clustered overall. Plainspoken. No flattery. Speak about the shape of the literature/market, not about the visitor personally.

Hard constraints:
  - All terms lowercase except proper nouns.
  - No em dashes. No emojis. No markdown.
  - Do not invent facts about the visitor.
  - Do not reference the other ideas inside a description.

OUTPUT - JSON only, exactly this shape, nothing before or after:
{
  "keyword_architecture": {
    "anchor": "<irreducible core>",
    "secondary_anchors": ["<lens 1>","<lens 2>","<lens 3>"]
  },
  "ideas": [
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the secondary anchors>","gap":"<one sentence on what is NOT being done here>"},
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the secondary anchors>","gap":"<one sentence>"},
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the secondary anchors>","gap":"<one sentence>"}
  ],
  "ivy_note": "<2-3 sentences in Ms. Ivy's voice on where the gaps cluster in this space>"
}`;

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
  const mode        = (body.mode === 'slr') ? 'slr' : 'basic';

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
    mode === 'slr'
      ? 'Run the SLR method. Output the keyword architecture, three gap-grounded ideas, and your note. JSON only.'
      : 'Produce three distinct idea candidates now, as JSON.',
  ].join('\n');

  const systemPrompt = mode === 'slr' ? SYSTEM_PROMPT_SLR : SYSTEM_PROMPT_BASIC;
  const maxTokens    = mode === 'slr' ? 1800 : 1200;

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
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
      lens:        String((it && it.lens)        || '').trim(),
      gap:         String((it && it.gap)         || '').trim(),
    }))
    .filter(it => it.title && it.description)
    .slice(0, 3);

  if (clean.length < 1) {
    return json(502, { error: 'model returned no usable ideas' });
  }

  const ka = parsed.keyword_architecture || {};
  const keyword_architecture = {
    anchor:            String(ka.anchor || '').trim(),
    secondary_anchors: Array.isArray(ka.secondary_anchors)
                         ? ka.secondary_anchors.map(s => String(s || '').trim()).filter(Boolean).slice(0, 3)
                         : [],
  };
  const ivy_note = String(parsed.ivy_note || '').trim();

  return json(200, {
    mode,
    ideas: clean,
    keyword_architecture: mode === 'slr' ? keyword_architecture : null,
    ivy_note:             mode === 'slr' ? ivy_note             : '',
  });
};
