// netlify/functions/story-world-generate-image.js
// Generates a page illustration with gpt-image-1, mode-aware, and saves it
// to Supabase Storage + the story_world_pages row.
// POST body: { page_id, page_text?, prompt_override? }
// Returns: { page }

const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'story-worlds';

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

function callOpenAIImages(prompt, size, quality) {
  const apiKey = process.env.OPENAI_GP_ImageGen_Key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error('OpenAI API key not configured'));
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

// Multipart helper for /v1/images/edits with multiple reference images.
function buildMultipart(parts) {
  const boundary = '----GPStoryWorldGen' + crypto.randomBytes(8).toString('hex');
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

function callOpenAIEditMulti(prompt, imageBuffers, size, quality) {
  const apiKey = process.env.OPENAI_GP_ImageGen_Key || process.env.OPENAI_API_KEY;
  if (!apiKey) return Promise.reject(new Error('OpenAI API key not configured'));

  const parts = [
    { name: 'model',   data: 'gpt-image-1' },
    { name: 'prompt',  data: prompt },
    { name: 'size',    data: size || '1024x1024' },
    { name: 'quality', data: quality || 'medium' },
    { name: 'n',       data: '1' },
  ];
  // gpt-image-1 image-edits requires array syntax 'image[]' for multiple references.
  for (let i = 0; i < imageBuffers.length; i++) {
    parts.push({ name: 'image[]', filename: 'ref' + i + '.png', contentType: 'image/png', data: imageBuffers[i] });
  }
  const { boundary, body } = buildMultipart(parts);

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

async function loadCastReferences(bookId, userId) {
  const { data: cast, error } = await supabase
    .from('story_world_cast')
    .select('id, name, description, reference_storage_path')
    .eq('book_id', bookId)
    .eq('user_id', userId)
    .order('display_order', { ascending: true });
  if (error || !cast || !cast.length) return [];
  // Download bytes for each reference
  const withBytes = await Promise.all(cast.map(async (c) => {
    if (!c.reference_storage_path) return null;
    try {
      const { data, error } = await supabase.storage.from(BUCKET).download(c.reference_storage_path);
      if (error || !data) return null;
      const buf = Buffer.from(await data.arrayBuffer());
      return { ...c, bytes: buf };
    } catch (_) { return null; }
  }));
  return withBytes.filter(Boolean);
}

const MODE_SUFFIX = {
  story:    '',
  picture:  ' Single clear focal subject, generous negative space, picture-book composition.',
  wordless: ' The image must read on its own without any caption — clear action and body language.',
  comic:    ' Comic exaggeration, expressive faces, slightly cartoony proportions, playful staging.',
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

  const { page_id, prompt_override, page_text } = body;
  if (!page_id) return json(400, { error: 'page_id is required' });

  // Persist any updated page_text first so the row stays in sync
  if (typeof page_text === 'string') {
    await supabase
      .from('story_world_pages')
      .update({ page_text, updated_at: new Date().toISOString() })
      .eq('id', page_id)
      .eq('user_id', user.id);
  }

  const { data: page, error: pageErr } = await supabase
    .from('story_world_pages')
    .select('*, book:story_worlds(*)')
    .eq('id', page_id)
    .eq('user_id', user.id)
    .single();
  if (pageErr || !page) return json(404, { error: 'Page not found' });

  const book = page.book || {};
  const mode = book.mode || 'story';
  const style = book.style || '';
  const suffix = MODE_SUFFIX[mode] || '';

  // Build the prompt
  let promptUsed = (prompt_override && String(prompt_override).trim()) ||
                   page.suggested_prompt ||
                   ('A scene from a story: ' + (page.page_text || '').slice(0, 500));
  promptUsed = String(promptUsed).slice(0, 4000);

  if (style && !promptUsed.toLowerCase().includes(style.toLowerCase())) {
    promptUsed += '. Style: ' + style + '.';
  }
  if (suffix && !promptUsed.toLowerCase().includes(suffix.trim().toLowerCase().slice(0, 20))) {
    promptUsed += suffix;
  }
  if (!/no text|no letters/i.test(promptUsed)) {
    promptUsed += ' No text, no letters, no words anywhere in the image.';
  }

  // If this book has a cast, route through gpt-image-1's image-edits endpoint
  // with the cast reference images attached so faces stay consistent across pages.
  let imgResp;
  let usedCast = false;
  try {
    const cast = await loadCastReferences(book.id, user.id);
    if (cast.length > 0) {
      usedCast = true;
      const castIntro = cast.map((c, i) => {
        const labelPart = '"' + c.name + '"';
        const descPart = c.description ? ' (' + String(c.description).slice(0, 120) + ')' : '';
        return 'Reference image ' + (i + 1) + ' is ' + labelPart + descPart + '.';
      }).join(' ');
      const editPrompt =
        'Illustrate this scene: ' + promptUsed + '\n\n' +
        'Characters appearing in this scene MUST match the provided reference images exactly. ' + castIntro + ' ' +
        'Preserve each character\'s face, hair, age, body type, and clothing details from their reference. ' +
        'Render the new scene in the same illustration style as the references. No text, no letters anywhere.';
      imgResp = await callOpenAIEditMulti(
        editPrompt.slice(0, 4000),
        cast.map(c => c.bytes),
        '1024x1024',
        'medium'
      );
    } else {
      imgResp = await callOpenAIImages(promptUsed, '1024x1024', 'medium');
    }
  } catch (e) {
    return json(502, { error: 'Image generation failed: ' + e.message });
  }

  const item = imgResp?.data?.[0];
  let imageBuf;
  try {
    if (item?.b64_json) {
      imageBuf = Buffer.from(item.b64_json, 'base64');
    } else if (item?.url) {
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

  // Clean up any prior storage object for this page
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
      prompt_used:   promptUsed,
      image_url:     imageUrl,
      storage_path:  storagePath,
      user_uploaded: false,
      updated_at:    new Date().toISOString(),
    })
    .eq('id', page.id)
    .select()
    .single();
  if (updErr) return json(500, { error: 'Could not save page: ' + updErr.message });

  return json(200, { page: updated });
};
