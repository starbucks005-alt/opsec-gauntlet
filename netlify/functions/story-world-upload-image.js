// netlify/functions/story-world-upload-image.js
// Saves a user-uploaded image (drawing, photo) to a Story World page.
// POST body: { page_id, content_type, content_base64 }
// Returns: { page }

const { createClient } = require('@supabase/supabase-js');
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

  const { page_id, content_type, content_base64 } = body;
  if (!page_id || !content_type || !content_base64) {
    return json(400, { error: 'page_id, content_type, content_base64 are required' });
  }
  if (!ALLOWED.includes(content_type)) {
    return json(415, { error: 'Use a PNG, JPG, or WebP file' });
  }

  let buf;
  try { buf = Buffer.from(content_base64, 'base64'); }
  catch { return json(400, { error: 'Invalid base64' }); }
  if (!buf.length) return json(400, { error: 'Empty file' });
  if (buf.length > MAX_BYTES) return json(413, { error: 'Image exceeds 8 MB' });

  const { data: page, error: pageErr } = await supabase
    .from('story_world_pages')
    .select('id, book_id, storage_path')
    .eq('id', page_id)
    .eq('user_id', user.id)
    .single();
  if (pageErr || !page) return json(404, { error: 'Page not found' });

  // Clean up prior art
  if (page.storage_path) {
    try { await supabase.storage.from(BUCKET).remove([page.storage_path]); } catch (_) {}
  }

  const ext = EXTS[content_type] || 'png';
  const fileName = crypto.randomBytes(8).toString('hex') + '.' + ext;
  const storagePath = user.id + '/' + page.book_id + '/' + page.id + '/' + fileName;
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buf, { contentType: content_type, upsert: false });
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
      prompt_used:   null,
      updated_at:    new Date().toISOString(),
    })
    .eq('id', page.id)
    .select()
    .single();
  if (updErr) return json(500, { error: 'Could not save page: ' + updErr.message });

  return json(200, { page: updated });
};
