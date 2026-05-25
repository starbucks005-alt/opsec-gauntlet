/* ─────────────────────────────────────────────────────────────────────────────
   tg-reid-press — press-release generator (Reid Callum's tool).

   The visitor picks an announcement type and optionally provides a
   headline angle in Reid's office. The function drafts a press release
   in Reid's voice, anchored to the founder's brief. The client appends
   the result to the visitor's brief as an accepted revision so the
   release ships in the deliverable (same revision-log shape as the
   EP-chat accept-revision flow).

   POST body : {
     announcement_type: 'product_launch'|'funding_round'|'milestone'|'partnership'|'hire'|'customer_win'
     headline_angle:    string (optional, max 200 chars - what to lead with)
     brief:             string (visitor's working brief)
     name:              string (visitor's first name, optional)
   }
   Response  : {
     headline:               <one strong headline>
     release:                <the full body text - dateline, lead, quote, context, boilerplate, contact>
     rationale:              <one sentence on why this angle works>
     announcement_label:     <human-readable announcement type>
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL       = 'claude-sonnet-4-6';
const MAX_TOKENS  = 1200;
const ANGLE_MAX   = 200;
const BRIEF_MAX   = 6000;
const NAME_MAX    = 60;
const BRIEF_MIN   = 30;

const ANNOUNCEMENT_TYPES = {
  product_launch: {
    label: 'Product launch',
    guidance: 'The news is the product itself. Headline names what the product does for whom. Lead paragraph: what is launching, who it serves, what changes for them. Quote from the founder explains why now. Context paragraph: the gap in the market this fills. Use concrete capability language, not abstract value props.'
  },
  funding_round: {
    label: 'Funding round',
    guidance: 'The news is the round. Headline names the dollar amount, the lead investor, and the company in that order. Lead paragraph: amount raised, lead and co-lead investors, what the capital funds. Quote from founder names the next milestone the round buys. Context: why investors are backing this category now. Do NOT invent specific dollar amounts or investor names if the brief does not include them. Use [AMOUNT] / [LEAD INVESTOR] placeholders for the visitor to fill in.'
  },
  milestone: {
    label: 'Milestone (users, revenue, etc.)',
    guidance: 'The news is the number reached. Headline names the milestone in concrete terms (e.g. "crosses 10,000 paying customers in 18 months"). Lead paragraph: the milestone, when it was hit, what made it possible. Quote from founder ties the number to the customer story behind it. Context: what this milestone signals about the category. Use only numbers present in the brief. If the brief lacks the number, use a [NUMBER] placeholder.'
  },
  partnership: {
    label: 'Partnership / integration',
    guidance: 'The news is the partnership. Headline names both companies and the joint capability. Lead paragraph: who is partnering with whom, what it lets customers do. Quote from founder explains why this partner specifically. Context: how this changes the workflow / experience for the shared customer. Use [PARTNER COMPANY] placeholder if the brief does not name them.'
  },
  hire: {
    label: 'Key hire',
    guidance: 'The news is the person joining. Headline names the role and the person\'s most credible prior achievement. Lead paragraph: who joined, when, what they will own. Quote from the new hire explains why they joined this team. Context: how the hire fills a specific gap. Use [NAME] / [PRIOR ROLE] placeholders if the brief does not name the hire.'
  },
  customer_win: {
    label: 'Customer win',
    guidance: 'The news is the customer the visitor is now serving. Headline names the customer category and the outcome. Lead paragraph: who, when, what they replaced. Quote from the customer explains what changed for them. Context: why this win matters for the category. Customer name MUST be a [CUSTOMER] placeholder unless the brief names a specific public customer.'
  },
};

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  },
  body: JSON.stringify(body),
});

function sanitizeName(raw) {
  return String(raw || '')
    .trim().slice(0, NAME_MAX)
    .replace(/[^A-Za-zÀ-ɏ\s'\-]/g, '')
    .trim();
}

function buildSystemPrompt(name, announcement) {
  const r = (voiceScripts.scripts && voiceScripts.scripts.reid_callum) || {};
  const nameRef = name || 'the founder';
  return `You are Reid Callum, The Marketing Expert at The Gauntlet. You draft press releases for founders that journalists will actually open.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${r.bio || ''}
  Role: ${r.role || ''}

YOUR JOB
  Draft ONE press release for ${nameRef} based on the announcement type and (optional) headline angle they chose. The release must be anchored in the founder's brief. The release must read like real news, not a marketing memo.

ANNOUNCEMENT TYPE: ${announcement.label}
  ${announcement.guidance}

STRUCTURE (follow exactly)
  1. HEADLINE - one strong declarative line. The news first, the company second. No "introduces" / "is proud to announce" / "is pleased to share." Active verb. Concrete object.
  2. DATELINE - "CITY, STATE - MONTH DD, YYYY -" format. If the brief does not name a city, use [CITY, STATE]. Today's date is acceptable.
  3. LEAD PARAGRAPH - the news in 2-3 sentences. Who, what, why now. The reader can stop reading here and have the story.
  4. QUOTE (founder) - one quote from ${nameRef}, two sentences max, that explains WHY this matters. Not a slogan. A sentence a real person would say.
  5. CONTEXT - 1-2 paragraphs giving the journalist enough background to write their own version. What was true before. What this changes.
  6. SECOND QUOTE (optional) - from a customer, partner, or investor if the brief supports one. Skip if you would have to invent.
  7. ABOUT (boilerplate) - 2-3 sentences on the company. What it does, who it serves, where it operates.
  8. MEDIA CONTACT - placeholder block:
     Contact: [NAME]
     [TITLE]
     [EMAIL]
     [PHONE]

DRAFTING RULES (read every time)
  - If the brief does not contain a fact you would need, use a SQUARE-BRACKET PLACEHOLDER like [NUMBER], [CUSTOMER], [INVESTOR], [DATE]. NEVER invent facts. The visitor will fill in placeholders before they wire the release.
  - No em dashes anywhere. Use plain hyphens or restructure the sentence.
  - No exclamation points outside quotes (and even there, sparingly).
  - No "industry-leading," "best-in-class," "world-class," "revolutionary," "cutting-edge," "game-changing," "disruptive," "synergy," or any other marketing-cliche adjectives. If you reach for one, restructure the sentence.
  - No "is proud to announce," "is pleased to share," "is excited to reveal." The opener IS the news.
  - Real numbers, real customer categories, real dates - only when the brief provides them or via placeholder.
  - The quote must sound like the founder, not like a CEO bio.
  - Length: 280-420 words for the release body (not counting boilerplate / contact).

HARD CONSTRAINTS
  - Output is JSON only, exactly the shape below, nothing before or after.
  - The "headline" field is the headline alone.
  - The "release" field is the FULL formatted release - dateline, body, quotes, boilerplate, contact block - in plain text with line breaks. Newlines are real newlines in the string (escape as \\n in JSON).
  - The "rationale" field is ONE sentence explaining why this angle / structure works for this story. Aimed at the founder, not the journalist.

OUTPUT JSON:
{
  "headline":  "<one line>",
  "release":   "<full formatted release with \\n line breaks>",
  "rationale": "<one sentence>"
}`;
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'invalid json' }); }

  const announcement = ANNOUNCEMENT_TYPES[String(body.announcement_type || '').toLowerCase()];
  if (!announcement) return json(400, { error: 'invalid announcement_type' });

  const angle = String(body.headline_angle || '').trim().slice(0, ANGLE_MAX);
  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);

  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to anchor a press release' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt(name, announcement);
  const userPrompt = [
    `THE FOUNDER'S BRIEF (this is the company / idea you are writing about - draft only from what is here, use [PLACEHOLDERS] for anything missing):`,
    '"""',
    brief,
    '"""',
    '',
    angle ? `HEADLINE ANGLE / WHAT TO LEAD WITH: ${angle}` : 'HEADLINE ANGLE: (none specified - choose the strongest angle from the brief)',
    '',
    `Draft the press release now. JSON only.`,
  ].join('\n');

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
  } catch (err) {
    console.error('[tg-reid-press] anthropic error', err && err.message);
    return json(502, { error: 'press release generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-reid-press] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const headline = String(parsed.headline || '').trim();
  let   release  = String(parsed.release  || '').trim();
  const rationale = String(parsed.rationale || '').trim();
  // Strip em dashes / en dashes in case the model regressed past the rule.
  release = release.replace(/—/g, '-').replace(/–/g, '-');

  if (!headline || !release) return json(502, { error: 'incomplete response' });

  return json(200, {
    headline,
    release,
    rationale,
    announcement_label: announcement.label,
  });
};
