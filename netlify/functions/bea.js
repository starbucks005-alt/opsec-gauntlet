/* ─────────────────────────────────────────────────────────────────────────────
   Greylander Press — Bea (Beatriz), the Copy Editor

   Bea is the mechanical-craft sister to Grey's creative-craft work. She fixes
   grammar, punctuation, agreement, and typos. She does NOT flatten voice,
   dialect, vernacular, or deliberate stylistic choices. When in doubt, she
   asks ("Query") rather than overwrites.

   POST body : {
     chapter:     string (required, ≤15000 chars),
     editPass:    'standard' | 'dialect' | 'period' | 'urban' (default 'standard'),
     styleGuide:  'cmos' | 'ap' | 'author' (default 'cmos'),
     voiceNotes?: string (optional — character-voice instructions),
     chapterTitle?: string (optional)
   }
   Auth      : Bearer token (Supabase JWT)
   Cost      : 5 credits per chapter
   Response  : {
     editedText:  string  — clean edited chapter,
     changeLog:   array of { before, after, reason },
     queries:     array of { passage, question }  — your-call decisions,
     notes:       string  — Bea's overall closing note,
     credits_remaining: number
   }
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');

const MODEL = 'claude-sonnet-4-6';
const COST  = 5;
const INPUT_CAP = 15000;

const PASS_INSTRUCTIONS = {
  standard: `STANDARD COPY EDIT.
Fix: grammar, subject-verb agreement, punctuation, comma splices, run-ons, dangling modifiers, typos, capitalization, tense consistency, pronoun reference.
Do NOT change: word choice, sentence rhythm, paragraph structure, or anything stylistic. If the author chose a fragment for effect, leave it.`,

  dialect: `DIALECT-PRESERVING COPY EDIT.
Critical: this manuscript uses dialect, vernacular, AAVE, regional speech, or non-standard grammar AS CRAFT. Your job is to preserve every deliberate choice while fixing actual mistakes.
Rules:
1. In dialogue: do NOT correct dialect, contractions, dropped consonants, or non-standard grammar that is consistent with the character's voice. "We was going" stays. "Ain't" stays. Dropped 'g' stays.
2. In close-third or first-person narration that mirrors the character's voice: same rule. If the narrator's grammar is the character's, leave it.
3. In objective narration (omniscient, distant third): apply standard grammar rules.
4. Fix real typos and obvious slips even in dialect (e.g., a word missing a letter that breaks meaning).
5. When uncertain whether a "mistake" is dialect or error: do NOT change it. File a Query.`,

  period: `PERIOD-PRESERVING COPY EDIT.
The manuscript is set in a historical period and uses period-appropriate language. Preserve archaic word choice, period idiom, and historical syntax.
Rules:
1. Do not modernize vocabulary. "Forsooth" stays. "Whilst" stays. Period-appropriate spellings stay.
2. Do not flag period-correct usage as error.
3. Fix only mechanical errors (real typos, accidental anachronisms that conflict with the established voice).
4. When uncertain, file a Query.`,

  urban: `URBAN / CONTEMPORARY VERNACULAR COPY EDIT.
The manuscript uses urban / contemporary vernacular, slang, code-switching, or genre-specific register as craft.
Rules:
1. Preserve slang, code-switching, contractions, and non-standard punctuation that serves voice.
2. Preserve deliberate sentence fragments and rhythm.
3. Fix actual mechanical errors (typos, agreement breaks that aren't deliberate, missing words).
4. Do not "translate" vernacular to standard register.
5. When uncertain, file a Query.`,
};

const STYLE_GUIDES = {
  cmos:   'Apply Chicago Manual of Style (17th ed.) for punctuation, treatment of numbers, hyphenation, and serial comma (yes to Oxford comma).',
  ap:     'Apply AP Style for punctuation and capitalization (no Oxford comma unless required for clarity, lowercase titles after names).',
  author: 'Honor the author\'s established style choices. If a stylistic pattern is consistent across the chapter, treat it as the author\'s style guide and apply it consistently.',
};

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

  const { chapter, editPass = 'standard', styleGuide = 'cmos', voiceNotes, chapterTitle } = body;
  if (!chapter || typeof chapter !== 'string') return json(400, { error: 'Missing chapter text' });
  if (chapter.length > INPUT_CAP) {
    return json(413, { error: `Chapter too long. Max ${INPUT_CAP} chars; received ${chapter.length}.` });
  }
  if (!PASS_INSTRUCTIONS[editPass]) return json(400, { error: 'Invalid editPass' });
  if (!STYLE_GUIDES[styleGuide])    return json(400, { error: 'Invalid styleGuide' });

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

  const passInstr  = PASS_INSTRUCTIONS[editPass];
  const guideInstr = STYLE_GUIDES[styleGuide];
  const voiceLine  = voiceNotes ? `\n\nAUTHOR'S VOICE NOTES (apply alongside the pass rules):\n${String(voiceNotes).slice(0, 2000)}` : '';
  const titleLine  = chapterTitle ? `\nCHAPTER: ${chapterTitle}` : '';

  const system = `You are Beatriz — Bea — a senior copy editor at Greylander Press. Reference-desk librarian energy: precise, well-read, warm but exact. You read CMOS for fun. You respect voice. You do not flatten dialect, vernacular, or craft choices into Standard English. You fix what is broken, ask before touching what is craft, and say so plainly when you do.

YOUR PASS RULES FOR THIS JOB:
${passInstr}

YOUR STYLE GUIDE:
${guideInstr}

OUTPUT FORMAT — return ONLY a JSON object with this exact shape, no markdown fence, no preamble:
{
  "editedText": "the full edited chapter, plain text, paragraphs preserved with single newlines between paragraphs",
  "changeLog": [
    { "before": "the original phrase", "after": "the edited phrase", "reason": "one-line explanation" }
    /* up to 30 of the most significant changes; do not list every comma fix individually — group them */
  ],
  "queries": [
    { "passage": "exact passage you flagged", "question": "your specific question to the author" }
    /* decisions where you intentionally did NOT edit because you suspect craft, but want the author to confirm */
  ],
  "notes": "1–3 sentence closing note from Bea — overall observations about mechanical patterns (e.g., 'You consistently use the British spelling \\"colour\\" — kept consistent throughout.'). No flattery."
}

