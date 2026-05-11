// netlify/functions/story-world-restyle-image.js
// Takes a user-uploaded photo and restyles it to match the book's art style/palette
// using gpt-image-1's image-edit endpoint. Saves the restyled image to the page.
// POST body: { page_id, content_type, content_base64, extra_prompt? }
// Returns: { page }

const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'story-worlds';
const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp'];

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

// Build a multipart/form-data body for the OpenAI image edits endpoint.
// We avoid bringing in `form-data`/`node-fetch` and just construct the bytes
// directly so the function bundle stays small.
function buildMultipart(parts) {
  const boundary = '----GPStoryWorld' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from('--' + boundary + CRLF));
    if (part.filename) {
      chunks.push(Buffer.from(
        'Content-Disposition: form-data; name="' + part.name + '"; filename="' + part.filename + '"' + CRLF +
        'Content-Type: ' + (part.contentType || 'application/octet-stream') + CRLF + CRLF
      ));
      chunks.push(part.data);
      chunks.push(Buffer.from(CRLF));
    } else {
      chunks.push(Buffer.from(
        'Content-Disposition: form-data; name="' + part.name + '"' + CRLF + CRLF +
        String(part.data) + CRLF
      ));
    }
  }
  chunks.push(Buffer.from('--' + boundary + '--' + CRLF));
  return { boundary, body: Buffer.concat(chunks) };
}

function callOpenAIEdit(imageBytes, prompt, size, quality) {
  const apiKey = process.env.OPENAI_GP_ImageGen_Key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error('OpenAI API key not configured'));

  const { boundary, body } = buildMultipart([
    { name: 'model',   data: 'gpt-image-1' },
    { name: 'prompt',  data: prompt },
    { name: 'size',    data: size || '1024x1024' },
    { name: 'quality', data: quality || 'medium' },
    { name: 'n',       data: '1' },
    { name: 'image', filename: 'input.png', contentType: 'image/png', data: imageBytes },
  ]);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/edits',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) reject(new Error(p.error.message || 'OpenAI image-edit error'));
          else resolve(p);
        } catch (e) { reject(new Error('OpenAI returned non-JSON: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
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

  const { page_id, content_type, content_base64, extra_prompt } = body;
  if (!page_id || !content_type || !content_base64) {
    return json(400, { error: 'page_id, content_type, content_base64 are required' });
  }
  if (!ALLOWED.includes(content_type)) {
    return json(415, { error: 'Use a PNG, JPG, or WebP file' });
  }

  let inputBuf;
  try { inputBuf = Buffer.from(content_base64, 'base64'); }
  catch { return json(400, { error: 'Invalid base64' }); }
  if (!inputBuf.length) return json(400, { error: 'Empty file' });
  if (inputBuf.length > MAX_BYTES) return json(413, { error: 'Image exceeds 8 MB' });

  const { data: page, error: pageErr } = await supabase
    .from('story_world_pages')
    .select('*, book:story_worlds(*)')
    .eq('id', page_id)
    .eq('user_id', user.id)
    .single();
  if (pageErr || !page) return json(404, { error: 'Page not found' });

  const book = page.book || {};
  const style = book.style || 'illustration';
  const extra = (extra_prompt && String(extra_prompt).trim()) || '';
  const pageHint = (page.page_text && page.page_text.trim()) ? (' Scene context: ' + page.page_text.trim().slice(0, 400)) : '';

  const prompt =
    'Restyle this photograph as a ' + style + ' illustration. ' +
    'Match the color palette, lighting, and overall mood of the style exactly so the result feels like it belongs in the same illustrated book. ' +
    'Preserve each subject\'s likeness — face, hair, age, body type, clothing colors — while transforming the rendering style. ' +
    'Keep the same subjects, the same number of people or animals, and the same general composition. ' +
    'No text, no letters, no words anywhere in the image.' +
    (extra ? ' ' + extra : '') +
    pageHint;

  let imgResp;
  try {
    imgResp = await callOpenAIEdit(inputBuf, prompt.slice(0, 4000), '1024x1024', 'medium');
  } catch (e) {
    return json(502, { error: 'Restyle failed: ' + e.message });
  }

  const item = imgResp?.data?.[0];
  let imageBuf;
  if (item?.b64_json) {
    imageBuf = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    try {
      imageBuf = await new Promise((resolve, reject) => {
        https.get(item.url, r => {
          if (r.statusCode !== 200) return reject(new Error('Image download HTTP ' + r.statusCode));
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
          r.on('error', reject);
        }).on('error', reject);
      });
    } catch (e) {
      return json(502, { error: 'Could not retrieve restyled image: ' + e.message });
    }
  } else {
    return json(502, { error: 'OpenAI returned no image' });
  }

  // Replace any prior page art
  if (page.storage_path) {
    try { await supabase.storage.from(BUCKET).remove([page.storage_path]); } catch (_) {}
  }

  const fileName = crypto.randomBytes(8).toString('hex') + '.png';
  const storagePath = user.id + '/' + book.id + '/' + page.id + '/' + fileName;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, imageBuf, { contentType: 'image/png', upsert: false });
  if (upErr) return json(500, { error: 'Storage upload failed: ' + upErr.message });

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const imageUrl = pub?.publicUrl;
  if (!imageUrl) return json(500, { error: 'Could not derive public URL' });

  const { data: updated, error: updErr } = await supabase
    .from('story_world_pages')
    .update({
      image_url:     imageUrl,
      storage_path:  storagePath,
      user_uploaded: true,
      prompt_used:   prompt,
      updated_at:    new Date().toISOString(),
    })
    .eq('id', page.id)
    .select()
    .single();
  if (updErr) return json(500, { error: 'Could not save page: ' + updErr.message });

  return json(200, { page: updated });
};
