// netlify/functions/story-world-create.js
// Creates a new Story World (book) + N blank pages.
// POST body: { title, style, mode, page_count }
// Returns: { book, pages }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const VALID_MODES = ['story', 'picture', 'wordless', 'comic'];
const VALID_PAGE_SIZES = ['letter', 'a4', 'square', 'trade'];
const VALID_FONTS      = ['times', 'helvetica', 'courier', 'caveat'];
const VALID_TEXT_SIZES = ['small', 'medium', 'large', 'xl'];
const VALID_ALIGNS     = ['left', 'center', 'right'];

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

  const title = String(body.title || '').trim();
  const style = String(body.style || '').trim();
  const mode  = VALID_MODES.includes(body.mode) ? body.mode : 'story';
  const pageSize  = VALID_PAGE_SIZES.includes(body.page_size) ? body.page_size : 'letter';
  const textFont  = VALID_FONTS.includes(body.text_font)      ? body.text_font  : 'times';
  const textSize  = VALID_TEXT_SIZES.includes(body.text_size) ? body.text_size  : 'medium';
  const textAlign = VALID_ALIGNS.includes(body.text_align)    ? body.text_align : 'center';
  const pageCount = Math.max(1, Math.min(40, parseInt(body.page_count, 10) || 6));

  if (!title) return json(400, { error: 'Title is required' });
  if (!style) return json(400, { error: 'Style is required' });

  // Insert the book
  const { data: book, error: bookErr } = await supabase
    .from('story_worlds')
    .insert({
      user_id: user.id, title, style, mode, page_count: pageCount,
      page_size: pageSize, text_font: textFont, text_size: textSize, text_align: textAlign,
    })
    .select()
    .single();
  if (bookErr) return json(500, { error: 'Could not create book: ' + bookErr.message });

  // Insert N blank pages
  const pageRows = Array.from({ length: pageCount }, (_, i) => ({
    book_id:    book.id,
    user_id:    user.id,
    page_order: i + 1,
    page_text:  '',
  }));
  const { data: pages, error: pagesErr } = await supabase
    .from('story_world_pages')
    .insert(pageRows)
    .select();
  if (pagesErr) {
    // Roll back book
    await supabase.from('story_worlds').delete().eq('id', book.id);
    return json(500, { error: 'Could not create pages: ' + pagesErr.message });
  }

  return json(200, {
    book,
    pages: (pages || []).sort((a, b) => a.page_order - b.page_order),
  });
};