HARD RULES:
- Never use em dashes (—) in your notes. Periods, commas, colons, or short sentences.
- Do not hedge. State what you did and why.
- Do not flatten voice. When in doubt, file a Query rather than overwriting.
- Return valid JSON. No trailing commas. No markdown fence.`;

  const user = `${titleLine}${voiceLine}

CHAPTER TO EDIT:
---
${chapter}
---

Return the JSON object now.`;

  let parsed;
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      temperature: 0.2,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const raw = (resp.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const clean = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/, '').trim();
    parsed = JSON.parse(clean);
    if (typeof parsed.editedText !== 'string') throw new Error('editedText missing');
    if (!Array.isArray(parsed.changeLog)) parsed.changeLog = [];
    if (!Array.isArray(parsed.queries))   parsed.queries   = [];
    if (typeof parsed.notes !== 'string') parsed.notes = '';
  } catch (err) {
    console.error('[bea] AI error', err);
    return json(502, { error: err?.message || 'AI provider error' });
  }

  const newBalance = balance - COST;
  const { error: updErr } = await supabase
    .from('gp_credits')
    .update({ balance: newBalance })
    .eq('user_id', userId);
  if (updErr) return json(500, { error: 'Could not deduct credits' });

  return json(200, {
    editedText: parsed.editedText,
    changeLog:  parsed.changeLog,
    queries:    parsed.queries,
    notes:      parsed.notes,
    credits_remaining: newBalance,
  });
};
