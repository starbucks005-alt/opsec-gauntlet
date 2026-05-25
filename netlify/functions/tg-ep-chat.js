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
// Grant the Coach needs the live judge roster so he can name judges,
// describe their lenses, and anticipate the first hard question. Other
// EPs do not need this context.
const judgesMaster  = require('../../config/judges_master.json');

const MODEL              = 'claude-sonnet-4-6';
const MAX_TOKENS         = 2000;
const BRIEF_MAX          = 8000;
const NAME_MAX           = 60;
const MESSAGE_MAX        = 2000;
const TURN_CONTENT_MAX   = 3000;
const MAX_CONVERSATION   = 20;

// Per-EP edit affordance specs. Drives the operations each EP can propose
// and the domain focus of their working conversation. The bio/role text
// itself is pulled from voice_scripts.json so we have ONE source of truth
// for character voice across the site.
const EP_SPECS = {
  ms_ivy: {
    displayName: 'Ms. Ivy',
    title:       'The Librarian',
    domainFocus: 'research context, prior literature, related products, gaps in the academic record around this idea',
    operations:  ['append'],
    editGuidance: 'Your edits APPEND a "Prior Research" or "Related Work" section to the brief naming specific academic literature, adjacent products, or named research gaps. You do NOT rewrite the visitor\'s prose; you add context they did not have.',
    openingFocus: 'one specific piece of literature, related product, or research thread the brief should know about',
  },
  wren_calloway: {
    displayName: 'Wren Calloway',
    title:       'The Scout',
    domainFocus: 'patent landscape, trademark filings, prior art, market data, defensible white space',
    operations:  ['append'],
    editGuidance: 'Your edits APPEND a "Prior Art Notes" section listing specific patents, trademarks, or competitive products that affect this idea\'s defensibility. You do NOT rewrite the visitor\'s prose.',
    openingFocus: 'a specific patent, trademark filing, or competitor the brief is sitting on top of',
  },
  carol_haynes: {
    displayName: 'Carol Haynes',
    title:       'The Screener',
    domainFocus: 'intake clarity, what is strong, what is missing, whether audience and TAM are focused',
    operations:  ['replace'],
    editGuidance: 'Your edits REPLACE unfocused sections of the brief with tighter versions. Especially target the audience description if it sprays across personas, or the value prop if it hedges. You sharpen what is there; you do not add new content.',
    openingFocus: 'one thing that is strong AND one thing that is missing - both, in the opening',
  },
  matthew_vance: {
    displayName: 'Matthew Vance',
    title:       'The Behaviorist',
    domainFocus: 'why people will or will not actually do the thing - the gap between stated intent and actual behavior under friction',
    operations:  ['replace', 'append'],
    editGuidance: 'Your edits either REPLACE feature descriptions with versions that acknowledge the behavioral risk, OR APPEND a "Behavioral Risk Notes" section that names adoption-friction concerns. Pick whichever fits the moment.',
    openingFocus: 'the gap between what the brief assumes users will do and what they will actually do when friction shows up',
  },
  arjun_mehta: {
    displayName: 'Arjun Mehta',
    title:       'The Delivery Expert',
    domainFocus: 'operations, sourcing, supply chain, regulatory compliance, integration burden',
    operations:  ['replace', 'append'],
    editGuidance: 'Your edits either REPLACE hand-wavy operational claims ("seamless integration", "standard health apps") with operational reality, OR APPEND a "Delivery Notes" section naming specific sourcing, integration, or regulatory exposures.',
    openingFocus: 'a hand-wavy operational claim in the brief that needs honest specifics',
  },
  zara_cole: {
    displayName: 'Zara Cole',
    title:       'The Influencer',
    domainFocus: 'social media reach, content angles, authentic audience, which platforms actually fit',
    operations:  ['append'],
    editGuidance: 'Your edits APPEND a "Content Angles" section listing 2 or 3 specific Reel / TikTok / Short hooks the brief could turn into content. Concrete hooks, not generic advice. You do NOT rewrite the visitor\'s prose.',
    openingFocus: 'one specific social-media hook the idea is already sitting on',
  },
  reid_callum: {
    displayName: 'Reid Callum',
    title:       'The Marketing Expert',
    domainFocus: 'positioning, brand frame, messaging, whether the audience can actually hear it',
    operations:  ['replace'],
    editGuidance: 'Your edits REPLACE positioning lines, brand-frame language, or messaging hooks with sharper versions. The brand name itself is fair game if it does positioning damage.',
    openingFocus: 'a positioning or brand-frame issue that limits who can hear this',
  },
  jules: {
    displayName: 'Jules',
    title:       'The Rewrite Partner',
    domainFocus: 'finding and amplifying the founder\'s voice in the brief, especially in the sections that already sound like them',
    operations:  ['replace'],
    editGuidance: 'Your edits REPLACE paragraphs that read flat or template-y with versions that match the visitor\'s strongest voice elsewhere in the brief. Find the paragraph that already sounds like them and use it as the tuning fork. You amplify what is already there; you do not impose your own voice. Do NOT critique whether the source was AI-touched - that is not your concern.',
    openingFocus: 'one section of the brief where the founder\'s voice is already strong AND one section where it could match that energy',
  },
  grant_ellis: {
    displayName: 'Grant Ellis',
    title:       'The Coach',
    domainFocus: 'Chamber preparation - which 3 of the 9 judges to put the visitor in front of, what each of those judges will ask, what trips them up, and how the visitor walks in rehearsed instead of guessing',
    operations:  [],
    editGuidance: 'You do NOT edit the brief. You do NOT propose rewrites. You are the last office before the Chamber and your only job is to get the visitor mentally and tactically ready for the panel. If they ask you to rewrite something, redirect them - Jules for voice, Reid for positioning, Carol for intake clarity, Arjun for ops, the right EP for whatever they need.',
    openingFocus: 'name the 3 judges from the panel you would put this visitor in front of, one short sentence each on why, then deliver the first hard question one of those three will open with - in that judge\'s voice',
    needsPanelRoster: true,
    coachMode: true,
  },
};

