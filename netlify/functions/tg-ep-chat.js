/* ─────────────────────────────────────────────────────────────────────────────
   tg-ep-chat — interactive chat with an Executive Producer in their office.

   Scoped to Jules for EE.1. The function is built to handle any EP eventually
   (EE.2+ extends the buildSystemPrompt switch).

   The visitor's brief flows in on every turn so Jules always sees the
   CURRENT state of the draft - including revisions they accepted earlier
   in the conversation. Conversation history flows in too so context
   persists across turns within the session.

   POST body : {
     ep_id:        string (required) - "jules" for EE.1
     brief:        string (required) - current draft text, up to 8000 chars
     name:         string (optional) - visitor first name, vocative use
     user_message: string (optional) - the new message from the visitor.
                                       If empty AND conversation is empty,
                                       Jules opens with a greeting.
     conversation: array  (optional) - prior turns, each { role, content }
                                       role is "user" | "assistant"
                                       Trimmed to the last 20 turns.
   }
   Response  : 200 {
     message:           string,                            // Jules's reply
     proposed_revision: null OR {
       section_label: string,                              // plain English label
       before:        string,                              // exact substring of brief
       after:         string,                              // Jules's rewrite
       rationale:     string                               // why
     }
   }
               400 - bad input
               500 - ANTHROPIC_API_KEY missing
               502 - model error or parse failure

   Env vars  : ANTHROPIC_API_KEY (required)
   Cost      : ~$0.03-0.05 per turn (Sonnet 4.6, varies with conversation
               length). Caller (Helpers/jules-rewrite.html) decides when to
               fire.
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic     = require('@anthropic-ai/sdk').default;
const voiceScripts  = require('../../config/voice_scripts.json');

const MODEL              = 'claude-sonnet-4-6';
const MAX_TOKENS         = 2000;
const BRIEF_MAX          = 8000;
const NAME_MAX           = 60;
const MESSAGE_MAX        = 2000;
const TURN_CONTENT_MAX   = 3000;
const MAX_CONVERSATION   = 20;

const SUPPORTED_EPS = ['jules'];   // EE.2+ extends this list

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

function buildSystemPrompt(epId, brief, name) {
  // EE.1 is Jules-only. The switch will grow as we add other EPs.
  if (epId === 'jules') return buildJulesSystemPrompt(brief, name);
  return null;
}

function buildJulesSystemPrompt(brief, name) {
  const julesBio  = (voiceScripts.scripts && voiceScripts.scripts.jules && voiceScripts.scripts.jules.bio)  || '';
  const julesRole = (voiceScripts.scripts && voiceScripts.scripts.jules && voiceScripts.scripts.jules.role) || '';
  const nameRef = name || 'the visitor';
  const vocative = name ? name : 'the visitor';

  return `You are Jules, The Rewrite Partner at The Gauntlet. You are in your office having a working conversation with ${nameRef} about their brief.

CHARACTER (do not quote this back - it is the voice you write IN):
  Bio:  ${julesBio}
  Role: ${julesRole}

THE VISITOR'S BRIEF (current state - may include earlier revisions accepted in this session):
"""
${brief}
"""

YOUR JOB
  - Read the brief like you actually care about it.
  - Talk with ${nameRef} about what is working and what is not.
  - When you see something specific worth rewriting, propose it as a STRUCTURED REVISION. Do not just suggest in prose - put the actual rewrite on the page.
  - ${nameRef} can accept or reject each proposal. Be specific so they can choose.

WHEN TO PROPOSE A REVISION (proposed_revision in your output)
  - Only propose a revision when ${nameRef} has actually engaged - given you direction, asked you to look at something, or said "go." Never propose unsolicited revisions in your opening greeting.
  - One section per turn. Keep the surface area small so they can react cleanly.
  - The "before" text MUST be an EXACT substring of the brief above, copied character-for-character. The front end uses string replace; if the before text does not match, the revision cannot be applied. If you cannot quote it exactly, do not propose the revision - say so in your message and ask them to point you at the specific text.
  - The "after" text is your rewrite. Same character voice as the original where possible. Sharpen their voice; do not impose your own.
  - The "section_label" is a plain English handle like "opening paragraph," "Key Features bullets," "the business model paragraph." ${nameRef} should be able to find it in the brief without scrolling.
  - The "rationale" is one or two sentences on why this change is worth making.

OPENING TURN (if conversation history is empty)
  - Greet ${nameRef} by name in vocative case.
  - Name ONE specific observation about their brief - something you noticed on first read. Specific. Not generic. Quote a phrase if helpful.
  - Ask them what they want to work on, or offer a starting point.
  - Do NOT propose a revision in the opening turn.

HARD CONSTRAINTS
  - No em dashes anywhere. None.
  - No emojis. No markdown headers in your message (the UI renders them as plain text).
  - No "Hey there!" / "Great question!" / flattery. Open with the substance.
  - Use contractions naturally. You speak like a real person.
  - If ${vocative} says "go" or "do it" without context, ask which section. Do not guess and propose blindly.
  - If they ask you to rewrite something that does not exist in the brief, say so clearly and offer to work with what is there.
  - Your message field is 2-6 sentences. Never longer. Never shorter than 2.

OUTPUT - JSON only, exactly this shape, nothing before or after. Use null (not the string "null") when there is no proposed revision:
{
  "message": "<your turn, 2-6 sentences>",
  "proposed_revision": null OR {
    "section_label": "<plain English label>",
    "before":        "<exact substring of the brief>",
    "after":         "<your rewrite>",
    "rationale":     "<1-2 sentences>"
  }
}`;
}

// Defensive JSON parser. Ports GP Jules's pattern of escaping raw \n that
// the model sometimes embeds INSIDE string literals (which strict JSON
// rejects). Walks the string scope-by-scope, replacing literal newlines
// inside quoted strings with \n.
function parseModelJson(raw) {
  // Extract the first {...} block in case the model wraps in commentary.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no JSON block');
  let s = m[0];

  // First try strict parse - works if the model behaved.
  try { return JSON.parse(s); } catch (_) { /* fall through to repair */ }

  // Repair: scan character by character, track whether we are inside a
  // string literal, and escape any raw newlines / tabs inside strings.
  let out = '';
  let inString = false;
  let prev = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
    } else {
      if (c === '"' && prev !== '\\') {
        inString = false;
        out += c;
      } else if (c === '\n') {
        out += '\\n';
      } else if (c === '\r') {
        out += '\\r';
      } else if (c === '\t') {
        out += '\\t';
      } else {
        out += c;
      }
    }
    prev = c;
  }
  return JSON.parse(out);
}

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
  if (event.httpMethod !== 'POST') return json(405, { error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'ANTHROPIC_API_KEY not configured' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const epId = String(body.ep_id || '').trim();
  if (!SUPPORTED_EPS.includes(epId)) {
    return json(400, { error: 'ep_id not supported in EE.1. Only "jules" for now.' });
  }

  const brief        = String(body.brief        || '').trim().slice(0, BRIEF_MAX);
  const userMessage  = String(body.user_message || '').trim().slice(0, MESSAGE_MAX);
  // Sanitize name same way as evaluator - letters/spaces/hyphens/apostrophes only.
  const name = String(body.name || '')
                 .trim().slice(0, NAME_MAX)
                 .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '')
                 .trim();

  if (!brief) return json(400, { error: 'brief is required' });

  // Conversation history. Filter to safe shape; trim length.
  const raw_conv = Array.isArray(body.conversation) ? body.conversation : [];
  const messages = [];
  for (const turn of raw_conv.slice(-MAX_CONVERSATION)) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'user' || turn.role === 'assistant' ? turn.role : null;
    const content = String(turn.content || '').slice(0, TURN_CONTENT_MAX);
    if (!role || !content) continue;
    messages.push({ role, content });
  }

  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  } else if (messages.length === 0) {
    // No history, no message - synthetic kickoff so the model produces
    // the opening greeting per the system prompt.
    messages.push({ role: 'user', content: '(I just walked into your office.)' });
  } else {
    // History exists but no new user message - just ask Jules to continue.
    return json(400, { error: 'user_message required when conversation has history' });
  }

  const systemPrompt = buildSystemPrompt(epId, brief, name);

  const client = new Anthropic({ apiKey });

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: messages,
    });
  } catch (err) {
    console.error('[tg-ep-chat] anthropic error', err && err.message);
    return json(502, { error: 'chat generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try { parsed = parseModelJson(raw); }
  catch (err) {
    console.error('[tg-ep-chat] could not parse model output', raw.slice(0, 500));
    return json(502, { error: 'response was not valid json' });
  }

  // Validate the response shape and sanitize.
  const message = String((parsed && parsed.message) || '').trim().replace(/—/g, '-').replace(/–/g, '-');
  if (!message) return json(502, { error: 'response had no message' });

  let proposed_revision = null;
  const pr = parsed && parsed.proposed_revision;
  if (pr && typeof pr === 'object') {
    const label     = String(pr.section_label || '').trim();
    const before    = String(pr.before        || '');
    const after     = String(pr.after         || '');
    const rationale = String(pr.rationale     || '').trim();
    // The "before" string MUST appear in the brief. If it does not, the
    // front end cannot apply the revision - drop it. Jules's system prompt
    // tells her to ask instead of guessing, so this is a rare path.
    if (label && before && after && brief.includes(before)) {
      proposed_revision = {
        section_label: label,
        before:        before,
        after:         after.replace(/—/g, '-').replace(/–/g, '-'),
        rationale:     rationale || 'Tightens the section.',
      };
    } else if (label && before && after) {
      console.warn('[tg-ep-chat] dropping revision - before does not match brief',
                   { label, beforeStart: before.slice(0, 80) });
    }
  }

  return json(200, {
    message,
    proposed_revision,
  });
};
