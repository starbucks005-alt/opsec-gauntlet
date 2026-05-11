// netlify/functions/generate-character-portrait.js
// Greylander Press — generates a single character portrait via OpenAI Images,
// stores it in Supabase Storage, returns image URL + the EXACT prompt used.
//
// POST body: { character_id, prompt_override?, size? }
// Returns: { portrait: { id, image_url, prompt_used, locked, ... } }

const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'character-portraits';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function callOpenAIImages(prompt, size, quality) {
  // Accept either the GP-specific name or the standard OPENAI_API_KEY name
  const apiKey = process.env.OPENAI_GP_ImageGen_Key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error('OpenAI API key not configured on server. Add OPENAI_GP_ImageGen_Key in Netlify → Site settings → Environment variables.'));
  const payload = JSON.stringify({
    model: 'gpt-image-1',
    prompt,
    size: size || '1024x1024',
    quality: quality || 'medium',
    n: 1,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message || 'OpenAI image error'));
          else resolve(p);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

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

  const { character_id, prompt_override, size, book_style } = body;
  if (!character_id) return json(400, { error: 'character_id is required' });

  // Fetch the character row (RLS scopes to user)
  const { data: character, error: charErr } = await supabase
    .from('book_characters')
    .select('*')
    .eq('id', character_id)
    .eq('user_id', user.id)
    .single();
  if (charErr || !character) return json(404, { error: 'Character not found' });

  // Resolve the style for THIS generation. If the client sent a new style that
  // differs from the one baked in at extraction time, treat that as authoritative
  // and build a fresh prompt from the description — the original suggested_prompt
  // has the old style baked into the wording and would override the new one.
  const requestedStyle = (book_style && String(book_style).trim()) || character.book_style || '';
  const styleChanged = requestedStyle && requestedStyle !== (character.book_style || '');

  let promptUsed;
  if (prompt_override && String(prompt_override).trim()) {
    promptUsed = String(prompt_override).trim();
  } else if (styleChanged) {
    promptUsed = 'Portrait of: ' + character.character_description;
  } else {
    promptUsed = character.suggested_prompt || ('Portrait of: ' + character.character_description);
  }
  promptUsed = String(promptUsed).slice(0, 4000);

  // Style suffix only if not already mentioned
  if (requestedStyle && !promptUsed.toLowerCase().includes(requestedStyle.toLowerCase())) {
    promptUsed += '. Style: ' + requestedStyle + '.';
  }

  // Persist the new style so subsequent regens stay aligned across the cast
  if (styleChanged) {
    await supabase.from('book_characters').update({ book_style: requestedStyle }).eq('id', character.id);
  }
  // No-text guard — character portraits should never have lettering
  if (!/no text|no letters/i.test(promptUsed)) {
    promptUsed += ' No text, no letters, no words anywhere in the image.';
  }

  // Generate image
  let imgResp;
  try {
    imgResp = await callOpenAIImages(promptUsed, size || '1024x1024', 'medium');
  } catch (e) {
    return json(502, { error: 'Image generation failed: ' + e.message });
  }

  const item = imgResp?.data?.[0];
  let imageBuf;
  try {
    if (item?.b64_json) {
      imageBuf = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
      // Older API path: download the URL into a buffer
      imageBuf = await new Promise((resolve, reject) => {
        https.get(item.url, r => {
          if (r.statusCode !== 200) return reject(new Error('Image download HTTP ' + r.statusCode));
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
          r.on('error', reject);
        }).on('error', reject);
      });
    } else {
      throw new Error('OpenAI returned no image payload');
    }
  } catch (e) {
    return json(502, { error: 'Could not retrieve generated image: ' + e.message });
  }

  // Upload to Supabase Storage. Path: <user_id>/<character_id>/<random>.png
  const fileName = crypto.randomBytes(8).toString('hex') + '.png';
  const storagePath = user.id + '/' + character.id + '/' + fileName;
  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, imageBuf, { contentType: 'image/png', upsert: false });
  if (uploadErr) {
    console.error('[generate-character-portrait] storage upload failed:', uploadErr.message);
    return json(500, { error: 'Storage upload failed: ' + uploadErr.message });
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const imageUrl = pub?.publicUrl;
  if (!imageUrl) return json(500, { error: 'Could not derive public URL for portrait' });

  // Save row
  const { data: portrait, error: insErr } = await supabase
    .from('character_portraits')
    .insert({
      user_id:      user.id,
      character_id: character.id,
      prompt_used:  promptUsed,
      image_url:    imageUrl,
      storage_path: storagePath,
      model:        'gpt-image-1',
      size:         size || '1024x1024',
      style:        character.book_style || null,
      locked:       false,
    })
    .select()
    .single();
  if (insErr) {
    return json(500, { error: 'Could not save portrait row: ' + insErr.message });
  }

  return json(200, { portrait });
};
