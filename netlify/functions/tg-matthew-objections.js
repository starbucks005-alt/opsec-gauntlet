/* ─────────────────────────────────────────────────────────────────────────────
   tg-matthew-objections — Objection Map generator (Matthew's tool B).

   Downstream of the Buyer Psychology Profile. Reads the visitor's brief
   and surfaces the silent unconscious objections the customer will raise
   in their own head when they encounter this product. Each objection is
   tied to the underlying emotional driver (so it lines up with the
   profile's drivers), and each comes with a message-level reframe that
   acknowledges the resistance and redirects it.

   POST body : { brief, name }
   Response  : {
     objections: [{ the_objection, underlying_driver, the_reframe, reframe_in_action }],
     one_that_kills_it: string,
     rationale: string
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

// Same emotional drivers Matthew uses in the Buyer Psychology Profile
// so the two outputs line up directly when both are run.
const VALID_DRIVERS = new Set([
  'status', 'control', 'belonging', 'identity', 'fear',
  'certainty', 'novelty', 'care', 'vindication', 'mastery',
]);

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
  const m = (voiceScripts.scripts && voiceScripts.scripts.matthew_vance) || {};
  const nameRef = name || 'the founder';
  return `You are Matthew Vance, The Behaviorist at The Gauntlet. You build objection maps for founders who underestimate how much of their customer's NO happens silently, before any conversation, in the customer's own head.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${m.bio || ''}
  Role: ${m.role || ''}

YOUR JOB
  Read ${nameRef}'s brief. Surface 5-8 unconscious objections the customer will raise in their own head when they encounter this product. Customers do not articulate these out loud. They show up as "I'll think about it," "send me more info," "we already use X," and the silent close of the tab. You name them, tie them to the underlying emotional driver, and write the reframe that acknowledges the resistance and redirects it.

OUTPUT REQUIREMENTS

  1. OBJECTIONS - 5 to 8 unconscious objections. Each:
     - "the_objection": short, in the CUSTOMER'S voice. First-person, conversational. NOT marketing speak. ("I don't have time for another app." "This looks expensive." "We already use [adjacent tool]." "I'm not technical enough." "What if it doesn't work?" "How do I explain this to my team?" "Is this going to break next quarter?")
     - "underlying_driver": one of "status" | "control" | "belonging" | "identity" | "fear" | "certainty" | "novelty" | "care" | "vindication" | "mastery". Pick the emotional driver this objection springs from. Same driver list as the Buyer Psychology Profile.
     - "the_reframe": one sentence on how to acknowledge AND redirect the objection. Message-level, not pricing-level. The reframe is what the marketing copy / sales call should say to dissolve the objection, not undercut it.
     - "reframe_in_action": one sentence naming a SPECIFIC place the reframe should live. (e.g., "Landing page hero, second line", "Demo opener, before the first feature mention", "FAQ entry, top 3 above the fold", "Sales-call discovery question that surfaces this exact concern", "Onboarding email 2 of 5").

  2. ONE THAT KILLS IT - the single SILENT dealbreaker most likely to block conversion. The objection the customer never says out loud but that ends every conversation. One sentence describing the objection, plus one sentence on why this is the killer.

  3. RATIONALE - Two sentences:
     - First sentence: what about THIS brief - the customer, the category, the framing - drove your selection of these specific objections.
     - Second sentence: the one objection ${nameRef} should address FIRST in their messaging, and where.

DRAFTING RULES
  - Objections are in the CUSTOMER'S voice. First-person, conversational, the words the customer would actually use in their own head. NOT analyst summaries.
  - Tie every objection to a real driver from the list. The driver list lines up with the Buyer Psychology Profile - if both are run, the visitor can see which drivers create which objections.
  - Specific over abstract. "I'll have to retrain three people on this" beats "Adoption friction."
  - Reframes acknowledge first, redirect second. Never dismiss the objection ("That's not really an issue because..."). Always name it ("That's a real concern. Here is what changes when you...").
  - Use [SQUARE BRACKET PLACEHOLDERS] when the brief lacks the input.
  - No em dashes. Plain hyphens.
  - Pure JSON output. No prose around the JSON.

OUTPUT JSON:
{
  "objections": [
    {
      "the_objection":      "<customer voice, first-person>",
      "underlying_driver":  "<one of the valid drivers>",
      "the_reframe":        "<acknowledge + redirect, one sentence>",
      "reframe_in_action":  "<specific place this lives, one sentence>"
    }
  ],
  "one_that_kills_it": "<the silent dealbreaker, two sentences>",
  "rationale":         "<two sentences as described>"
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
    `THE FOUNDER'S BRIEF (read this for the silent NO - what stops the customer in their own head):`,
    '"""', brief, '"""', '',
    'Map the objections now. JSON only.',
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL, max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(name),
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-matthew-objections] anthropic error', err && err.message);
    return json(502, { error: 'objection map generation failed' });
  }

  const raw = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-matthew-objections] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const strip = s => String(s || '').replace(/—/g, '-').replace(/–/g, '-').trim();

  const objections = Array.isArray(parsed.objections)
    ? parsed.objections
        .filter(o => o && o.the_objection && o.the_reframe)
        .slice(0, 10)
        .map(o => ({
          the_objection:     strip(o.the_objection),
          underlying_driver: VALID_DRIVERS.has(o.underlying_driver) ? o.underlying_driver : 'certainty',
          the_reframe:       strip(o.the_reframe),
          reframe_in_action: strip(o.reframe_in_action),
        }))
    : [];

  const one_that_kills_it = strip(parsed.one_that_kills_it);
  const rationale         = strip(parsed.rationale);

  if (objections.length < 3) return json(502, { error: 'need at least 3 objections' });

  return json(200, { objections, one_that_kills_it, rationale });
};
