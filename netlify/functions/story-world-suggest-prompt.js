// netlify/functions/story-world-suggest-prompt.js
// Asks Claude to turn a page of story text into an image-generation prompt,
// shaped by the book's mode (story / picture / wordless / comic).
// POST body: { page_id, page_text }
// Returns: { suggested_prompt }

const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function callAnthropic(system, prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return Promise.reject(new Error('ANTHROPIC_API_KEY not configured'));
  const payload = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 400,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message || 'Anthropic API error'));
          else resolve(p);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const MODE_HINT = {
  story:    'Standard illustrated-story tone. Match the mood of the text exactly — warm if warm, ominous if ominous.',
  picture:  'Picture-book composition: a single clear focal subject, generous negative space, visually inviting for a young or all-ages audience. No clutter.',
  wordless: 'The image must carry the entire page on its own (no text in the image, no caption). Focus on a single readable moment with strong body language and clear action.',
  comic:    'Lean into comic exaggeration and visual humor — expressive faces, slightly cartoony proportions, playful staging. Funny over serious.',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST')   return json(405, { error: 'Method not allowed' });

  const auth = event.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return json(401, { error: 'Authentication required' });
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return json(401, { error: 'Invalid session' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const { page_id, page_text } = body;
  if (!page_id) return json(400, { error: 'page_id is required' });
  const pageText = String(page_text || '').trim();
  if (!pageText) return json(400, { error: 'page_text is required' });

  // Fetch the page + parent book (RLS scoped to user)
  const { data: page, error: pageErr } = await supabase
    .from('story_world_pages')
    .select('*, book:story_worlds(*)')
    .eq('id', page_id)
    .eq('user_id', user.id)
    .single();
  if (pageErr || !page) return json(404, { error: 'Page not found' });

  const book = page.book || {};
  const mode = book.mode || 'story';
  const style = book.style || 'cinematic illustration';
  const modeHint = MODE_HINT[mode] || MODE_HINT.story;

  const system = 'You are an experienced illustrator working with an author. You read one page of their story and respond with one short, vivid image-generation prompt that an AI image model can render directly. You output ONLY the prompt — no preamble, no quotes, no commentary.';
  const userPrompt =
    'Book title: ' + (book.title || '(untitled)') + '\n' +
    'Visual style for the whole book: ' + style + '\n' +
    'Mode guidance: ' + modeHint + '\n\n' +
    'Page text:\n"""\n' + pageText.slice(0, 6000) + '\n"""\n\n' +
    'Write a single image-generation prompt of about 40-70 words for this page. Describe the scene in third person. Include the visible characters, setting, action, and mood from the text. End with style and lighting hints that match the book\'s style. Do NOT include any text or letters in the image. Do NOT include the prompt label or any framing — output only the prompt.';

  let aiResp;
  try {
    aiResp = await callAnthropic(system, userPrompt, 400);
  } catch (e) {
    return json(502, { error: 'Could not reach Claude: ' + e.message });
  }
  let suggested = String(aiResp?.content?.[0]?.text || '').trim();
  // Strip wrapping quotes if Claude added them
  suggested = suggested.replace(/^"+/, '').replace(/"+$/, '').trim();
  if (!suggested) return json(502, { error: 'Claude returned an empty prompt' });

  // Persist alongside the page text
  await supabase
    .from('story_world_pages')
    .update({
      page_text:        pageText,
      suggested_prompt: suggested,
      updated_at:       new Date().toISOString(),
    })
    .eq('id', page_id)
    .eq('user_id', user.id);

  // Log usage (non-fatal)
  try {
    const inTok  = aiResp?.usage?.input_tokens  || 0;
    const outTok = aiResp?.usage?.output_tokens || 0;
    await supabase.from('anthropic_usage').insert({
      user_id: user.id, module: 'story_world', action_type: 'suggest_prompt',
      model: 'claude-sonnet-4-6',
      prompt_tokens: inTok, completion_tokens: outTok,
      total_tokens: inTok + outTok,
      cost_usd: (inTok / 1000) * 0.003 + (outTok / 1000) * 0.015,
    });
  } catch (_) {}

  return json(200, { suggested_prompt: suggested });
};
