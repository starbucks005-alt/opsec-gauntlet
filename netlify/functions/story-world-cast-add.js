// netlify/functions/story-world-cast-add.js
// Adds a cast member to a Story World: stores the original photo, then asks
// gpt-image-1 to restyle it into a clean character reference matching the book's
// art style. The reference image is what later page-generations pass back to
// gpt-image-1 so this person stays consistent across every page.
//
// POST body: { book_id, name, content_type, content_base64, description? }
// Returns: { cast }

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
const EXTS    = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  };
}

// Multipart helper — same as the per-page restyle function. Keeps the bundle small.
function buildMultipart(parts) {
  const boundary = '----GPStoryWorldCast' + crypto.randomBytes(8).toString('hex');
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

  const bookId = body.book_id;
  const name   = String(body.name || '').trim();
  const description = String(body.description || '').trim();
  const contentType = body.content_type;
  const contentB64  = body.content_base64;

  if (!bookId)        return json(400, { error: 'book_id is required' });
  if (!name)          return json(400, { error: 'name is required' });
  if (!contentType || !contentB64) return json(400, { error: 'photo (content_type + content_base64) is required' });
  if (!ALLOWED.includes(contentType)) return json(415, { error: 'Use a PNG, JPG, or WebP file' });

  let inputBuf;
  try { inputBuf = Buffer.from(contentB64, 'base64'); }
  catch { return json(400, { error: 'Invalid base64' }); }
  if (!inputBuf.length) return json(400, { error: 'Empty file' });
  if (inputBuf.length > MAX_BYTES) return json(413, { error: 'Photo exceeds 8 MB' });

  // Confirm the book belongs to this user
  const { data: book, error: bookErr } = await supabase
    .from('story_worlds')
    .select('id, style, user_id')
    .eq('id', bookId)
    .eq('user_id', user.id)
    .single();
  if (bookErr || !book) return json(404, { error: 'Book not found' });

  // Save the original photo
  const ext = EXTS[contentType] || 'png';
  const stamp = crypto.randomBytes(6).toString('hex');
  const sourcePath = user.id + '/' + book.id + '/_cast/' + stamp + '_source.' + ext;
  const { error: sourceErr } = await supabase.storage
    .from(BUCKET)
    .upload(sourcePath, inputBuf, { contentType, upsert: false });
  if (sourceErr) return json(500, { error: 'Could not save photo: ' + sourceErr.message });

  // Restyle the photo into a clean character reference in the book's art style
  const style = book.style || 'illustration';
  const descPart = description ? (' Notes about the subject: ' + description.slice(0, 200) + '.') : '';
  const prompt =
    'Restyle this photograph as a clean character reference for an illustrated book. ' +
    'Style: ' + style + '. Match the color palette, line work, and rendering of that style exactly. ' +
    'Preserve the subject\'s likeness — face, hair color and length, age, body type, clothing colors — while transforming the rendering. ' +
    'Show the same subject from roughly the chest up against a simple plain background, facing the viewer. ' +
    'Single subject only. No text, no letters, no words, no logos.' +
    descPart;

  let restyled;
  try {
    restyled = await callOpenAIEdit(inputBuf, prompt.slice(0, 4000), '1024x1024', 'medium');
  } catch (e) {
    // Fall back to using the source as the reference so the cast member exists
    console.error('[story-world-cast-add] restyle failed:', e.message);
  }

  let referenceBytes = null;
  if (restyled?.data?.[0]?.b64_json) {
    referenceBytes = Buffer.from(restyled.data[0].b64_json, 'base64');
  } else if (restyled?.data?.[0]?.url) {
    try {
      referenceBytes = await new Promise((resolve, reject) => {
        https.get(restyled.data[0].url, r => {
          if (r.statusCode !== 200) return reject(new Error('Image download HTTP ' + r.statusCode));
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
          r.on('error', reject);
        }).on('error', reject);
      });
    } catch (_) {}
  }

  let referencePath = null;
  let referenceUrl  = null;
  if (referenceBytes) {
    referencePath = user.id + '/' + book.id + '/_cast/' + stamp + '_reference.png';
    const { error: refErr } = await supabase.storage
      .from(BUCKET)
      .upload(referencePath, referenceBytes, { contentType: 'image/png', upsert: false });
    if (!refErr) {
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(referencePath);
      referenceUrl = pub?.publicUrl || null;
    } else {
      referencePath = null;
    }
  }
  // If restyle failed, fall back to the source as the reference
  if (!referencePath) {
    referencePath = sourcePath;
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(sourcePath);
    referenceUrl = pub?.publicUrl || null;
  }

  // Determine display_order = current count
  const { count } = await supabase
    .from('story_world_cast')
    .select('id', { count: 'exact', head: true })
    .eq('book_id', book.id);

  const { data: cast, error: insErr } = await supabase
    .from('story_world_cast')
    .insert({
      book_id:                book.id,
      user_id:                user.id,
      name,
      description:            description || null,
      source_storage_path:    sourcePath,
      reference_storage_path: referencePath,
      reference_url:          referenceUrl,
      display_order:          count || 0,
    })
    .select()
    .single();
  if (insErr) {
    return json(500, { error: 'Could not save cast member: ' + insErr.message });
  }

  return json(200, { cast });
};
