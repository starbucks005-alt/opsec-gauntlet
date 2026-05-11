// netlify/functions/story-world-update-page.js
// Multi-purpose page mutator: save page text, add a new page, or remove a page.
// POST body forms:
//   { page_id, page_text }                 → save text
//   { book_id, action: 'add' }             → append a new blank page
//   { page_id, action: 'remove' }          → delete a page (and reflow page_order)
// Returns: { page } (for save and add); { ok: true } (for remove)

const { createClient } = require('@supabase/supabase-js');

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

  const action = body.action;

  // ── ADD: append a new blank page to a book ─────────────────────────────────
  if (action === 'add') {
    const bookId = body.book_id;
    if (!bookId) return json(400, { error: 'book_id required for add' });

    const { data: book, error: bookErr } = await supabase
      .from('story_worlds')
      .select('id, page_count')
      .eq('id', bookId)
      .eq('user_id', user.id)
      .single();
    if (bookErr || !book) return json(404, { error: 'Book not found' });

    const newOrder = (book.page_count || 0) + 1;
    const { data: page, error: insErr } = await supabase
      .from('story_world_pages')
      .insert({ book_id: bookId, user_id: user.id, page_order: newOrder, page_text: '' })
      .select()
      .single();
    if (insErr) return json(500, { error: 'Could not add page: ' + insErr.message });

    await supabase.from('story_worlds').update({ page_count: newOrder, updated_at: new Date().toISOString() }).eq('id', bookId);
    return json(200, { page });
  }

  // ── REMOVE: delete a page and shift later pages down by one ────────────────
  if (action === 'remove') {
    const pageId = body.page_id;
    if (!pageId) return json(400, { error: 'page_id required for remove' });

    const { data: page, error: getErr } = await supabase
      .from('story_world_pages')
      .select('id, book_id, page_order, storage_path')
      .eq('id', pageId)
      .eq('user_id', user.id)
      .single();
    if (getErr || !page) return json(404, { error: 'Page not found' });

    // Best-effort cleanup of any uploaded/generated art
    if (page.storage_path) {
      try { await supabase.storage.from(BUCKET).remove([page.storage_path]); } catch (_) {}
    }

    const { error: delErr } = await supabase
      .from('story_world_pages')
      .delete()
      .eq('id', pageId);
    if (delErr) return json(500, { error: 'Could not remove page: ' + delErr.message });

    // Reflow page_order for everything after the removed page
    const { data: later, error: laterErr } = await supabase
      .from('story_world_pages')
      .select('id, page_order')
      .eq('book_id', page.book_id)
      .gt('page_order', page.page_order)
      .order('page_order', { ascending: true });
    if (!laterErr && later && later.length) {
      for (const row of later) {
        await supabase
          .from('story_world_pages')
          .update({ page_order: row.page_order - 1 })
          .eq('id', row.id);
      }
    }

    // Update book.page_count
    const { count } = await supabase
      .from('story_world_pages')
      .select('id', { count: 'exact', head: true })
      .eq('book_id', page.book_id);
    await supabase.from('story_worlds').update({ page_count: count || 0, updated_at: new Date().toISOString() }).eq('id', page.book_id);

    return json(200, { ok: true });
  }

  // ── SAVE: update page_text on a page ──────────────────────────────────────
  const pageId = body.page_id;
  if (!pageId) return json(400, { error: 'page_id required' });
  const pageText = String(body.page_text == null ? '' : body.page_text);

  const { data: page, error: updErr } = await supabase
    .from('story_world_pages')
    .update({ page_text: pageText, updated_at: new Date().toISOString() })
    .eq('id', pageId)
    .eq('user_id', user.id)
    .select()
    .single();
  if (updErr || !page) return json(404, { error: 'Page not found' });

  return json(200, { page });
};
