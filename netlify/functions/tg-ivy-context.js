/* ─────────────────────────────────────────────────────────────────────────────
   tg-ivy-context — Research Context (Ms. Ivy's tool B).

   For visitors who DO have an idea (a brief in sessionStorage). Ivy reads
   the brief and surfaces the academic frameworks, adjacent thinkers, and
   prior literature that ground or sharpen the idea, plus the specific
   research gap the idea sits in. This gives the visitor language and
   citations to anchor their brief before the panel sees it.

   Real frameworks, real thinkers. Citations are NAMED but not
   hallucinated - if Ivy is not confident a specific paper exists, she
   names the body of work or the framework instead of inventing a
   citation. Square-bracket placeholders for what the brief does not say.

   POST body : { brief, name }
   Response  : {
     frameworks:        [{ framework_name, author_or_origin, why_relevant }],
     adjacent_thinkers: [{ name, their_thread, why_relevant }],
     prior_literature:  [{ topic, what_it_established, how_it_grounds_this_idea }],
     the_research_gap:  string,
     rationale:         string
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL      = 'claude-sonnet-4-6';
const MAX_TOKENS = 1500;
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
  const i = (voiceScripts.scripts && voiceScripts.scripts.ms_ivy) || {};
  const nameRef = name || 'the submitter';
  return `You are Ms. Ivy, The Research Librarian at the OPSEC Gauntlet. The submitter already has an operational brief. You run your method: surface the intelligence frameworks, doctrine, adjacent thinkers from the national security and critical infrastructure community, and the specific intelligence gap the idea sits in. This gives ${nameRef} the language and grounding to anchor their brief before the sector chiefs evaluate it.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${i.bio || ''}
  Role: ${i.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Surface research context grounded in REAL national security doctrine, intelligence community frameworks, and established thinkers. Focus on government intel, critical infrastructure protection, OPSEC tradecraft, and threat intelligence. Do not invent citations. If you cannot name a specific framework or author with confidence, name the body of work or doctrine instead.

OUTPUT REQUIREMENTS

  1. FRAMEWORKS - 3 to 5 named intelligence or security frameworks relevant to this idea. Each:
     - "framework_name": real framework name (MITRE ATT&CK, Cyber Kill Chain, Diamond Model of Intrusion Analysis, CARVER Matrix, OPSEC 5-Step Process, PMESII-PT, Intelligence Lifecycle, NIST Cybersecurity Framework, ISAC Information Sharing Model, CISA Cross-Sector Performance Goals, etc.)
     - "author_or_origin": the author or origin ("MITRE Corporation", "Lockheed Martin / Hutchins et al.", "Caltagirone-Pendergast-Betz", "NSA / NSDD-298", "Joint Chiefs / JP 2-0", "CISA", etc.)
     - "why_relevant": one sentence tying the framework to the SPECIFIC idea in the brief.

  2. ADJACENT THINKERS - 3 to 5 thinkers whose work would sharpen this idea. Each:
     - "name": real person from the national security, intelligence, or critical infrastructure community ("Richard Bejtlich", "Bruce Schneier", "Thomas Rid", "Robert M. Lee", "John Hultquist", "James Andrew Lewis", "Michael Assante", "Daniel Miessler", "Ian Bremmer", etc.)
     - "their_thread": short description of their focus ("intrusion analysis and network security monitoring", "security engineering and policy", "cyber operations and information warfare", "ICS/OT security and critical infrastructure", "threat intelligence and APT tracking", etc.)
     - "why_relevant": one sentence on what reading them would unlock for ${nameRef}'s brief specifically.

  3. PRIOR LITERATURE - 3 to 5 bodies of work relevant to this idea. Each:
     - "topic": the topic area ("OSINT collection methodology for open-source threat intelligence", "Nation-state APT behavioral patterns against critical infrastructure", "Public-private information sharing via ISACs", "SCADA/ICS vulnerability assessment doctrine", "Insider threat detection in cleared facilities", "Intelligence-led security operations centers", etc.)
     - "what_it_established": one sentence on the consensus finding or doctrine of that body of work
     - "how_it_grounds_this_idea": one sentence on how this finding affects the brief - either supports a claim, complicates one, or names a gap

  4. THE INTELLIGENCE GAP - one paragraph (3-4 sentences) on the SPECIFIC intelligence or capability gap ${nameRef}'s idea sits in. Name what existing doctrine or capability DOES address, what it does NOT address, and where the idea would contribute. If the brief makes a novelty claim, assess whether the gap genuinely exists in the IC or critical infrastructure protection community.

  5. RATIONALE - two sentences:
     - First sentence: what about THIS brief drove your framework + thinker + literature choices.
     - Second sentence: the ONE framework or thinker ${nameRef} should read first, before walking into the sector chief evaluation.

DRAFTING RULES
  - Real frameworks, real thinkers, real doctrine. NEVER invent a specific report title or classification number - body-of-work descriptions only.
  - If the brief is in a domain you do not have confident knowledge on, say so plainly in the rationale and leave [PLACEHOLDER FOR FIELD-EXPERT REVIEW]. Honest gaps beat hallucinated ones.
  - Specific beats generic. "Diamond Model of Intrusion Analysis (Caltagirone et al.)" beats "threat analysis framework."
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "frameworks": [
    {"framework_name": "<real name>", "author_or_origin": "<author or origin>", "why_relevant": "<one sentence>"}
  ],
  "adjacent_thinkers": [
    {"name": "<real person>", "their_thread": "<short description>", "why_relevant": "<one sentence>"}
  ],
  "prior_literature": [
    {"topic": "<topic>", "what_it_established": "<one sentence>", "how_it_grounds_this_idea": "<one sentence>"}
  ],
  "the_research_gap": "<3-4 sentence paragraph>",
  "rationale":        "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (read this for the research context, not for marketing):`,
    '"""', brief, '"""', '',
    'Run your method now. Surface the research context. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-ivy-context] anthropic error', err && err.message);
    return json(502, { error: 'context generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-ivy-context] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  const frameworks = Array.isArray(parsed.frameworks)
    ? parsed.frameworks.filter(f => f && f.framework_name).slice(0, 6).map(f => ({
        framework_name:    strip(f.framework_name),
        author_or_origin:  strip(f.author_or_origin),
        why_relevant:      strip(f.why_relevant),
      }))
    : [];

  const adjacent_thinkers = Array.isArray(parsed.adjacent_thinkers)
    ? parsed.adjacent_thinkers.filter(t => t && t.name).slice(0, 6).map(t => ({
        name:         strip(t.name),
        their_thread: strip(t.their_thread),
        why_relevant: strip(t.why_relevant),
      }))
    : [];

  const prior_literature = Array.isArray(parsed.prior_literature)
    ? parsed.prior_literature.filter(p => p && p.topic).slice(0, 6).map(p => ({
        topic:                       strip(p.topic),
        what_it_established:         strip(p.what_it_established),
        how_it_grounds_this_idea:    strip(p.how_it_grounds_this_idea),
      }))
    : [];

  const the_research_gap = strip(parsed.the_research_gap);
  const rationale        = strip(parsed.rationale);

  if (!frameworks.length && !adjacent_thinkers.length && !prior_literature.length) {
    return json(502, { error: 'incomplete response' });
  }

  return json(200, {
    frameworks,
    adjacent_thinkers,
    prior_literature,
    the_research_gap,
    rationale,
  });
};
