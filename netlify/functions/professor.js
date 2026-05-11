/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — The Professor (research librarian)
   Fact-check, period accuracy, technical authenticity.

   POST body : {
     mode: 'ask' | 'period_check' | 'technical_check',
     payload: {
       // ask:            { question }
       // period_check:   { passage, setting } — setting is "1922 Paris" etc.
       // technical_check: { passage, domain }  — domain is "courtroom procedure" etc.
     }
   }
   Auth      : Bearer token
   Cost      : 2 credits
   Response  : varies by mode (always includes confidence + verify_sources).
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const COST  = 2;
const PASSAGE_CAP = 6000;
const QUESTION_CAP = 1500;

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

  const { mode, payload = {} } = body;
  if (!['ask', 'period_check', 'technical_check'].includes(mode)) {
    return json(400, { error: 'Invalid mode' });
  }

  // Validate payload per mode
  if (mode === 'ask') {
    if (!payload.question || typeof payload.question !== 'string') return json(400, { error: 'Missing question' });
    if (payload.question.length > QUESTION_CAP) return json(413, { error: `Question too long. Max ${QUESTION_CAP} chars.` });
  } else {
    if (!payload.passage || typeof payload.passage !== 'string') return json(400, { error: 'Missing passage' });
    if (payload.passage.length > PASSAGE_CAP) return json(413, { error: `Passage too long. Max ${PASSAGE_CAP} chars.` });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY || !ANTHROPIC_KEY) {
    return json(500, { error: 'Server not configured' });
  }
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: userData, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !userData?.user) return json(401, { error: 'Invalid session' });
  const userId = userData.user.id;

  const { data: balRow, error: balErr } = await supabase
    .from('gp_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();
  if (balErr) return json(500, { error: 'Could not load credits' });
  const balance = balRow?.balance ?? 0;
  if (balance < COST) return json(402, { error: 'Insufficient credits', needed: COST, have: balance });

  const baseSystem = `You are the Professor — a research librarian at Greylander Press. Tweed jacket, magnifying glass, classical training. You know history, technical procedure, period detail, and how to verify what you do not know.

CORE RULES:
1. Honesty over confidence. Your training has a cutoff and you can be wrong. Rate every answer's confidence: HIGH (well-established historical / technical fact), MEDIUM (likely correct, worth verifying), LOW (uncertain or contested).
2. Never invent specifics you do not know. No fabricated dates, names, or quotations.
3. Always recommend at least one verification source — a reference work, archive, monograph, or expert domain (e.g., "consult a period-specific Oxford Handbook" / "verify with the FBI's published procedural manual").
4. State limits clearly. If you don't know, say so plainly: "I am uncertain. Verify with X."
5. Never use em dashes (—). Use periods, commas, colons, or short sentences.
6. Do not hedge ("I think", "in my opinion"). State what you know, rate it, and say where to verify.

Return ONLY a JSON object — no markdown fence, no preamble. Schema varies by mode (see user prompt).`;

  let userPrompt;
  if (mode === 'ask') {
    userPrompt = `MODE: ASK
QUESTION: ${payload.question}

Return JSON with this exact shape:
{
  "answer":           "your direct answer in 2-5 sentences",
  "confidence":       "HIGH" | "MEDIUM" | "LOW",
  "context":          "1-3 sentences of useful supporting context",
  "verify_sources":   ["specific source 1", "specific source 2"],
  "caveats":          "1-2 sentences on what you are NOT sure about, or empty string"
}`;
  } else if (mode === 'period_check') {
    userPrompt = `MODE: PERIOD CHECK
SETTING: ${payload.setting || '(not specified — infer from passage)'}

PASSAGE TO CHECK:
---
${payload.passage}
---

Identify anachronisms — anything (object, word, idiom, technology, custom, food, attitude) that does not fit the stated setting. Return JSON:
{
  "overall_assessment": "1-2 sentences on whether the passage feels period-accurate overall",
  "issues": [
    {
      "passage_quote":   "the exact phrase from the passage that has a problem",
      "problem":         "what is anachronistic and why",
      "suggestion":      "a period-appropriate alternative or a verification path",
      "confidence":      "HIGH" | "MEDIUM" | "LOW"
    }
  ],
  "verify_sources":     ["one or two reference suggestions"]
}
If you find no anachronisms, return an empty issues array and say so in overall_assessment.`;
  } else if (mode === 'technical_check') {
    userPrompt = `MODE: TECHNICAL CHECK
DOMAIN: ${payload.domain || '(not specified — infer from passage)'}

PASSAGE TO CHECK:
---
${payload.passage}
---

Identify procedural / technical errors in the stated domain (e.g., courtroom procedure, police interrogation, medical scene, firearms handling, sailing, surgery). Return JSON:
{
  "overall_assessment": "1-2 sentences on whether the passage is technically credible",
  "issues": [
    {
      "passage_quote":   "the exact phrase from the passage that has a problem",
      "problem":         "what is technically wrong and why",
      "suggestion":      "the correct procedure / detail, or a verification path",
      "confidence":      "HIGH" | "MEDIUM" | "LOW"
    }
  ],
  "verify_sources":     ["one or two specific authoritative sources for this domain"]
}
If no issues, return an empty issues array and say so in overall_assessment.`;
  }

  let parsed;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0.2,
      system: baseSystem,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const raw = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
  } catch (err) {
    console.error('[professor] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const newBalance = balance - COST;
  const { error: updErr } = await supabase
    .from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, {
    mode,
    result: parsed,
    credits_remaining: newBalance,
  });
};
