/* ─────────────────────────────────────────────────────────────────────────────
   tg-zara-post — founder-content post generator (Zara Cole's tool).

   The visitor picks a topic, platform, and tone in Zara's office. The
   function drafts one post in Zara's voice, tied to the founder's brief.
   Client-side script auto-appends the result to the visitor's brief as
   an accepted revision so the post ships in the deliverable.

   POST body : {
     topic:    string (1-200 chars)
     platform: 'instagram' | 'twitter' | 'tiktok' | 'linkedin' | 'threads'
     tone:     'build_in_public' | 'tactical_lesson' | 'counter_narrative' | 'founder_origin'
     brief:    string (the visitor's working brief)
     name:     string (visitor's first name, optional)
   }
   Response  : {
     post:       <the drafted post>
     rationale:  <one sentence on why this works>
     platform_label: <human-readable platform name>
     tone_label:     <human-readable tone name>
   }
   Env       : ANTHROPIC_API_KEY
   ───────────────────────────────────────────────────────────────────────────── */

const Anthropic    = require('@anthropic-ai/sdk').default;
const voiceScripts = require('../../config/voice_scripts.json');

const MODEL       = 'claude-sonnet-4-6';
const MAX_TOKENS  = 800;
const TOPIC_MAX   = 200;
const BRIEF_MAX   = 6000;
const NAME_MAX    = 60;
const BRIEF_MIN   = 30;

const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    shape: 'A feed post 100-150 words OR a Reel script with shot direction. Hook lives in line 1. Founder/business content does NOT use emoji. Hashtags: 3-5, placed at the end on their own line, lowercase, no spam tags. If a Reel: include "[Shot:" / "[Cut:" stage directions inline so the founder knows what to film.'
  },
  twitter: {
    label: 'X (Twitter)',
    shape: 'Either a SINGLE tweet under 280 characters, OR a thread of 3-5 tweets numbered "1/" "2/" etc. Hook in tweet 1. No hashtags. Punchy declarative voice. Each tweet stands on its own.'
  },
  tiktok: {
    label: 'TikTok',
    shape: 'A spoken-on-camera script for a 30-60 second video. First 3 seconds MUST hook (state the surprising thing). Speak in 1st person. Short sentences a founder can say naturally on camera. No emoji. Hashtags: 3, lowercase, at the very end on their own line.'
  },
  linkedin: {
    label: 'LinkedIn',
    shape: '120-180 words. Hook in line 1. Line break after the hook so the post earns the "...see more" click. Story structure with ONE specific number. Optional bullet list, max 4 bullets. No hashtags. No emoji.'
  },
  threads: {
    label: 'Threads',
    shape: '80-120 words. Conversational like an aside to a friend, not a broadcast. First line is the whole hook. No hashtags. Emoji allowed but discouraged for founder content.'
  },
};

const TONES = {
  build_in_public: {
    label: 'Build in public',
    description: 'Sharing the process, the milestone, the learning, as it happens. Honest. Specific. Numbers when available. NOT polished retrospective - it should feel like a note written today.'
  },
  tactical_lesson: {
    label: 'Tactical lesson',
    description: 'What we tried, what worked, what did not. A specific experiment with the takeaway named. Includes the actual mechanic (the change, the metric, the result). The reader can use this on their own thing.'
  },
  counter_narrative: {
    label: 'Counter-narrative',
    description: 'Names a common belief in the founder\'s space and makes the case for why it is wrong. Specific about who believes it and what they get wrong. Stakes a position, does not hedge.'
  },
  founder_origin: {
    label: 'Founder origin',
    description: 'Why this founder built this thing, in their voice. The specific moment, not the smoothed-over version. Earned not performed. Tied to a concrete event or observation from the brief.'
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

function buildSystemPrompt(name, platform, tone) {
  const z = (voiceScripts.scripts && voiceScripts.scripts.zara_cole) || {};
  const nameRef = name || 'the founder';
  return `You are Zara Cole, The Influencer at The Gauntlet. You draft founder content that does not sound like marketing.

CHARACTER (write IN this voice; never quote it back):
  Bio:  ${z.bio || ''}
  Role: ${z.role || ''}

YOUR JOB
  Write ONE post for ${nameRef} based on the topic, platform, and tone they chose. The post must be anchored in their specific idea (their brief is below). It must read like a person wrote it, not a brand. No marketing language.

PLATFORM (${platform.label}) - follow this shape exactly:
  ${platform.shape}

TONE (${tone.label}):
  ${tone.description}

VOICE RULES (read every time)
  - Sound like a real person. Not a brand. Not a thought leader.
  - No "Hey founders," "What if I told you," "Here's the thing," or any other engagement-bait opener.
  - No motivational platitudes. No fake vulnerability. No "I'm gonna be real with you."
  - First-person ("I", "we") where natural. Never lecture the reader with "you should."
  - Specific over abstract. Name the actual customer, number, decision, observation.
  - If the brief does not contain a fact you would need to invent, do NOT invent it. Work with what's there.
  - No em dashes. No semicolons. Plain language.

HARD CONSTRAINTS
  - Output is JSON only, exactly the shape below, nothing before or after.
  - The "post" field is the post itself, ready to copy paste, including any platform-required formatting (line breaks, hashtags, etc.).
  - The "rationale" field is ONE sentence explaining why this post works for this platform and tone. Not for the reader of the post - for the founder, so they know why you wrote it this way.

OUTPUT JSON:
{
  "post":      "<the drafted post>",
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

  const platform = PLATFORMS[String(body.platform || '').toLowerCase()];
  const tone     = TONES[String(body.tone || '').toLowerCase()];
  if (!platform) return json(400, { error: 'invalid platform' });
  if (!tone)     return json(400, { error: 'invalid tone' });

  const topic = String(body.topic || '').trim().slice(0, TOPIC_MAX);
  const brief = String(body.brief || '').trim().slice(0, BRIEF_MAX);
  const name  = sanitizeName(body.name);

  if (!topic)                return json(400, { error: 'topic is required' });
  if (brief.length < BRIEF_MIN) return json(400, { error: 'brief is too short to anchor a post' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(500, { error: 'anthropic env missing' });

  const client = new Anthropic({ apiKey });

  const systemPrompt = buildSystemPrompt(name, platform, tone);
  const userPrompt = [
    `THE FOUNDER'S BRIEF (this is the idea you are writing about - draft only from what is here, do NOT invent facts):`,
    '"""',
    brief,
    '"""',
    '',
    `TOPIC FOR THIS POST: ${topic}`,
    '',
    `Draft the post now. JSON only.`,
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
    console.error('[tg-zara-post] anthropic error', err && err.message);
    return json(502, { error: 'post generation failed' });
  }

  const raw = (response.content || [])
    .filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!raw) return json(502, { error: 'empty response' });

  let parsed;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    console.error('[tg-zara-post] parse fail', raw.slice(0, 400));
    return json(502, { error: 'output was not valid json' });
  }

  const post      = String(parsed.post      || '').trim();
  const rationale = String(parsed.rationale || '').trim();
  // Strip em dashes / en dashes just in case the model regressed past the
  // voice rule. Founder content with em dashes reads AI-touched.
  const cleanPost = post.replace(/—/g, '-').replace(/–/g, '-');

  if (!cleanPost) return json(502, { error: 'no post in response' });

  return json(200, {
    post:           cleanPost,
    rationale:      rationale,
    platform_label: platform.label,
    tone_label:     tone.label,
  });
};