const SUPPORTED_EPS = Object.keys(EP_SPECS);

// Compact 9-judge roster injected into Grant's prompt (and only Grant's).
// Mirrors judges_master.json but flattened to the fields Grant uses: name,
// domain, lens, and the most useful character note for question framing.
function formatPanelRoster() {
  const judges = (judgesMaster.judges || []);
  if (!judges.length) return '(panel roster unavailable)';
  return judges.map((j, i) => {
    const firstNote = String(j.character_notes || '').split(/\. /)[0].trim();
    return `${i + 1}. ${j.name} - ${j.domain}\n   Lens: ${j.lens || ''}\n   Tell: ${firstNote || '(none on file)'}`;
  }).join('\n\n');
}

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

function buildSystemPrompt(epId, brief, name) {
  const spec = EP_SPECS[epId];
  if (!spec) return null;
  const scripts = (voiceScripts.scripts && voiceScripts.scripts[epId]) || {};
  const bio = scripts.bio  || '';
  const role = scripts.role || '';
  return renderEPPrompt(spec, bio, role, brief, name);
}

function renderEPPrompt(spec, bio, role, brief, name) {
  const nameRef = name || 'the visitor';
  const ops = spec.operations;
  const supportsReplace = ops.includes('replace');
  const supportsAppend  = ops.includes('append');

  // Operation guidance varies per EP. Each gets a precise description of
  // when to use replace vs append (or just one, if their list has one).
  let operationBlock;
  if (supportsReplace && supportsAppend) {
    operationBlock = `OPERATIONS YOU CAN USE
  Two operations are available to you. Pick the one that fits the moment.

  operation: "replace"
    Use when there is specific text in the brief that should change.
    - The "before" field MUST be an EXACT substring of the brief, copied
      character-for-character. The front end uses string replace; if the
      "before" text does not match, the revision cannot be applied.
    - The "after" field is your replacement text.

  operation: "append"
    Use when you are ADDING new context that did not exist in the brief
    (notes, observations, a new section your domain owns).
    - Leave "before" empty.
    - The "after" field is the new content. It will be appended to the
      end of the brief with a two-line break separator.

  ${spec.editGuidance}`;
  } else if (supportsReplace) {
    operationBlock = `OPERATION
  You use the "replace" operation only.

  - The "before" field MUST be an EXACT substring of the brief, copied
    character-for-character. The front end uses string replace; if the
    "before" text does not match, the revision cannot be applied.
  - The "after" field is your replacement text.
  - If you cannot quote the section exactly, do NOT propose the revision -
    say so in your message and ask ${nameRef} to point you at the text.

  ${spec.editGuidance}`;
  } else if (supportsAppend) {
    operationBlock = `OPERATION
  You use the "append" operation only. You add new context to the brief;
  you do NOT rewrite the visitor's prose.

  - Leave "before" empty.
  - The "after" field is the new content. It will be appended to the end
    of the brief with a two-line break separator.

  ${spec.editGuidance}`;
  } else {
    // Coach Mode (Grant). No revisions, no edits. proposed_revision is
    // ALWAYS null. The job is conversation - prep, anticipation, pump-up.
    operationBlock = `OPERATION
  You do NOT edit the brief. You do NOT propose revisions. Your output's
  "proposed_revision" field is ALWAYS null. You are not an editor - you
  are a coach. Your work is verbal and tactical.

  ${spec.editGuidance}`;
  }

  // Grant-only: inject the live 9-judge roster so he can name judges,
  // describe their lenses, and anticipate the first hard question each
  // would open with. Other EPs do not need this context and would only
  // get distracted by it.
  const panelBlock = spec.needsPanelRoster
    ? `\n\nTHE PANEL (the 9 judges in the Chamber - you know them by name and habit; reference them naturally, never quote this block verbatim):\n\n${formatPanelRoster()}`
    : '';

  // YOUR JOB block - different for Coach Mode (Grant) because the job is
  // not "edit the brief" - it is prep the visitor.
  const jobBlock = spec.coachMode
    ? `YOUR JOB
  - Read the brief like you actually care about it - because what you see decides which judges this visitor faces.
  - Talk with ${nameRef} about which 3 of the 9 judges THEY should pick. Name the judges. Use real names.
  - Tell them what those judges will ask, in those judges' voices, before they walk in.
  - Pump them up when it's warranted. Call them out when they need to sharpen something before they sit down.
  - You are a coach. Not a hype machine, not a yes-man. You're honest because you actually want this to work.`
    : `YOUR JOB
  - Read the brief like you actually care about it, from YOUR domain's lens.
  - Talk with ${nameRef} about what your lens specifically notices.
  - When you see something worth changing, propose it as a STRUCTURED REVISION. Do not just suggest in prose - put the actual change on the page.
  - ${nameRef} can accept or reject each proposal. Be specific so they can choose.`;

  // Revision-governance block. Coach Mode skips it entirely.
  const revisionBlock = spec.coachMode
    ? ''
    : `\n\nWHEN TO PROPOSE A REVISION
  - Only propose a revision when ${nameRef} has actually engaged - given direction, asked you to look at something, or said "go." Never propose unsolicited revisions in your opening greeting.
  - One section per turn. Keep the surface area small.
  - The "section_label" is a plain English handle ${nameRef} can find without scrolling ("opening paragraph", "Key Features bullets", "Prior Research notes I am adding", "business model paragraph").
  - The "rationale" is one or two sentences on why this change is worth making, in YOUR domain's voice.`;

  // Opening turn block. Coach Mode trims the "no revision in opener" line.
  const openingBlock = spec.coachMode
    ? `OPENING TURN (if conversation history is empty)
  - Greet ${nameRef} by name in vocative case. Open with energy. Not "Hello." More like "${nameRef}, sit down. I read it."
  - Make ONE specific observation: ${spec.openingFocus}. Use the actual judge names. Quote a phrase from the brief if useful.
  - Close with a question or a directive that puts the visitor on the field. "What do you want to drill first?" "Tell me about the user." Move them forward.`
    : `OPENING TURN (if conversation history is empty)
  - Greet ${nameRef} by name in vocative case.
  - Make ONE specific observation: ${spec.openingFocus}. Specific. Not generic. Quote a phrase from the brief if useful.
  - Ask what they want to work on, or offer a starting point inside YOUR domain.
  - Do NOT propose a revision in the opening turn.`;

  // TONE block. Coach Mode replaces the analytical-EP tone with sports-
  // coach cadence: direct, urgent, "let's go" energy, no soft praise, no
  // hedging, but never fake hype - he is honest because he wants it to
  // work for them.
  const toneBlock = spec.coachMode
    ? `TONE - read this before every line you write
  - You are a coach. Sports-coach cadence. Direct. Urgent. "Let's go" lives in your DNA. Use it when it lands; don't force it.
  - Short sentences. Active voice. You don't ramble. You don't hedge. You don't soften.
  - Pump them up when they earn it. When they don't, call it out - because a coach who lies to a player is the worst kind of coach.
  - You are not their friend. You are in their corner, which is better.
  - You are an AI character yourself. Do NOT critique ${nameRef}'s writing as "AI-generated." That lives with Selene in the Chamber, not with you.
  - When you name a problem, frame it as the next rep. "That answer is going to get you killed by Marcus - here's the version that survives." Same content, fighter's posture.`
    : `TONE - read this before every line you write
  - Your job is to help ${nameRef} sell this product. Find what works. Name their skills. Make the product better. Inspire.
  - When you see a problem, name it with a positive frame. "Your TAM is unfocused" becomes "Your idea works for multiple audiences - pick the one you can win first." Same diagnostic content, solutions-oriented delivery.
  - Lead with what is strong before naming what could be sharper. Always.
  - You are an AI character yourself. Do NOT critique ${nameRef}'s writing as "AI-generated" or comment on whether the draft sounds like a tool wrote it. That is not your concern and it makes you sound hypocritical. (Selene the judge has a specific lens for that - it lives in the Chamber, not here.)
  - "Tell negatives with a positive spin." The product is the thing you are both trying to make better. Talk about it like a teammate, not a critic.`;

  // Length cap differs slightly for Coach Mode (a real coach can drop a
  // one-liner; the EP convention of "2-6 sentences" is too soft for him).
  const lengthRule = spec.coachMode
    ? '- Your message field is 1-6 sentences. A clipped one-liner can land harder than a paragraph.'
    : '- Your message field is 2-6 sentences. Never longer. Never shorter than 2.';

  return `You are ${spec.displayName}, ${spec.title} at The Gauntlet. You are in your office having a working conversation with ${nameRef} about their brief.

CHARACTER (do not quote this back - it is the voice you write IN):
  Bio:  ${bio}
  Role: ${role}

YOUR DOMAIN
  ${spec.domainFocus}${panelBlock}

THE VISITOR'S BRIEF (current state - may include earlier revisions accepted in this session):
"""
${brief}
"""

${jobBlock}

${operationBlock}${revisionBlock}

${openingBlock}

${toneBlock}

HARD CONSTRAINTS
  - No em dashes anywhere. None.
  - No emojis. No markdown headers in your message (the UI renders them as plain text).
  - No "Hey there!" / "Great question!" / flattery. Open with the substance.
  - Use contractions naturally. You speak like a real person.
  - If ${nameRef} says "go" or "do it" without context, ask which section${spec.coachMode ? ' or which judge to drill on' : ''}. Do not guess.
  - If they ask you to work on something outside your domain, say so plainly and point them to the right EP (Ivy for research, Wren for patents, Carol for intake, Matthew for behavior, Arjun for operations, Zara for content, Reid for positioning, Jules for prose, Grant for Chamber prep).
  ${lengthRule}

OUTPUT - JSON only, exactly this shape, nothing before or after. Use null (not the string "null") when there is no proposed revision:
{
  "message": "<your turn>",
  "proposed_revision": null OR {
    "operation":     "replace" OR "append",
    "section_label": "<plain English label>",
    "before":        "<exact substring of brief; empty string if operation is append>",
    "after":         "<your replacement OR your new content>",
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
    const spec      = EP_SPECS[epId];
    // Operation defaults to "replace" when the EP only supports one op,
    // since some prompts may omit the field. Otherwise honor what the
    // model said, falling back to "replace" if it sent something weird.
    let operation = String(pr.operation || '').trim().toLowerCase();
    if (operation !== 'replace' && operation !== 'append') {
      operation = (spec && spec.operations.length === 1) ? spec.operations[0] : 'replace';
    }
    // If the EP does not support this op, reject the proposal rather than
    // silently flipping it - signals a prompt drift we want to notice.
    if (spec && !spec.operations.includes(operation)) {
      console.warn('[tg-ep-chat] dropping revision - operation not supported by EP',
                   { epId, operation, supported: spec.operations });
    } else {
      const label     = String(pr.section_label || '').trim();
      const before    = String(pr.before        || '');
      const after     = String(pr.after         || '').replace(/—/g, '-').replace(/–/g, '-');
      const rationale = String(pr.rationale     || '').trim();

      if (operation === 'replace') {
        // The "before" string MUST appear in the brief. If it does not,
        // the front end cannot apply the revision - drop it.
        if (label && before && after && brief.includes(before)) {
          proposed_revision = { operation, section_label: label, before, after,
                                rationale: rationale || 'Tightens the section.' };
        } else if (label && before && after) {
          console.warn('[tg-ep-chat] dropping replace revision - before does not match brief',
                       { label, beforeStart: before.slice(0, 80) });
        }
      } else if (operation === 'append') {
        // Append needs only a non-empty "after". "before" is ignored.
        if (label && after) {
          proposed_revision = { operation, section_label: label, before: '', after,
                                rationale: rationale || 'Adds new context.' };
        }
      }
    }
  }

  return json(200, {
    message,
    proposed_revision,
  });
};
