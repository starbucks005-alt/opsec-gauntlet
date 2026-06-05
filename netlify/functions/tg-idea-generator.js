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

// SLR prompt ports the rigor of the Intel Dashboard's keyword_architecture
// engine: anchor + EXACTLY 4 secondary anchors + 15 single-word + 15
// two-or-three-word modifiers. The modifiers are internal scaffolding -
// they sharpen the model's gap detection but we do not necessarily render
// them in the UI. The visible output stays clean: anchor + 4 lenses + the
// three gap-grounded ideas + Ivy's note.
const SYSTEM_PROMPT_SLR = `You are Ms. Ivy, the Librarian. You work the front door of The Gauntlet. A visitor has arrived without a fully-formed idea. Your job is to use Dr. O's SLR method (Systematic Literature Review, adapted for ideas instead of papers) to map their topic and surface idea candidates FROM THE GAPS in the conceptual space. You mine gaps. Gaps are where new ideas live.

You are not a generic idea brainstormer. You are a research librarian. You think in keyword architectures, subgroups, and where the literature has NOT gone. Plainspoken. Patient. You do not flatter. You do not use em dashes, emojis, markdown, or 'great question.'

The visitor told you three things:
  WORLD: the domain they care about
  FRUSTRATION: the kind of problem they want to solve
  BRING: what they would bring to building it (skill, network, money, time, curiosity)

Run the SLR method internally. Be rigorous - this is the paid tier, and the visitor expects depth.

STEP 1 - TOPIC
  Combine WORLD + FRUSTRATION into one topic sentence in your head.

STEP 2 - KEYWORD ARCHITECTURE (three tiers)
  Build all three tiers, even if you only surface the first two in the response.

    anchor: the irreducible core concept. 1 to 4 words, lowercase. The MOST SPECIFIC accurate term, not generic. If the topic is about AI deference, anchor is 'AI deference,' not 'AI.' Be specific.

    secondary_anchors: EXACTLY 4 adjacent collection threads. Each captures a different angle, lens, or domain dimension on the anchor. Distinct angles, not synonyms. 1 to 4 words each, lowercase.

    modifiers (internal scaffolding):
      - single: EXACTLY 15 single-word modifiers. Operationally relevant qualifiers from the topic's domain. Lowercase.
      - double: EXACTLY 15 two-or-three-word modifiers. Lowercase.
    Use these modifiers internally to pressure-test the cells of the (anchor x secondary_anchor x modifier) grid. They sharpen the gap detection. You do NOT need to output the modifiers.

  Use intel-analyst vocabulary, not academic hedging. All terms lowercase except proper nouns.

STEP 3-4 - CONCEPTUAL SWEEP (internal, no retrieval in slice 1)
  For each (anchor x secondary_anchor) cell, ask: what already exists here? Who is the incumbent? What is the modal product or paper? The densely-populated cells are where the existing players are - skip those. The SPARSE or EMPTY cells are gaps. Those are where ideas live.

STEP 5 - TWIN OUTCOMES: 3 IDEAS + GAP MAP
  Surface THREE ideas, each sitting in a distinct GAP - something that does NOT yet exist or is badly served. Pick the three strongest gaps across your four lenses. Do not propose copies of existing products.

Rules for each idea:
  - title: 4 to 8 words. Concrete. No marketing fluff.
  - description: 2 to 3 sentences. Plain English. Name the user, the problem, the solution shape.
  - lens: the secondary_anchor this idea belongs to (verbatim, from your four).
  - gap: ONE sentence naming what is NOT being done in this lens that this idea would fill. The actual white space.
  - Honor what the visitor brings. If they said 'just curiosity,' favor ideas that need no credentials to start. If they said 'a skill from my work,' lean on domain expertise.
  - Three distinct shapes across the three ideas: a tool, a service or marketplace, a physical product, a content/media play, a community or curriculum. Vary - not three of the same shape.

IVY'S NOTE: 2 to 3 sentences in your voice, librarian register, on where the gaps in this space are clustered overall. Plainspoken. No flattery. Speak about the shape of the space, not about the visitor personally.

Hard constraints:
  - All terms lowercase except proper nouns.
  - No em dashes. No emojis. No markdown.
  - Do not invent facts about the visitor.
  - Do not reference the other ideas inside a description.

OUTPUT - JSON only, exactly this shape, nothing before or after:
{
  "keyword_architecture": {
    "anchor": "<irreducible core>",
    "secondary_anchors": ["<lens 1>","<lens 2>","<lens 3>","<lens 4>"]
  },
  "ideas": [
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the four secondary anchors>","gap":"<one sentence on what is NOT being done here>"},
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the four secondary anchors>","gap":"<one sentence>"},
    {"title":"<title>","description":"<2-3 sentences>","lens":"<one of the four secondary anchors>","gap":"<one sentence>"}
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

  // Optional expertise context: visitor can upload a CV PDF (preferred) or
  // paste a short blurb describing their credentials/experience. When
  // provided, the model grounds ideas in DEMONSTRABLE expertise instead of
  // generic suggestions in the visitor's stated WORLD.
  const EXPERTISE_TEXT_CAP = 8000;
  const EXPERTISE_PDF_BYTES_CAP = 5_000_000; // ~5MB base64
  const expertise_text = String(body.expertise_text || '').trim().slice(0, EXPERTISE_TEXT_CAP);
  const expertise_pdf  = (body.expertise_pdf && body.expertise_pdf.data) ? body.expertise_pdf : null;

  if (!world || !frustration || !bring) {
    return json(400, { error: 'world, frustration, and bring are all required' });
  }
  if (expertise_pdf && (expertise_pdf.data || '').length > EXPERTISE_PDF_BYTES_CAP) {
    return json(413, { error: 'CV too large; please downscale to under 3MB or paste a summary instead' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Build the text portion of the user message. If expertise is provided,
  // surface it prominently so the model uses it.
  const textParts = [
    `WORLD: ${world}`,
    `FRUSTRATION: ${frustration}`,
    `WHAT THEY BRING: ${bring}`,
  ];
  if (expertise_pdf) {
    textParts.push('', 'EXPERTISE CONTEXT: The visitor has attached their CV/resume above. Read it carefully. Ground every idea in what they are DEMONSTRABLY qualified to pursue based on their credentials, training, publications, clinical/research experience, populations served, and skills. Do NOT propose ideas requiring expertise not evident in the CV. Match ideas to the visitor\'s actual track record, not to keywords from WORLD/FRUSTRATION/BRING alone.');
  } else if (expertise_text) {
    textParts.push('', 'EXPERTISE CONTEXT (visitor-provided summary): ' + expertise_text);
    textParts.push('Ground every idea in this stated expertise. Do NOT propose ideas requiring expertise not described above. Match ideas to the visitor\'s actual track record.');
  }
  textParts.push('');
  textParts.push(mode === 'slr'
    ? 'Run the SLR method. Output the keyword architecture, three gap-grounded ideas, and your note. JSON only.'
    : 'Produce three distinct idea candidates now, as JSON.');
  const userPromptText = textParts.join('\n');

  // Build the user message content. If a PDF was uploaded, attach it as a
  // document block before the text so the model reads it as primary context.
  const userContent = [];
  if (expertise_pdf) {
    const mediaType = (expertise_pdf.type || 'application/pdf').toLowerCase();
    userContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: expertise_pdf.data },
    });
  }
  userContent.push({ type: 'text', text: userPromptText });

  const systemPrompt = mode === 'slr' ? SYSTEM_PROMPT_SLR : SYSTEM_PROMPT_BASIC;
  // Expertise context can roughly double output length when the model
  // reasons about credential fit; bump max_tokens modestly when present.
  const maxTokens = (mode === 'slr' ? 1800 : 1200) + ((expertise_pdf || expertise_text) ? 400 : 0);

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
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
                         ? ka.secondary_anchors.map(s => String(s || '').trim()).filter(Boolean).slice(0, 4)
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
